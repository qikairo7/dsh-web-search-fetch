import { WebError } from '@deepseek-ai/dsh-web';
import { EngineHttp, record } from './http.js';
// Only documented read-only APIs participate. Human pages retain the generic fetch pipeline.
const API_PATH = /^\/api\/v1\/(?:items|hot-topics|stories\/[\w-]{1,128}|codex-resets(?:\/recent)?|dailies(?:\/(?:latest|\d{4}-\d{2}-\d{2}))?|weeklies(?:\/(?:latest|\d{4}-W\d{2}))?|monthlies(?:\/(?:latest|\d{4}-\d{2}))?|selected\/(?:snapshot|changes)|agent(?:\/(?:latest|search|hot|stories\/[\w-]{1,128}|daily(?:\/\d{4}-\d{2}-\d{2})?|weekly(?:\/\d{4}-W\d{2})?|monthly(?:\/\d{4}-\d{2})?|codex-resets))?)$/;
/** Preserve structured reports and sync operations, including nulls, attribution and opaque cursors. */
export async function readAihotApi(rawUrl, http, signal) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return undefined;
    }
    if (url.hostname !== 'aihot.news' || !url.pathname.startsWith('/api/v1/'))
        return undefined;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || rawUrl.length > 8192 || !API_PATH.test(url.pathname)) {
        throw new WebError('aihot: unsupported API URL', 'WEB_INVALID_URL');
    }
    // Query values (including opaque cursors) are passed without reinterpretation; the API validates them.
    url.hash = '';
    url.searchParams.sort();
    const markdown = url.pathname.startsWith('/api/v1/agent');
    const resets = url.pathname.includes('/codex-resets');
    let content = await http.cachedText(url.pathname, signal, url.searchParams, resets ? 600 : 60);
    if (!markdown) {
        const data = record(JSON.parse(content), 'aihot');
        if (data.schemaVersion !== 1)
            throw new WebError('aihot: unsupported response version', 'WEB_PROVIDER_ERROR');
        content = JSON.stringify(data, null, 2);
    }
    if (!content.trim())
        throw new WebError('aihot: empty API response', 'WEB_PROVIDER_ERROR');
    // Never silently cut a JSON document and lose nextCursor/removes at its end.
    if (content.length > 100_000)
        throw new WebError('aihot: response too large; request a smaller page', 'WEB_FETCH_TOO_LARGE');
    return { url: url.href, statusCode: 200, body: { kind: 'text', content }, truncated: false };
}
