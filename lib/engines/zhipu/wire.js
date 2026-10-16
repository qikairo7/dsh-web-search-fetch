import { ZHIPU_COUNT_MAX, ZHIPU_COUNT_MIN, ZHIPU_DEFAULT_CONTENT_SIZE, ZHIPU_DEFAULT_SEARCH_ENGINE, ZHIPU_SEARCH_QUERY_MAX_CHARS, } from '../../limits.js';
/**
 * Narrow a runtime value to a supported search_engine tier; anything else
 * falls back to the default (`search_pro`). Config strings are untrusted.
 */
export function resolveZhipuSearchEngine(value) {
    return value === 'search_std' || value === 'search_pro' || value === 'search_pro_sogou' || value === 'search_pro_quark'
        ? value
        : ZHIPU_DEFAULT_SEARCH_ENGINE;
}
/** Narrow a runtime value to a supported content_size; anything else → `medium`. */
export function resolveZhipuContentSize(value) {
    return value === 'medium' || value === 'high' ? value : ZHIPU_DEFAULT_CONTENT_SIZE;
}
/**
 * Build the wire request: intent fixed (`false`), engine tier and snippet
 * granularity from `params` (defaults `search_pro` / `medium`), query capped
 * at the API's 70-character limit, `count` aligned to the seam's
 * `maxResults` (omitted when the request carries no bound, leaving the API's
 * own default).
 */
export function buildZhipuSearchRequest(query, maxResults, params = {}) {
    return {
        search_engine: resolveZhipuSearchEngine(params.searchEngine),
        search_query: truncateToCodePoints(query, ZHIPU_SEARCH_QUERY_MAX_CHARS),
        search_intent: false,
        content_size: resolveZhipuContentSize(params.contentSize),
        ...(maxResults === undefined ? {} : { count: clampZhipuCount(maxResults) }),
    };
}
/** Clamp `maxResults` into the API's documented 1–50 range. */
export function clampZhipuCount(maxResults) {
    if (!Number.isFinite(maxResults))
        return ZHIPU_COUNT_MIN;
    return Math.min(ZHIPU_COUNT_MAX, Math.max(ZHIPU_COUNT_MIN, Math.floor(maxResults)));
}
/** Truncate to at most `max` Unicode code points, never splitting a surrogate pair. */
export function truncateToCodePoints(text, max) {
    const points = Array.from(text);
    return points.length <= max ? text : points.slice(0, max).join('');
}
/** A trimmed non-empty string, or `undefined` for anything else. */
export function readNonEmptyString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}
/** A plain (non-null, non-array) object view, or `undefined`. */
export function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Map a wire response into seam sources: `link`→`url`, `content`→`snippet`,
 * `publish_date`→`publishedAt` (the date string verbatim — no ISO conversion),
 * `title`→`title`. Entries without a URL are dropped (a seam source always has
 * one); empty or non-string fields are omitted rather than invented.
 * `truncated` is always `false`: the seam owns the `maxResults` bound.
 */
export function mapZhipuSearchResponse(payload) {
    const items = Array.isArray(payload.search_result) ? payload.search_result : [];
    const sources = [];
    for (const item of items) {
        const record = readRecord(item);
        if (record === undefined)
            continue;
        const url = readNonEmptyString(record.link);
        if (url === undefined)
            continue;
        const title = readNonEmptyString(record.title);
        const snippet = readNonEmptyString(record.content);
        const publishedAt = readNonEmptyString(record.publish_date);
        sources.push({
            url,
            ...(title === undefined ? {} : { title }),
            ...(snippet === undefined ? {} : { snippet }),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return { sources, truncated: false };
}
