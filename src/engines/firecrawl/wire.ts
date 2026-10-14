/**
 * Pure wire-level helpers for the Firecrawl v2 scrape engine: request building,
 * success narrowing/mapping, upstream-error extraction, and the failure
 * classification consumed by the circuit breaker (#7) and the fetch pipeline
 * (#9). No HTTP lives here, so every function is directly unit-testable.
 * @module engines/firecrawl/wire
 */
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { MAX_UPSTREAM_ERROR_CHARS } from '../../limits.js';

/** Firecrawl v2 scrape endpoint (DESIGN.md). */
export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';

/** Anonymous credits apply only to the official Search and Scrape endpoints. */
export function isFirecrawlKeylessEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.href === 'https://api.firecrawl.dev/v2/search' || url.href === FIRECRAWL_SCRAPE_URL;
  } catch { return false; }
}

/** Default credential reference for the Firecrawl engine (the config default). */
export const FIRECRAWL_DEFAULT_API_KEY_ENV = 'FIRECRAWL_API_KEY';

/** Single-engine fetch deadline (DESIGN.md: per-engine limit of 45 s). */
export const FIRECRAWL_SCRAPE_TIMEOUT_MS = 45_000;

/**
 * Statuses the pipeline may retry. The engine itself never retries — it only
 * classifies (DESIGN.md: whether to retry is the upper layer's call).
 */
export const FIRECRAWL_RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** The seam/WebError codes this engine can raise from an upstream response. */
export type FirecrawlWebErrorCode = 'WEB_INVALID_URL' | 'WEB_BLOCKED_URL' | 'WEB_PROVIDER_ERROR';

/**
 * Circuit-breaker signal (#7): `insufficient-credits` disables the engine for
 * the rest of the day; `rate-limit` carries the upstream `Retry-After` delay
 * when one was sent.
 */
export type FirecrawlBreakerSignal =
  | { readonly kind: 'insufficient-credits' }
  | { readonly kind: 'rate-limit'; readonly retryAfterMs?: number };

/**
 * Machine-routable failure classification for one upstream response, exported
 * for the breaker (#7) and pipeline (#9). `breaker` means quota/rate-limit —
 * trip the breaker with `signal`; `retryable` marks the fixed status set;
 * `fatal` covers everything else (an invalid or blocked URL does not improve
 * on replay).
 */
export type FirecrawlFailure =
  | { readonly class: 'breaker'; readonly status: number; readonly signal: FirecrawlBreakerSignal }
  | { readonly class: 'retryable'; readonly status: number; readonly retryAfterMs?: number }
  | { readonly class: 'fatal'; readonly status: number };

/** Firecrawl v2 scrape request body. */
export interface FirecrawlScrapeRequest {
  readonly url: string;
  /** Markdown only — the seam renders text, not HTML. */
  readonly formats: readonly string[];
  /** Strip nav/footer boilerplate; the pipeline ranks on main content. */
  readonly onlyMainContent: true;
  /** `0` disables Firecrawl's cache (a cached hit still bills and may be stale). */
  readonly maxAge: 0;
  /** Upstream-side deadline, kept in sync with the engine's own budget. */
  readonly timeout: number;
}

/** The narrowed success document: markdown plus the target site's status. */
export interface FirecrawlScrapeSuccess {
  readonly markdown: string;
  /** The target site's HTTP status as reported by Firecrawl; `200` when absent. */
  readonly statusCode: number;
}

/**
 * Build the wire request: markdown format, main content only, caching off
 * (`maxAge: 0` — a cache hit is billed like a scrape and may return stale
 * content), and the engine's own timeout as the upstream deadline.
 */
export function buildFirecrawlScrapeRequest(
  url: string,
  timeoutMs: number = FIRECRAWL_SCRAPE_TIMEOUT_MS,
): FirecrawlScrapeRequest {
  return {
    url,
    formats: ['markdown'],
    onlyMainContent: true,
    maxAge: 0,
    timeout: timeoutMs,
  };
}

/** Membership in the fixed retryable set {408, 429, 500, 502, 503, 504}. */
export function isRetryableFirecrawlStatus(status: number): boolean {
  return FIRECRAWL_RETRYABLE_STATUS.has(status);
}

/**
 * Classify one upstream response for the breaker and the pipeline. Status
 * first: `402` is insufficient credits, `429` is rate limiting — both trip
 * the breaker. An upstream `code` naming either condition wins regardless of
 * status, because Firecrawl also delivers failures in a `200`
 * `{success:false, …}` envelope. Remaining members of the retryable set
 * classify `retryable`; everything else is `fatal`.
 */
