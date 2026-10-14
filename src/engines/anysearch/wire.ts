/**
 * Pure wire layer for the AnySearch engine: response narrowing, envelope
 * validation, and mapping into the seam's `WebSearchResult` / `WebFetchResult`
 * vocabulary. No HTTP and no credentials live here, so every function is a
 * plain value-to-value call that a unit test can drive directly.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97 (src/client.ts,
 * src/types.ts, src/provider.ts, src/fetch-provider.ts), MIT.
 * Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch/wire
 */
import type { WebFetchResult, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import { MAX_CANONICAL_CONTENT_CHARS } from './limits.js';
import type {
  AnySearchParamValue, AnySearchDomainSummary, AnySearchDomainsResponse,
  AnySearchDomainCapability, AnySearchSubDomainsResponse, AnySearchSubDomain, AnySearchParamInfo,
} from './types.js';

/** One search request as this engine sends it on the wire. */
export interface AnySearchSearchRequest {
  /** Free-text query, passed through untruncated (no documented length cap). */
  readonly query: string;
  /** Result bound, sent as `max_results` only when the seam supplied one. */
  readonly maxResults?: number;
  readonly tag?: string;
  readonly params?: Record<string, AnySearchParamValue>;
  readonly zone?: 'cn' | 'intl';
  readonly language?: string;
}

/** One extract request as this engine sends it on the wire. */
export interface AnySearchExtractRequest {
  readonly url: string;
}

/** One validated `data.results[]` entry. */
export interface AnySearchResult {
  readonly title: string;
  /** Citeable HTTP(S) URL; absent for structured data with no web source. */
  readonly url?: string;
  readonly snippet?: string;
  readonly content?: string;
}

/** Search metadata, retained for logging and for the seam `truncated` decision. */
export interface AnySearchMetadata {
  readonly totalResults: number;
  readonly searchTimeMs: number;
  /** Valid structured results dropped because they carry no citeable URL. */
  readonly urlLessResults?: number;
  /** Results dropped because a non-empty URL was not absolute HTTP(S). */
  readonly droppedInvalidUrlResults?: number;
}

/** Validated search response. */
export interface AnySearchSearchResponse {
  readonly requestId?: string;
  readonly results: readonly AnySearchResult[];
  readonly metadata: AnySearchMetadata;
}

/** Validated extract response. */
export interface AnySearchExtractResponse {
  readonly requestId?: string;
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

/** Validated envelope payload: the `data` object plus the envelope's request id. */
export interface AnySearchEnvelopeData {
  readonly data: Record<string, unknown>;
  readonly requestId?: string;
}

/**
 * The envelope fields the client inspects before dispatching to a parser.
 * `data` stays `unknown` here on purpose: error envelopes legitimately carry
 * `data: null`, and the client must read `code`/`message` before it can decide
 * whether a payload was expected. {@link envelopeData} validates it.
 */
export interface AnySearchEnvelope {
  readonly code: number;
  readonly message: string;
  readonly requestId?: string;
  /** Stable upstream business error code, when the envelope carries one. */
  readonly errorCode?: string;
  readonly data: unknown;
}

/**
 * Join a base URL with an API path, preserving any base pathname. A base URL
 * that is not HTTP(S) — or not a URL at all — is unusable and yields
 * `undefined`, which the provider layer reports as `available() === false`.
 * Reference: `endpoint()` in src/client.ts.
 */
export function endpoint(baseURL: string, path: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** Whether a string is an absolute `http:`/`https:` URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate one decoded response body as an AnySearch envelope. Throws
 * `TypeError` with the offending path when a field has the wrong shape; the
 * client turns that into a classified failure. `code !== 0` is *not* handled
 * here — the client needs the HTTP status and headers to classify it.
 */
export function readEnvelope(value: unknown): AnySearchEnvelope {
  const envelope = readRecord(value, 'response');
  const requestId = optionalStringField(envelope, 'request_id', 'request_id');
  const code = numberField(envelope, 'code', 'code');
  const message = optionalStringField(envelope, 'message', 'message');
  const errorCode = optionalStringField(envelope, 'error_code', 'error_code');
  return {
    code,
    message: message ?? '',
    ...(requestId === undefined ? {} : { requestId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    data: envelope.data,
  };
}

/**
 * Validate the payload of a *successful* envelope. Only called once
 * `code === 0`, so a missing or non-object `data` here is a genuine contract
 * violation rather than an error envelope's `data: null`.
 */
export function envelopeData(envelope: AnySearchEnvelope): AnySearchEnvelopeData {
  return {
    data: readRecord(envelope.data, 'data'),
    ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
  };
}

/**
 * Narrow one search response into validated results. URL-less entries are
 * retained here (with a count) and dropped at the seam mapping, matching the
 * reference split between `parseSearchData` and `mapAnySearchResponse`.
 * Aggregate `content` is bounded across all results in arrival order.
 */
export function parseSearchData(payload: AnySearchEnvelopeData): AnySearchSearchResponse {
  const parsedItems = arrayField(payload.data, 'results', 'data.results').map((value, index) =>
    parseSearchResult(value, index),
  );
  const results = parsedItems.flatMap((item) => (item.kind === 'invalid-url' ? [] : [item.result]));
  const urlLessResults = parsedItems.filter((item) => item.kind === 'url-less').length;
  const droppedInvalidUrlResults = parsedItems.filter((item) => item.kind === 'invalid-url').length;
  let remainingContentCharacters = MAX_CANONICAL_CONTENT_CHARS;
  const bounded = results.map((result) => {
    if (result.content === undefined) return result;
    const content = result.content.slice(0, remainingContentCharacters);
    remainingContentCharacters -= content.length;
    return { ...result, content };
  });
  const metadata = recordField(payload.data, 'metadata', 'data.metadata');
  return {
    ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
    results: bounded,
    metadata: {
      totalResults: nonNegativeIntegerField(metadata, 'total_results', 'data.metadata.total_results'),
      searchTimeMs: nonNegativeIntegerField(metadata, 'search_time_ms', 'data.metadata.search_time_ms'),
      ...(urlLessResults === 0 ? {} : { urlLessResults }),
      ...(droppedInvalidUrlResults === 0 ? {} : { droppedInvalidUrlResults }),
    },
  };
}

/**
 * Narrow one extract response. `url`, `title`, and `content` are all required
 * by the API contract, and `url` must be absolute HTTP(S).
 */
export function parseExtractData(payload: AnySearchEnvelopeData): AnySearchExtractResponse {
  const data = payload.data;
  const url = absoluteHttpUrlField(data, 'url', 'data.url');
  const title = stringField(data, 'title', 'data.title');
  const content = stringField(data, 'content', 'data.content');
  return {
    ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
    url,
    title,
    content,
  };
}

type ParsedSearchResult =
  | { readonly kind: 'citeable'; readonly result: AnySearchResult }
  | { readonly kind: 'url-less'; readonly result: AnySearchResult }
  | { readonly kind: 'invalid-url' };

function parseSearchResult(value: unknown, index: number): ParsedSearchResult {
  const path = `data.results[${index}]`;
  const result = readRecord(value, path);
  const url = stringField(result, 'url', `${path}.url`);
  if (url.length > 0 && !isAbsoluteHttpUrl(url)) return { kind: 'invalid-url' };
  const title = stringField(result, 'title', `${path}.title`);
  const snippet = optionalStringRecordField(result, 'snippet', `${path}.snippet`);
  const content = optionalStringRecordField(result, 'content', `${path}.content`);
  const optionalFields = {
    ...(snippet === undefined ? {} : { snippet }),
    ...(content === undefined ? {} : { content }),
  };
  if (url.length === 0) return { kind: 'url-less', result: { title, ...optionalFields } };
  return { kind: 'citeable', result: { title, url, ...optionalFields } };
}

/**
 * Map validated search results into the seam shape. A seam source always has a
 * URL (see `WebSearchSource`'s doc comment), so structured URL-less results are
 * dropped here — exactly as `mapAnySearchResponse` filters them.
 * `truncated` is always `false`: `maxResults` is enforced by the seam, and this
 * engine never cuts the list itself.
 */
export function mapSearchResponse(response: AnySearchSearchResponse): WebSearchResult {
  const sources: WebSearchSource[] = [];
  for (const result of response.results) {
    if (result.url === undefined) continue;
    const title = result.title.trim();
    const snippet = result.snippet?.trim();
    sources.push({
      url: result.url,
      ...(title.length === 0 ? {} : { title }),
      ...(snippet === undefined || snippet.length === 0 ? {} : { snippet }),
    });
  }
  return { sources, truncated: false };
}

/**
 * Map a validated extract response into the seam fetch shape. The Extract API
 * returns cleaned text (the reference labelled it `kind: 'text'` so the
 * harness does not convert it twice), a successful extract normalizes to
 * status 200, and this adapter does not truncate further.
 */
export function mapExtractResponse(response: AnySearchExtractResponse): WebFetchResult {
  return {
    url: response.url,
    statusCode: 200,
    body: { kind: 'text', content: response.content },
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
export function parseDomainsData(envelope: AnySearchEnvelopeData): AnySearchDomainsResponse {
  const domains = arrayField(envelope.data, 'domains', 'data.domains')
    .map((value, index) => parseDomainSummary(value, index))
  return {
    ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId },
    domains,
  }
}

function parseDomainSummary(value: unknown, index: number): AnySearchDomainSummary {
  const path = `data.domains[${index}]`
  const domain = readRecord(value, path)
  return {
    domain: stringField(domain, 'domain', `${path}.domain`),
    description: stringField(domain, 'description', `${path}.description`),
    subDomainCount: nonNegativeIntegerField(domain, 'sub_domain_count', `${path}.sub_domain_count`),
  }
}

export function parseSubDomainsData(envelope: AnySearchEnvelopeData): AnySearchSubDomainsResponse {
  const domains = arrayField(envelope.data, 'domains', 'data.domains')
    .map((value, index) => parseDomainCapability(value, index))
  return {
    ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId },
    domains,
  }
}

function parseDomainCapability(value: unknown, index: number): AnySearchDomainCapability {
  const path = `data.domains[${index}]`
  const domain = readRecord(value, path)
  return {
    domain: stringField(domain, 'domain', `${path}.domain`),
    description: stringField(domain, 'description', `${path}.description`),
    subDomains: arrayField(domain, 'sub_domains', `${path}.sub_domains`)
      .map((item, subIndex) => parseSubDomain(item, `${path}.sub_domains[${subIndex}]`)),
  }
}

function parseSubDomain(value: unknown, path: string): AnySearchSubDomain {
  const subDomain = readRecord(value, path)
  const paramsValue = subDomain.params === undefined ? {} : readRecord(subDomain.params, `${path}.params`)
  const params = Object.create(null) as Record<string, AnySearchParamInfo>
  for (const [name, rawInfo] of Object.entries(paramsValue)) {
    const infoPath = `${path}.params.${name}`
    const info = readRecord(rawInfo, infoPath)
    const sortOrder = optionalNumberRecordField(info, 'sort_order', `${infoPath}.sort_order`)
    params[name] = {
      description: stringField(info, 'description', `${infoPath}.description`),
      required: booleanField(info, 'required', `${infoPath}.required`),
      ...sortOrder === undefined ? {} : { sortOrder },
    }
  }
  return {
    subDomain: stringField(subDomain, 'sub_domain', `${path}.sub_domain`),
    description: stringField(subDomain, 'description', `${path}.description`),
    params,
  }
}

function optionalNumberRecordField(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isInteger(field)) throw new TypeError(`${path} must be an integer`)
  return field
}

function booleanField(value: Record<string, unknown>, key: string, path: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new TypeError(`${path} must be a boolean`)
  return field
}

// Narrowing helpers. Each one throws a `TypeError` naming the JSON path, so a
// malformed upstream body reports *which* field was wrong.
// ---------------------------------------------------------------------------

/** A plain (non-null, non-array) object view, or a `TypeError`. */
export function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** A required object field. */
function recordField(value: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  return readRecord(value[key], path);
}

/** A required array field. */
function arrayField(value: Record<string, unknown>, key: string, path: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new TypeError(`${path} must be an array`);
  return field;
}

/** A required string field. */
function stringField(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new TypeError(`${path} must be a string`);
  return field;
}

/** A required absolute HTTP(S) URL field. */
function absoluteHttpUrlField(value: Record<string, unknown>, key: string, path: string): string {
  const field = stringField(value, key, path);
  if (!isAbsoluteHttpUrl(field)) throw new TypeError(`${path} must be an absolute HTTP(S) URL`);
  return field;
}

/** An optional string field; a present non-string is a `TypeError`. */
function optionalStringRecordField(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string') throw new TypeError(`${path} must be a string`);
  return field;
}

/** A string field read off an unvalidated value; wrong types read as absent. */
function optionalStringField(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string') throw new TypeError(`${path} must be a string`);
  return field;
}

/** A required finite number field. */
function numberField(value: Record<string, unknown>, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new TypeError(`${path} must be a number`);
  return field;
}

/** A required non-negative safe-integer field. */
function nonNegativeIntegerField(value: Record<string, unknown>, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== 'number') throw new TypeError(`${path} must be a number`);
  if (!Number.isSafeInteger(field) || field < 0) {
    throw new TypeError(`${path} must be a non-negative integer`);
  }
  return field;
}
