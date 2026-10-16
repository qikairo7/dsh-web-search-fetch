/**
 * Engine-scoped constants for the Zhihu `global_search` adapter. They live
 * inside the engine module so the adapter can land without touching the shared
 * `src/limits.ts` (integration into the pipeline belongs to the pipeline
 * tickets).
 * @module engines/zhihu/limits
 */
/** Default credential reference for the Zhihu engine (the config default). */
export declare const ZHIHU_DEFAULT_ACCESS_SECRET_ENV = "ZHIHU_ACCESS_SECRET";
/** Zhihu `global_search` endpoint (developer.zhihu.com OpenAPI). */
export declare const ZHIHU_GLOBAL_SEARCH_URL = "https://developer.zhihu.com/api/v1/content/global_search";
/** Zhihu daily-quota endpoint; one call reports one `APIIDs` entry. */
export declare const ZHIHU_QUOTA_URL = "https://developer.zhihu.com/api/v1/quota";
/** `APIID` this engine consumes from the quota endpoint. */
export declare const ZHIHU_QUOTA_API_ID = "global_search";
/**
 * `Count` bounds. The API defaults to 10 when `Count` is omitted and rejects
 * anything above 20, so the documented maximum is also this engine's ceiling.
 */
export declare const ZHIHU_COUNT_MIN = 1;
export declare const ZHIHU_COUNT_MAX = 20;
/** Single-engine deadline (DESIGN.md: per-engine limit of 10 s). */
export declare const ZHIHU_REQUEST_TIMEOUT_MS = 10000;
/**
 * Documented tolerance between `X-Request-Timestamp` and the server clock
 * (10 minutes): a request whose header drifts further is rejected. The client
 * cannot repair a skewed local clock; what it can guarantee is that the header
 * is derived from the current clock on every request, so a long-lived process
 * never sends a header that has aged out of this window. Tests assert exactly
 * that with {@link isTimestampWithinTolerance}.
 */
export declare const ZHIHU_TIMESTAMP_TOLERANCE_SECONDS = 600;