export function classifyFirecrawlHttpFailure(
  status: number,
  code?: string,
  retryAfterMs?: number,
): FirecrawlFailure {
  const normalizedCode = normalizeErrorCode(code);
  if (status === 402 || normalizedCode.includes('insufficientcredit')) {
    return { class: 'breaker', status, signal: { kind: 'insufficient-credits' } };
  }
  if (status === 429 || normalizedCode.includes('ratelimit')) {
    return {
      class: 'breaker',
      status,
      signal: { kind: 'rate-limit', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    };
  }
  if (isRetryableFirecrawlStatus(status)) {
    return { class: 'retryable', status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  return { class: 'fatal', status };
}

/**
 * Map an upstream HTTP status onto the seam's shared error codes: `400` is an
 * invalid URL, `403`/`404` are blocked/unreachable targets, everything else is
 * a provider failure. (`403`/`404` from the *target site* never reach this
 * function — Firecrawl reports those as a success document with
 * `metadata.statusCode`, which maps to a result, not an error.)
 */
export function firecrawlWebErrorCode(status: number): FirecrawlWebErrorCode {
  if (status === 400) return 'WEB_INVALID_URL';
  if (status === 403 || status === 404) return 'WEB_BLOCKED_URL';
  return 'WEB_PROVIDER_ERROR';
}

/**
 * Parse a `Retry-After` header value into milliseconds: digits are seconds,
 * anything else is an HTTP-date resolved against `now`. A date already in the
 * past clamps to `0`; absent/garbage values yield `undefined`.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const epochMs = Date.parse(trimmed);
  if (Number.isNaN(epochMs)) return undefined;
  return Math.max(0, epochMs - now);
}

/**
 * Narrow a success envelope into the scraped document. Returns `undefined`
 * unless `success === true` and `data.markdown` is a string (empty is a valid
 * document). `metadata.statusCode` passes through verbatim so a non-200
 * *target* still resolves as a fetched result; a missing or non-numeric value
 * defaults to `200` rather than inventing a failure.
 */
export function readFirecrawlScrapeSuccess(payload: unknown): FirecrawlScrapeSuccess | undefined {
  const record = readRecord(payload);
  if (record === undefined || record.success !== true) return undefined;
  const data = readRecord(record.data);
  if (data === undefined) return undefined;
  const markdown = data.markdown;
  if (typeof markdown !== 'string') return undefined;
  const statusCode = readRecord(data.metadata)?.statusCode;
  return {
    markdown,
    statusCode: typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : 200,
  };
}

/**
 * Map a narrowed document onto the seam's fetch result: the request URL is the
 * result URL (the pipeline asked for this URL), markdown is text, and the
 * engine never truncates (`truncated` stays false; the seam owns body caps).
 */
export function mapFirecrawlScrapeResult(requestUrl: string, doc: FirecrawlScrapeSuccess): WebFetchResult {
  return {
    url: requestUrl,
    statusCode: doc.statusCode,
    body: { kind: 'text', content: doc.markdown },
    truncated: false,
  };
}

/**
 * Extract the upstream failure code from an error body: the top-level `code`
 * (`{success:false, error, code}`) or a nested `error.code`. Unreadable bodies
 * yield `undefined`.
 */
export function extractFirecrawlErrorCode(text: string): string | undefined {
  const record = parseRecord(text);
  if (record === undefined) return undefined;
  return readNonEmptyString(record.code) ?? readNonEmptyString(readRecord(record.error)?.code);
}

/**
 * Extract a bounded `(code …): message` suffix from an error body, keeping the
 * upstream `code` and `error` string (or nested `error.message`) in failure
 * messages. Never throws; unreadable bodies yield `''`.
 */
export function extractFirecrawlErrorDetail(text: string): string {
  const record = parseRecord(text);
  if (record === undefined) return '';
  const code = extractFirecrawlErrorCode(text);
  const message =
    readNonEmptyString(record.error) ?? readNonEmptyString(readRecord(record.error)?.message);
  const codePart = code === undefined ? '' : ` (code ${code})`;
  const messagePart =
    message === undefined ? '' : `: ${truncateToCodePoints(message, MAX_UPSTREAM_ERROR_CHARS)}`;
  return codePart === '' && messagePart === '' ? '' : `${codePart}${messagePart}`;
}

/** Lowercase and strip separators so `insufficient_credits`/`Insufficient Credits` agree. */
function normalizeErrorCode(code: string | undefined): string {
  return typeof code === 'string' ? code.toLowerCase().replace(/[\s_-]+/g, '') : '';
}

/** Parse JSON into a plain-object view, or `undefined` for unreadable/non-object text. */
function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/* Generic narrowing helpers, mirrored from the zhipu wire module on purpose:
 * engine modules stay self-contained (DESIGN.md — a new engine is a new
 * adapter file), so cross-engine imports are avoided. */

/** A plain (non-null, non-array) object view, or `undefined`. */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A trimmed non-empty string, or `undefined` for anything else. */
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Truncate to at most `max` Unicode code points, never splitting a surrogate pair. */
function truncateToCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}
