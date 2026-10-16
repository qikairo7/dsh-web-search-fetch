/**
 * Engine options for the Zhihu adapter with their defaults, in one place. The
 * engine module owns its knobs (DESIGN.md: a new engine is a new adapter file),
 * so the pipeline ticket can construct a client without reaching into shared
 * constants.
 * @module engines/zhihu/options
 */
import { ZHIHU_COUNT_MAX, ZHIHU_GLOBAL_SEARCH_URL, ZHIHU_QUOTA_URL, ZHIHU_REQUEST_TIMEOUT_MS, } from './limits.js';
/** Effective defaults when the caller supplies nothing. */
export const ZHIHU_ENGINE_DEFAULTS = {
    baseURL: ZHIHU_GLOBAL_SEARCH_URL,
    quotaURL: ZHIHU_QUOTA_URL,
    timeoutMs: ZHIHU_REQUEST_TIMEOUT_MS,
    countMax: ZHIHU_COUNT_MAX,
};
/**
 * Resolve options against the defaults. `timeoutMs` falls back to the default
 * unless it is a finite positive number; `countMax` is clamped into 1–20.
 */
export function resolveZhihuEngineOptions(options = {}) {
    const baseURL = nonEmptyOr(options.baseURL, ZHIHU_ENGINE_DEFAULTS.baseURL);
    const quotaURL = nonEmptyOr(options.quotaURL, ZHIHU_ENGINE_DEFAULTS.quotaURL);
    const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : ZHIHU_ENGINE_DEFAULTS.timeoutMs;
    return {
        baseURL,
        quotaURL,
        timeoutMs,
        countMax: normalizeZhihuCountMax(options.countMax),
    };
}
/** A configured ceiling, accepted only when it is an integer inside 1–20. */
export function normalizeZhihuCountMax(countMax) {
    if (countMax === undefined || !Number.isFinite(countMax))
        return ZHIHU_COUNT_MAX;
    const floored = Math.floor(countMax);
    if (floored < 1)
        return 1;
    return Math.min(ZHIHU_COUNT_MAX, floored);
}
function nonEmptyOr(value, fallback) {
    if (value === undefined)
        return fallback;
    const trimmed = value.trim();
    return trimmed.length === 0 ? fallback : trimmed;
}
