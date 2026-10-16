/**
 * Public surface of the Zhihu engine adapter. The search pipeline imports from
 * here (or from the individual modules); nothing in this folder registers tools
 * or touches the seam (DESIGN.md — the plugin's only model-facing tools are the
 * native web_search / web_fetch).
 * @module engines/zhihu
 */
export { ZHIHU_DEFAULT_ACCESS_SECRET_ENV, ZHIHU_GLOBAL_SEARCH_URL, ZHIHU_QUOTA_API_ID, ZHIHU_QUOTA_URL, ZHIHU_COUNT_MAX, ZHIHU_COUNT_MIN, ZHIHU_REQUEST_TIMEOUT_MS, ZHIHU_TIMESTAMP_TOLERANCE_SECONDS, } from './limits.js';
export { ZHIHU_ENGINE_DEFAULTS, resolveZhihuEngineOptions, normalizeZhihuCountMax, } from './options.js';
export type { ResolvedZhihuEngineOptions, ZhihuEngineOptions } from './options.js';
export { ZHIHU_CODE_AUTH_FAILED, ZHIHU_CODE_INTERNAL_ERROR, ZHIHU_CODE_INVALID_PARAM, ZHIHU_CODE_RATE_LIMITED, ZhihuClient, ZhihuWebError, extractZhihuErrorDetail, readZhihuCircuitSignal, translateZhihuTransportFailure, } from './client.js';
export type { ZhihuCircuitSignal, ZhihuClientOptions } from './client.js';
export { ZhihuEngine, createZhihuEngine } from './adapter.js';
export { buildZhihuSearchRequest, clampZhihuCount, formatEditTime, isTimestampWithinTolerance, isZhihuQuotaExhausted, mapZhihuQuotaResponse, mapZhihuSearchResponse, readInt64, readZhihuCode, stripHighlightTags, stripUtmParams, } from './wire.js';
export type { ZhihuQuota, ZhihuQuotaEntry, ZhihuQuotaResponse, ZhihuSearchData, ZhihuSearchItem, ZhihuSearchRequest, ZhihuSearchResponse, } from './types.js';
