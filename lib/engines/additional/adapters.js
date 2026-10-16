import { WebError } from '@deepseek-ai/dsh-web';
import { EngineHttp, record, rows, text } from './http.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { readAihotApi } from './aihot.js';
export function adapt(id, search, fetch, settings = {}) {
    switch (id) {
        case 'kimi': return {
            id,
            search: async (request, signal) => {
                const basic = settings.searchMode === 'basic';
                const data = await search.call(basic ? '/v1/tools/search' : '/v1/tools/search_pro', {
                    text_query: request.query, limit: count(request, 20), timeout_seconds: 10,
                    ...(basic ? { include_content: false } : {}),
                }, signal);
                if (data.error !== undefined)
                    throw new WebError('kimi: search rejected', 'WEB_PROVIDER_ERROR');
                return searchResult(rows(data.search_results, id).map(item => {
                    const chunks = item.chunks === undefined ? [] : rows(item.chunks, id).map(chunk => text(chunk.text)).filter(Boolean);
                    const snippet = [text(item.snippet),
                        text(item.site_name) && `来源：${text(item.site_name)}`,
                        text(item.authority) && `Kimi 来源等级：${text(item.authority)}`,
                        ...chunks,
                    ].filter(Boolean).join('\n').slice(0, 6000);
                    return source(item.url, item.title, snippet, item.date);
                }), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/v1/tools/fetch', { url }, signal);
                if (data.error !== undefined)
                    throw new WebError('kimi: extraction rejected', 'WEB_PROVIDER_ERROR');
                return fetchResult(url, data.url, data.markdown, data.title);
            },
        };
        case 'aihot': return {
            id,
            readApi: (url, signal) => readAihotApi(url, fetch, signal),
            search: async (request, signal) => {
                const query = request.query.trim();
                const length = [...query].length;
                if (length < 2 || length > 200)
                    throw new WebError('aihot: query must contain 2–200 characters', 'WEB_PROVIDER_ERROR');
                const data = await search.cachedGet('/api/v1/items', signal, new URLSearchParams({ mode: 'all', window: '7d', q: query, limit: String(count(request, 100)) }));
                if (data.schemaVersion !== 1)
                    throw new WebError('aihot: unsupported response version', 'WEB_PROVIDER_ERROR');
                const page = record(data.page, id);
                if (typeof page.hasMore !== 'boolean')
                    throw new WebError('aihot: invalid pagination', 'WEB_PROVIDER_ERROR');
                const candidates = rows(data.items, id).map(item => {
                    const links = record(item.links, id);
                    const publisher = record(item.source, id);
                    const attribution = item.attribution === undefined ? undefined : record(item.attribution, id);
                    const snippet = [text(item.summary), text(publisher.name) && `来源：${text(publisher.name)}`,
                        `AIHOT：${source(links.aihot, undefined)?.url ?? 'https://aihot.news'}`,
                        attribution && `数据归属：${text(attribution.name) ?? 'AIHOT'} ${source(attribution.url, undefined)?.url ?? 'https://aihot.news'}`,
                    ].filter(Boolean).join('\n');
                    return source(links.original, item.title, snippet, item.publishedAt);
                });
                const result = searchResult(candidates, request);
                return { ...result, truncated: result.truncated || page.hasMore };
            },
        };
        case 'tinyfish': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('', undefined, signal, new URLSearchParams({ query: request.query }));
                return searchResult(rows(data.results, id).map(item => source(item.url, item.title, item.snippet, item.date)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('', { urls: [url], format: 'markdown', ttl: 0 }, signal);
                const item = rows(data.results, id).find(item => item.url === url);
                if (!item)
                    throw new WebError('tinyfish: URL extraction failed', 'WEB_PROVIDER_ERROR');
                return fetchResult(url, item.final_url ?? item.url, item.text, item.title);
            },
        };
        case 'serply': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/v1/search/', undefined, signal, new URLSearchParams({ q: request.query, num: String(count(request, 100)) }));
                return searchResult(rows(data.results, id).map(item => source(item.link, item.title, item.description)), request);
            },
            extract: async (url, signal) => fetchResult(url, url, await fetch.callText('/v1/request', { url, response_type: 'markdown' }, signal)),
        };
        case 'bing': return {
            id,
            search: async (request, signal) => {
                const xml = await search.callText('/search', undefined, signal, new URLSearchParams({ q: request.query, format: 'rss' }));
                if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true)
                    throw new WebError('bing: invalid RSS response', 'WEB_PROVIDER_ERROR');
                const parsed = new XMLParser({ parseTagValue: false, isArray: (_name, path) => path === 'rss.channel.item' }).parse(xml);
                const channel = record(record(record(parsed, id).rss, id).channel, id);
                return searchResult(rows(channel.item ?? [], id).map(item => source(item.link, item.title, item.description, item.pubDate)), request);
            },
        };
        case 'tavily': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/search', { query: request.query, max_results: count(request, 20), search_depth: 'basic', include_answer: false }, signal);
                return searchResult(rows(data.results, id).map(item => source(item.url, item.title, item.content, item.published_date)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/extract', { urls: [url], format: 'markdown', extract_depth: 'basic' }, signal);
                const item = rows(data.results, id)[0];
                if (!item)
                    throw new WebError('tavily: URL extraction failed', 'WEB_PROVIDER_ERROR');
                return fetchResult(url, item.url, item.raw_content, item.title);
            },
        };
        case 'exa': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/search', { query: request.query, numResults: count(request, 100), type: 'auto', contents: { highlights: true } }, signal);
                return searchResult(rows(data.results, id).map(item => source(item.url, item.title, Array.isArray(item.highlights) ? item.highlights.filter(v => typeof v === 'string').join('\n') : item.text, item.publishedDate)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/contents', { urls: [url], text: true, maxAgeHours: 0 }, signal);
                const item = rows(data.results, id)[0];
                if (!item)
                    throw new WebError('exa: URL extraction failed', 'WEB_PROVIDER_ERROR');
                return fetchResult(url, item.url, item.text, item.title);
            },
        };
        case 'keenable': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/v1/search', { query: request.query, mode: 'realtime', max_results: count(request, 50) }, signal);
                return searchResult(rows(data.results, id).map(item => source(item.url, item.title, item.snippet ?? item.description, item.published_at)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/v1/fetch', undefined, signal, new URLSearchParams({ url, live: 'true' }));
                return fetchResult(url, data.url, data.content, data.title);
            },
        };
        case 'crawl4ai': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/search', undefined, signal, new URLSearchParams({ q: [...request.query].slice(0, 512).join('') }));
                return searchResult(rows(data.results, id).map(item => source(item.url, item.title, item.snippet)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/scrape', { url, format: 'md' }, signal);
                if (data.ok !== true)
                    throw new WebError('crawl4ai: scrape failed', 'WEB_PROVIDER_ERROR');
                return fetchResult(url, data.url, data.markdown);
            },
        };
        case 'qianfan': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/v2/ai_search/web_search', {
                    messages: [{ role: 'user', content: request.query }], search_source: 'baidu_search_v2',
                    resource_type_filter: [{ type: 'web', top_k: count(request, 50) }],
                }, signal);
                if (data.code !== undefined && data.code !== 0 && data.code !== '0')
                    throw new WebError('qianfan: search rejected', 'WEB_PROVIDER_ERROR');
                return searchResult(rows(data.references, id).map(item => source(item.url, item.title, item.snippet ?? item.content, item.date)), request);
            },
        };
        case 'doubao': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/search_api/web_search', { Query: request.query, SearchType: 'web', Count: count(request, 50) }, signal);
                const result = doubaoResult(data);
                return searchResult(rows(result.WebResults, id).map(item => source(item.Url, item.Title, item.Summary ?? item.Snippet, item.PublishTime)), request);
            },
            extract: async (url, signal) => {
                const data = await fetch.call('/search_api/fetch', { Url: url }, signal);
                const item = record(doubaoResult(data).Data, id);
                return fetchResult(url, item.RedirectedUrl ?? item.Url, item.ContentText, item.Title, item.StatusCode);
            },
        };
        case 'firecrawl': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/v2/search', { query: request.query, limit: count(request, 100), sources: ['web'] }, signal);
                if (data.success !== true)
                    throw new WebError('firecrawl: search failed', 'WEB_PROVIDER_ERROR');
                return searchResult(rows(record(data.data, id).web, id).map(item => source(item.url, item.title, item.description)), request);
            },
        };
        case 'github': return {
            id,
            search: async (request, signal) => {
                const data = await search.call('/search/repositories', undefined, signal, new URLSearchParams({ q: `${request.query} is:public`, per_page: String(count(request, 100)) }));
                return searchResult(rows(data.items, id).filter(item => item.private === false).map(item => source(item.html_url, item.full_name, item.description)), request);
            },
            supportsUrl: url => githubPath(url) !== undefined,
            extract: async (url, signal) => {
                const path = githubPath(url);
                if (!path)
                    throw new WebError('github: unsupported repository URL', 'WEB_INVALID_URL');
                const data = await fetch.call(path.path, undefined, signal, path.query);
                if (data.encoding !== 'base64' || typeof data.content !== 'string')
                    throw new WebError('github: not a text file', 'WEB_UNSUPPORTED_CONTENT_TYPE');
                const bytes = Buffer.from(data.content, 'base64');
                let content;
                try {
                    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                }
                catch {
                    throw new WebError('github: not UTF-8 text', 'WEB_UNSUPPORTED_CONTENT_TYPE');
                }
                return fetchResult(url, data.html_url, content, data.name);
            },
        };
    }
}
function doubaoResult(data) {
    const metadata = record(data.ResponseMetadata, 'doubao');
    if (metadata.Error !== undefined)
        throw new WebError('doubao: request rejected', 'WEB_PROVIDER_ERROR');
    return record(data.Result, 'doubao');
}
function count(request, max) {
    return Math.max(1, Math.min(max, Math.floor(request.maxResults ?? 10)));
}
function source(url, title, snippet, publishedAt) {
    if (typeof url !== 'string')
        return undefined;
    try {
        if (!['http:', 'https:'].includes(new URL(url).protocol))
            return undefined;
    }
    catch {
        return undefined;
    }
    return { url,
        ...(text(title) === undefined ? {} : { title: text(title) }),
        ...(text(snippet) === undefined ? {} : { snippet: text(snippet) }),
        ...(text(publishedAt) === undefined ? {} : { publishedAt: text(publishedAt) }),
    };
}
function searchResult(candidates, request) {
    const sources = candidates.filter((item) => item !== undefined);
    return { sources: sources.slice(0, request.maxResults), truncated: request.maxResults !== undefined && sources.length > request.maxResults };
}
function fetchResult(requestUrl, resultUrl, content, title, status) {
    if (typeof content !== 'string' || content.trim().length === 0)
        throw new WebError('extraction returned no text', 'WEB_PROVIDER_ERROR');
    const header = text(title);
    const body = header ? `# ${header}\n\n${content}` : content;
    const url = source(resultUrl, undefined)?.url ?? requestUrl;
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
        throw new WebError('invalid target status', 'WEB_PROVIDER_ERROR');
    return { url, statusCode: status ?? 200, body: { kind: 'text', content: body.slice(0, 100_000) }, truncated: body.length > 100_000 };
}
export function githubPath(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return undefined;
    }
    if (url.hostname !== 'github.com' || url.protocol !== 'https:' || url.username || url.password || url.port)
        return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, ref, ...file] = parts;
    if (!owner || !repo || !/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo))
        return undefined;
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (parts.length === 2)
        return { path: `${prefix}/readme` };
    if (kind !== 'blob' || !ref || file.length === 0)
        return undefined;
    // Slash-containing branch names need a separate ref lookup; other fetch engines still participate.
    try {
        return { path: `${prefix}/contents/${file.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/')}`, query: new URLSearchParams({ ref: decodeURIComponent(ref) }) };
    }
    catch {
        return undefined;
    }
}
