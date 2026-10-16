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
import type { WebSearchResult } from '@deepseek-ai/dsh-web';
import type { ZhihuQuota, ZhihuQuotaResponse, ZhihuSearchRequest, ZhihuSearchResponse } from './types.js';
/** A trimmed non-empty string, or `undefined` for anything else. */
export declare function readNonEmptyString(value: unknown): string | undefined;
/** A plain (non-null, non-array) object view, or `undefined`. */
export declare function readRecord(value: unknown): Record<string, unknown> | undefined;
/**
 * Read an int64 that may arrive as a JSON number or as a decimal string.
 * Anything else (float, non-numeric text, `null`) yields `undefined`.
 */
export declare function readInt64(value: unknown): number | undefined;
/**
 * Build the query parameters of one `global_search` call. `Query` is sent
 * verbatim; `Count` is aligned to the seam's `maxResults` and clamped to
 * `countMax` (the documented 1–20 range by default), and is omitted when the
 * request carries no bound (the API then applies its own default of 10).
 * `Filter`/`SearchDB` are never sent: vertical parameters do not exist on the
 * seam and are part of the two-tool interface.
 */
export declare function buildZhihuSearchRequest(query: string, maxResults?: number, countMax?: number): ZhihuSearchRequest;
/**
 * Clamp `maxResults` into `countMax` as the ceiling and 1 as the floor. The
 * ceiling is an engine option so a deployment can stay below the documented
 * maximum; it can never exceed it (see {@link normalizeZhihuCountMax}).
 */
export declare function clampZhihuCount(maxResults: number, countMax?: number): number;
/**
 * Remove every `utm_*` query parameter (Zhihu appends
 * `utm_medium=openapi_platform&utm_source=…` attribution) and leave the rest of
 * the URL — path, fragment, and non-UTM parameters — untouched. A URL that does
 * not parse is returned verbatim rather than dropped or rewritten.
 */
export declare function stripUtmParams(url: string): string;
/**
 * Strip the `<em>`/`</em>` highlight tags Zhihu wraps around matched query
 * terms in `ContentText`. Only those tags are removed — other markup is left
 * exactly as delivered rather than guessed at.
 */
export declare function stripHighlightTags(text: string): string;
/**
 * Convert `EditTime` (int64 Unix seconds) into an ISO-8601 string. Missing,
 * non-integer, non-positive, and out-of-range values yield `undefined` instead
 * of an invented timestamp.
 */
export declare function formatEditTime(editTime: unknown): string | undefined;
/** Business `Code` of an envelope as a number, or `undefined` when absent/unreadable. */
export declare function readZhihuCode(payload: unknown): number | undefined;
/**
 * Map a `global_search` response into seam sources: `Url`→`url` (UTM params
 * stripped), `Title`→`title`, `ContentText`→`snippet` (highlight tags
 * stripped), `EditTime`→`publishedAt` (Unix seconds → ISO 8601). Entries
 * without a usable URL are dropped (a seam source always has one); empty or
 * non-string fields are omitted rather than invented. `truncated` is always
 * `false`: the seam owns the `maxResults` bound.
 */
export declare function mapZhihuSearchResponse(payload: ZhihuSearchResponse): WebSearchResult;
/**
 * True when a request timestamp is inside the documented ±10 minute window
 * around `nowMs`. The client cannot fix a skewed local clock; this predicate
 * exists so the freshness guarantee the client does provide — a header derived
 * from the current clock on every call — is checkable, including in tests.
 */
export declare function isTimestampWithinTolerance(timestampSeconds: number, nowMs: number, toleranceSeconds?: number): boolean;
/**
 * Read the `global_search` daily quota out of a quota response: the `Data[]`
 * entry whose `APIID` is `apiId`. Returns `undefined` when the envelope carries
 * no usable entry, so the caller never treats an unreadable body as "no quota
 * left" (fail-open on data, fail-closed only on an explicit `remaining <= 0`).
 */ export declare function mapZhihuQuotaResponse(payload: ZhihuQuotaResponse, apiId: string): ZhihuQuota | undefined;
/**
 * True when a daily quota is exhausted. This is the one place the engine
 * decides "no calls left today"; a missing quota is not exhaustion, so the
 * caller passes `undefined` and gets `false`.
 */
export declare function isZhihuQuotaExhausted(quota: ZhihuQuota | undefined): boolean;
