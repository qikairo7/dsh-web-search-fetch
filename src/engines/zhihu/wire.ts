/**
 * Pure wire-level helpers for the Zhihu engine: request building, response
 * narrowing, URL/snippet cleanup, and quota reading. No HTTP lives here, so
 * every function is directly unit-testable.
 *
 * The narrowing helpers are local copies rather than imports from the Zhipu
 * engine: an engine adapter is self-contained (DESIGN.md — a new engine is a
 * new adapter file), and cross-engine imports would couple two independent
 * adapters.
 * @module engines/zhihu/wire
 */
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import { ZHIHU_COUNT_MAX, ZHIHU_COUNT_MIN, ZHIHU_TIMESTAMP_TOLERANCE_SECONDS } from './limits.js';
import { normalizeZhihuCountMax } from './options.js';
import type {
  ZhihuQuota,
  ZhihuQuotaResponse,
  ZhihuSearchRequest,
  ZhihuSearchResponse,
} from './types.js';

/** A trimmed non-empty string, or `undefined` for anything else. */
export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** A plain (non-null, non-array) object view, or `undefined`. */
export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read an int64 that may arrive as a JSON number or as a decimal string.
 * Anything else (float, non-numeric text, `null`) yields `undefined`.
 */
export function readInt64(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Build the query parameters of one `global_search` call. `Query` is sent
 * verbatim; `Count` is aligned to the seam's `maxResults` and clamped to
 * `countMax` (the documented 1–20 range by default), and is omitted when the
 * request carries no bound (the API then applies its own default of 10).
 * `Filter`/`SearchDB` are never sent: vertical parameters do not exist on the
 * seam and are part of the two-tool interface.
 */
export function buildZhihuSearchRequest(
  query: string,
  maxResults?: number,
  countMax: number = ZHIHU_COUNT_MAX,
): ZhihuSearchRequest {
  return {
    Query: query,
    ...(maxResults === undefined ? {} : { Count: clampZhihuCount(maxResults, countMax) }),
  };
}

/**
 * Clamp `maxResults` into `countMax` as the ceiling and 1 as the floor. The
 * ceiling is an engine option so a deployment can stay below the documented
 * maximum; it can never exceed it (see {@link normalizeZhihuCountMax}).
 */
export function clampZhihuCount(maxResults: number, countMax: number = ZHIHU_COUNT_MAX): number {
  const ceiling = normalizeZhihuCountMax(countMax);
  if (!Number.isFinite(maxResults)) return ZHIHU_COUNT_MIN;
  return Math.min(ceiling, Math.max(ZHIHU_COUNT_MIN, Math.floor(maxResults)));
}

/**
 * Remove every `utm_*` query parameter (Zhihu appends
 * `utm_medium=openapi_platform&utm_source=…` attribution) and leave the rest of
 * the URL — path, fragment, and non-UTM parameters — untouched. A URL that does
 * not parse is returned verbatim rather than dropped or rewritten.
 */
export function stripUtmParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const kept: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams) {
    if (isUtmParam(key)) continue;
    kept.push([key, value]);
  }
  if (kept.length === parsed.searchParams.size) return url;
  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  const rendered = parsed.toString();
  // `URL` keeps a bare trailing `?` when the original had an empty query.
  return parsed.search === '' && rendered.endsWith('?') ? rendered.slice(0, -1) : rendered;
}

/** True for a `utm_*` attribution parameter (case-insensitive, per convention). */
function isUtmParam(key: string): boolean {
  return key.toLowerCase().startsWith('utm_');
}

/**
 * Strip the `<em>`/`</em>` highlight tags Zhihu wraps around matched query
 * terms in `ContentText`. Only those tags are removed — other markup is left
 * exactly as delivered rather than guessed at.
 */
export function stripHighlightTags(text: string): string {
  return text.replace(/<\/?em\s*>/gi, '');
}

/**
 * Convert `EditTime` (int64 Unix seconds) into an ISO-8601 string. Missing,
 * non-integer, non-positive, and out-of-range values yield `undefined` instead
 * of an invented timestamp.
 */
export function formatEditTime(editTime: unknown): string | undefined {
  const seconds = readInt64(editTime);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Business `Code` of an envelope as a number, or `undefined` when absent/unreadable. */
export function readZhihuCode(payload: unknown): number | undefined {
  const code = readRecord(payload)?.Code;
  if (typeof code === 'number') return Number.isFinite(code) ? code : undefined;
  return readInt64(code);
}

/**
 * Map a `global_search` response into seam sources: `Url`→`url` (UTM params
 * stripped), `Title`→`title`, `ContentText`→`snippet` (highlight tags
 * stripped), `EditTime`→`publishedAt` (Unix seconds → ISO 8601). Entries
 * without a usable URL are dropped (a seam source always has one); empty or
 * non-string fields are omitted rather than invented. `truncated` is always
 * `false`: the seam owns the `maxResults` bound.
 */
export function mapZhihuSearchResponse(payload: ZhihuSearchResponse): WebSearchResult {
  const rawItems = readRecord(readRecord(payload)?.Data)?.Items;
  const entries = Array.isArray(rawItems) ? (rawItems as unknown[]) : [];
  const sources: WebSearchSource[] = [];
  for (const item of entries) {
    const record = readRecord(item);
    if (record === undefined) continue;
    const rawUrl = readNonEmptyString(record.Url);
    if (rawUrl === undefined) continue;
    const url = stripUtmParams(rawUrl);
    if (url.length === 0) continue;
    const title = readNonEmptyString(record.Title);
    const rawSnippet = readNonEmptyString(record.ContentText);
    const snippet = rawSnippet === undefined ? undefined : readNonEmptyString(stripHighlightTags(rawSnippet));
    const publishedAt = formatEditTime(record.EditTime);
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return { sources, truncated: false };
}

/**
 * True when a request timestamp is inside the documented ±10 minute window
 * around `nowMs`. The client cannot fix a skewed local clock; this predicate
 * exists so the freshness guarantee the client does provide — a header derived
 * from the current clock on every call — is checkable, including in tests.
 */
export function isTimestampWithinTolerance(
  timestampSeconds: number,
  nowMs: number,
  toleranceSeconds: number = ZHIHU_TIMESTAMP_TOLERANCE_SECONDS,
): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) <= toleranceSeconds;
}

/**
 * Read the `global_search` daily quota out of a quota response: the `Data[]`
 * entry whose `APIID` is `apiId`. Returns `undefined` when the envelope carries
 * no usable entry, so the caller never treats an unreadable body as "no quota
 * left" (fail-open on data, fail-closed only on an explicit `remaining <= 0`).
 */export function mapZhihuQuotaResponse(payload: ZhihuQuotaResponse, apiId: string): ZhihuQuota | undefined {
  const entries = readRecord(payload)?.Data;
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const record = readRecord(entry);
    if (record === undefined) continue;
    if (readNonEmptyString(record.APIID) !== apiId) continue;
    const total = readInt64(record.TotalQuota);
    const used = readInt64(record.TotalUsed);
    const remaining = readInt64(record.RemainingQuota);
    if (total === undefined || used === undefined || remaining === undefined) return undefined;
    return { total, used, remaining };
  }
  return undefined;
}

/**
 * True when a daily quota is exhausted. This is the one place the engine
 * decides "no calls left today"; a missing quota is not exhaustion, so the
 * caller passes `undefined` and gets `false`.
 */
export function isZhihuQuotaExhausted(quota: ZhihuQuota | undefined): boolean {
  return quota !== undefined && quota.remaining <= 0;
}
