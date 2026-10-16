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
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web';
import type { AnySearchParamValue, AnySearchDomainsResponse, AnySearchSubDomainsResponse } from './types.js';
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
export declare function endpoint(baseURL: string, path: string): string | undefined;
/** Whether a string is an absolute `http:`/`https:` URL. */
export declare function isAbsoluteHttpUrl(value: string): boolean;
/**
 * Validate one decoded response body as an AnySearch envelope. Throws
 * `TypeError` with the offending path when a field has the wrong shape; the
 * client turns that into a classified failure. `code !== 0` is *not* handled
 * here — the client needs the HTTP status and headers to classify it.
 */
export declare function readEnvelope(value: unknown): AnySearchEnvelope;
/**
 * Validate the payload of a *successful* envelope. Only called once
 * `code === 0`, so a missing or non-object `data` here is a genuine contract
 * violation rather than an error envelope's `data: null`.
 */
export declare function envelopeData(envelope: AnySearchEnvelope): AnySearchEnvelopeData;
/**
 * Narrow one search response into validated results. URL-less entries are
 * retained here (with a count) and dropped at the seam mapping, matching the
 * reference split between `parseSearchData` and `mapAnySearchResponse`.
 * Aggregate `content` is bounded across all results in arrival order.
 */
export declare function parseSearchData(payload: AnySearchEnvelopeData): AnySearchSearchResponse;
/**
 * Narrow one extract response. `url`, `title`, and `content` are all required
 * by the API contract, and `url` must be absolute HTTP(S).
 */
export declare function parseExtractData(payload: AnySearchEnvelopeData): AnySearchExtractResponse;
/**
 * Map validated search results into the seam shape. A seam source always has a
 * URL (see `WebSearchSource`'s doc comment), so structured URL-less results are
 * dropped here — exactly as `mapAnySearchResponse` filters them.
 * `truncated` is always `false`: `maxResults` is enforced by the seam, and this
 * engine never cuts the list itself.
 */
export declare function mapSearchResponse(response: AnySearchSearchResponse): WebSearchResult;
/**
 * Map a validated extract response into the seam fetch shape. The Extract API
 * returns cleaned text (the reference labelled it `kind: 'text'` so the
 * harness does not convert it twice), a successful extract normalizes to
 * status 200, and this adapter does not truncate further.
 */
export declare function mapExtractResponse(response: AnySearchExtractResponse): WebFetchResult;
export declare function parseDomainsData(envelope: AnySearchEnvelopeData): AnySearchDomainsResponse;
export declare function parseSubDomainsData(envelope: AnySearchEnvelopeData): AnySearchSubDomainsResponse;
/** A plain (non-null, non-array) object view, or a `TypeError`. */
export declare function readRecord(value: unknown, path: string): Record<string, unknown>;
