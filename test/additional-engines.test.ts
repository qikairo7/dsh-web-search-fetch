import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { WebError, type WebFetchProvider, type WebSearchProvider } from '@deepseek-ai/dsh-web';
import { apply, Config } from '../src/index.js';
import { CircuitBreaker } from '../src/breaker/index.js';
import { AggregatedSearchProvider, readSearchFailureSignal } from '../src/search-aggregate.js';
import { AggregatedFetchProvider } from '../src/fetch-pipeline.js';
import { createAdditionalEngines, ADDITIONAL_ENGINE_DEFAULTS, githubPath, type AdditionalEngineId } from '../src/engines/additional/index.js';
import { EngineHttp } from '../src/engines/additional/http.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const ids = Object.keys(ADDITIONAL_ENGINE_DEFAULTS) as AdditionalEngineId[];
const target = 'https://example.com/article';
const searchPayloads: Record<AdditionalEngineId, unknown> = {
  kimi: { search_results: [{ url: target, title: 'Title', snippet: 'Snippet', chunks: [] }] },
  aihot: { schemaVersion: 1, items: [{ title: 'Title', summary: 'Snippet', source: { name: 'Publisher' }, links: { original: target, aihot: 'https://aihot.news/items/sample' }, attribution: { name: 'AIHOT', url: 'https://aihot.news' }, publishedAt: null }], page: { hasMore: false } },
  tavily: { results: [{ url: target, title: 'Title', content: 'Snippet' }] },
  exa: { results: [{ url: target, title: 'Title', highlights: ['Snippet'] }] },
  keenable: { results: [{ url: target, title: 'Title', snippet: 'Snippet' }] },
  crawl4ai: { results: [{ url: target, title: 'Title', snippet: 'Snippet' }] },
  github: { items: [{ html_url: target, full_name: 'Title', description: 'Snippet', private: false }] },
  qianfan: { references: [{ url: target, title: 'Title', snippet: 'Snippet' }] },
  doubao: { ResponseMetadata: {}, Result: { WebResults: [{ Url: target, Title: 'Title', Summary: 'Snippet' }] } },
  tinyfish: { results: [{ url: target, title: 'Title', snippet: 'Snippet' }] },
  serply: { results: [{ link: target, title: 'Title', description: 'Snippet' }] },
  bing: `<rss><channel><item><link>${target}</link><title>Title</title><description>Snippet</description></item></channel></rss>`,
  firecrawl: { success: true, data: { web: [{ url: target, title: 'Title', description: 'Snippet' }] } },
};
const fetchPayloads: Partial<Record<AdditionalEngineId, unknown>> = {
  kimi: { url: target, title: 'Title', markdown: 'Body' },
  tinyfish: { results: [{ url: target, final_url: target, title: 'Title', text: 'Body' }], errors: [] },
  serply: 'Body',
  tavily: { results: [{ url: target, title: 'Title', raw_content: 'Body' }] },
  exa: { results: [{ url: target, title: 'Title', text: 'Body' }] },
  keenable: { url: target, title: 'Title', content: 'Body' },
  crawl4ai: { ok: true, markdown: 'Body' },
  doubao: { ResponseMetadata: {}, Result: { Data: { Url: target, RedirectedUrl: target, ContentText: 'Body', Title: 'Title', StatusCode: 404 } } },
  github: { encoding: 'base64', content: Buffer.from('Body').toString('base64'), name: 'README.md', html_url: 'https://github.com/owner/repo/blob/main/README.md' },
};

describe('新增引擎 HTTP 契约', () => {
  it('豆包 HTTPS 升级经过实际适配器和正文整理后返回最终地址', async () => {
    server = await startMockServer((_request, response) => {
      response.end(JSON.stringify({ ResponseMetadata: {}, Result: { Data: { Url: 'http://example.com', RedirectedUrl: 'https://example.com/', ContentText: 'Public example content.', Title: 'Example Domain', StatusCode: 200 } } }));
    });
    const engines = createAdditionalEngines({ doubao: { baseURL: server.url } }, async () => 'test-key', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: engines, legs: [], resolveControls: () => ({ preset: 'custom', fetchServices: ['doubao'], mode: 'organize' }) });
    const output = await provider.fetch({ url: 'http://example.com' });
    expect(output.url).toBe('https://example.com/');
    expect(output.body.content).toContain('Public example content.');
    expect(output.body.content).toContain('doubao');
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ Url: 'http://example.com' });
  });

  it('GitHub 仓库根页的 README 进入正文整理，保留目标仓库 URL', async () => {
    server = await startMockServer((_request, response) => {
      response.end(JSON.stringify(fetchPayloads.github));
    });
    const engines = createAdditionalEngines({ github: { baseURL: server.url } }, async () => 'test-key', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: engines, legs: [], resolveControls: () => ({ preset: 'custom', fetchServices: ['github'], mode: 'organize' }) });
    const output = await provider.fetch({ url: 'https://github.com/owner/repo' });
    expect(output.url).toBe('https://github.com/owner/repo');
    expect(output.body.content).toContain('Body');
    expect(output.body.content).toContain('github');
    expect(server.requests[0]?.url).toBe('/repos/owner/repo/readme');
  });

  it('GitHub README 返回其他仓库时仍拒绝正文整理', async () => {
    server = await startMockServer((_request, response) => {
      response.end(JSON.stringify({ ...fetchPayloads.github as object, html_url: 'https://github.com/other/repo/blob/main/README.md' }));
    });
    const engines = createAdditionalEngines({ github: { baseURL: server.url } }, async () => 'test-key', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: engines, legs: [], resolveControls: () => ({ preset: 'custom', fetchServices: ['github'], mode: 'organize' }) });
    await expect(provider.fetch({ url: 'https://github.com/owner/repo' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });

  it('GitHub blob 文本扩展名通过内容 API 提取，不误判为静态 HTTP 资源', async () => {
    server = await startMockServer((_request, response) => {
      response.end(JSON.stringify(fetchPayloads.github));
    });
    const engines = createAdditionalEngines({ github: { baseURL: server.url } }, async () => 'test-key', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: engines, legs: [], resolveControls: () => ({ preset: 'custom', fetchServices: ['github'], mode: 'organize' }),
      resolveAddresses: async () => { throw new Error('must use GitHub content API'); } });
    const output = await provider.fetch({ url: 'https://github.com/owner/repo/blob/main/README.md' });
    expect(output.body.content).toContain('Body');
    expect(output.body.content).toContain('github');
    expect(server.requests[0]?.url).toBe('/repos/owner/repo/contents/README.md?ref=main');
  });

  it.each([{ enabled: false }, { staticDomains: ['github.com'] }])('GitHub blob 保留显式 HTTP 路由配置 %j', async route => {
    const engines = createAdditionalEngines({ github: {} }, async () => 'test-key', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: engines, route,
      resolveAddresses: async () => { throw new Error('explicit HTTP route'); } });
    await expect(provider.fetch({ url: 'https://github.com/owner/repo/blob/main/README.md' })).rejects.toThrow('explicit HTTP route');
  });

  it('AIHOT 无需凭证，保留原文、canonical、署名与截断信号', async () => {
    server = await startMockServer((_request, response) => {
      response.end(JSON.stringify({ ...(searchPayloads.aihot as object), page: { hasMore: true } }));
    });
    const engine = createAdditionalEngines({ aihot: { baseURL: server.url } }, async () => { throw new Error('must not resolve'); }, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    const result = await engine.search({ query: ' DeepSeek ', maxResults: 2 });
    expect(result.truncated).toBe(true);
    expect(result.sources[0]?.url).toBe(target);
    expect(result.sources[0]?.snippet).toContain('Publisher');
    expect(result.sources[0]?.snippet).toContain('https://aihot.news/items/sample');
    expect(result.sources[0]?.snippet).toContain('数据归属：AIHOT https://aihot.news');
    expect(result.sources[0]?.publishedAt).toBeUndefined();
    const query = new URL(server.requests[0]!.url, server.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ mode: 'all', window: '7d', q: 'DeepSeek', limit: '2' });
    expect(engine.extract).toBeUndefined();
  });

  it('AIHOT 缓存遵守 TTL，过期用 ETag 验证，已取消请求不读缓存', async () => {
    server = await startMockServer((request, response) => {
      response.setHeader('cache-control', 'public, max-age=60');
      response.setHeader('etag', '"version-1"');
      if (request.headers['if-none-match'] === '"version-1"') { response.statusCode = 304; response.end(); }
      else response.end(JSON.stringify(searchPayloads.aihot));
    });
    const engine = createAdditionalEngines({ aihot: { baseURL: server.url } }, async () => undefined, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    const first = await engine.search({ query: 'DeepSeek' });
    expect(await engine.search({ query: 'DeepSeek' })).toEqual(first);
    expect(server.requests).toHaveLength(1);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      expect(await engine.search({ query: 'DeepSeek' })).toEqual(first);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]!.headers['if-none-match']).toBe('"version-1"');
      const controller = new AbortController(); controller.abort();
      await expect(engine.search({ query: 'DeepSeek' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' });
    } finally { clock.mockRestore(); }
  });

  it('AIHOT 按上游 no-store 指令不保留结果', async () => {
    server = await startMockServer((_request, response) => { response.setHeader('cache-control', 'no-store'); response.end(JSON.stringify(searchPayloads.aihot)); });
    const engine = createAdditionalEngines({ aihot: { baseURL: server.url } }, async () => undefined, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    await engine.search({ query: 'DeepSeek' }); await engine.search({ query: 'DeepSeek' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.headers['if-none-match']).toBeUndefined();
  });

  it('AIHOT 不把短查询或超长查询改写为无关的宽泛资讯', async () => {
    const engine = createAdditionalEngines({ aihot: {} }, async () => undefined, { searchTimeoutMs: 500, fetchTimeoutMs: 500, fetchImpl: async () => { throw new Error('must not dispatch'); } })[0]!;
    for (const query of ['A', '😀'.repeat(201)]) await expect(engine.search({ query })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });

  it('AIHOT 503 按 Retry-After 熔断，不返回缓存旧数据', async () => {
    let failed = false;
    server = await startMockServer((_request, response) => {
      if (failed) { response.statusCode = 503; response.setHeader('retry-after', '60'); response.end(); }
      else { response.setHeader('cache-control', 'max-age=60'); response.end(JSON.stringify(searchPayloads.aihot)); }
    });
    const engine = createAdditionalEngines({ aihot: { baseURL: server.url } }, async () => undefined, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    await engine.search({ query: 'DeepSeek' });
    failed = true;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      try { await engine.search({ query: 'DeepSeek' }); throw new Error('expected failure'); }
      catch (error) { expect(readSearchFailureSignal(error)).toMatchObject({ kind: 'rate-limit', retryAfterMs: 60_000 }); }
      expect(server.requests).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  it('Bing 无需凭证，解析实体、CDATA，保留原始查询并限制结果数', async () => {
    server = await startMockServer((_request, response) => {
      response.end('<rss><channel><item><title><![CDATA[标题 <示例>]]></title><link>https://example.com/?a=1&amp;b=2</link><description>A &amp; B</description></item><item><title>Second</title><link>https://example.com/second</link></item></channel></rss>');
    });
    const engine = createAdditionalEngines({ bing: { baseURL: server.url } }, async () => { throw new Error('must not resolve credentials'); }, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    const result = await engine.search({ query: '中文 & query', maxResults: 1 });
    expect(result).toMatchObject({ sources: [{ url: 'https://example.com/?a=1&b=2', title: '标题 <示例>', snippet: 'A & B' }], truncated: true });
    expect(new URL(server.requests[0]!.url, server.url).searchParams.get('q')).toBe('中文 & query');
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(server.requests[0]!.headers['x-api-key']).toBeUndefined();
  });

  it.each(['<html><body>challenge</body></html>', '<rss><channel>', '<!DOCTYPE rss [<!ENTITY a "secret">]><rss><channel/></rss>'])('Bing 拒绝非 RSS、截断 XML 与 DTD', async payload => {
    server = await startMockServer((_request, response) => { response.end(payload); });
    const engine = createAdditionalEngines({ bing: { baseURL: server.url } }, async () => undefined, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    await expect(engine.search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });

  it('文本响应限大小；提取服务不能悄悄接受错误形状', async () => {
    let payload = 'x'.repeat(1_000_001);
    server = await startMockServer((_request, response) => { response.end(payload); });
    const http = new EngineHttp({ id: 'serply', baseURL: server.url, auth: 'x-api-key', resolveApiKey: async () => 'test-secret', timeoutMs: 500 });
    await expect(http.callText('/v1/request', {})).rejects.toMatchObject({ code: 'WEB_FETCH_TOO_LARGE' });
    payload = JSON.stringify({ results: [], errors: [{ url: target, code: 'timeout' }] });
    const engine = createAdditionalEngines({ tinyfish: { baseURL: server.url, fetchBaseURL: server.url } }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    await expect(engine.extract!(target)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });

  it('文本流挂起时限时仍有效，调用方取消优先', async () => {
    const client = new EngineHttp({ id: 'bing', baseURL: 'https://cn.bing.com', auth: 'none', resolveApiKey: async () => undefined, timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
    });
    await expect(client.callText('/search', undefined)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    const controller = new AbortController();
    const pending = client.callText('/search', undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' });
  });

  it.each(ids)('%s：请求进入正确接口、凭证只进请求头、结果归一', async id => {
    server = await startMockServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(id === 'bing' ? String(searchPayloads[id]) : JSON.stringify(searchPayloads[id]));
    });
    const engine = createAdditionalEngines({ [id]: { baseURL: server.url, fetchBaseURL: server.url } }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    expect(await engine.search({ query: 'sample query', maxResults: 2 })).toMatchObject({ sources: [{ url: target, title: 'Title', snippet: id === 'aihot' ? expect.stringContaining('Snippet') : 'Snippet' }] });
    const request = server.requests[0]!;
    const paths: Record<AdditionalEngineId, string> = { kimi: '/v1/tools/search_pro', tavily: '/search', exa: '/search', keenable: '/v1/search', crawl4ai: '/search', github: '/search/repositories', qianfan: '/v2/ai_search/web_search', doubao: '/search_api/web_search', firecrawl: '/v2/search', tinyfish: '/', serply: '/v1/search/', bing: '/search', aihot: '/api/v1/items' };
    expect(new URL(request.url, server.url).pathname).toBe(paths[id]);
    const headerAuth = ['exa', 'keenable', 'tinyfish', 'serply'].includes(id);
    expect(request.headers[headerAuth ? 'x-api-key' : 'authorization']).toBe(['bing', 'aihot'].includes(id) ? undefined : headerAuth ? 'test-secret' : 'Bearer test-secret');
    if (['bing', 'aihot'].includes(id)) expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.url + request.body).not.toContain('test-secret');
    if (id === 'github') expect(new URL(request.url, server.url).searchParams.get('q')).toBe('sample query is:public');
    if (id === 'qianfan') expect(JSON.parse(request.body)).toMatchObject({ search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: 2 }] });
  });

  it.each(Object.keys(fetchPayloads) as AdditionalEngineId[])('%s：提取正文、保留目标站状态', async id => {
    server = await startMockServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(id === 'serply' ? String(fetchPayloads[id]) : JSON.stringify(fetchPayloads[id]));
    });
    const refs: string[] = [];
    const engine = createAdditionalEngines({ [id]: { baseURL: server.url, fetchBaseURL: server.url } }, async ref => { refs.push(ref); return 'test-secret'; }, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
    const url = id === 'github' ? 'https://github.com/owner/repo' : target;
    const result = await engine.extract!(url);
    expect(result.body.content).toContain('Body');
    expect(result.statusCode).toBe(id === 'doubao' ? 404 : 200);
    if (id === 'doubao') expect(refs).toEqual(['DOUBAO_FETCH_API_KEY']);
    if (id === 'exa') expect(JSON.parse(server.requests[0]!.body)).toMatchObject({ maxAgeHours: 0, text: true });
    if (id === 'keenable') expect(new URL(server.requests[0]!.url, server.url).searchParams.get('live')).toBe('true');
    if (id === 'github') expect(server.requests[0]!.url).toBe('/repos/owner/repo/readme');
  });

  it('HTTP 429、402、GitHub 配额 403 进入同一熔断词表；错误正文不泄露凭证', async () => {
    server = await startMockServer((request, response) => {
      response.statusCode = request.url === '/limited' ? 429 : request.url === '/quota' ? 402 : 403;
      response.setHeader('retry-after', '7');
      response.setHeader('x-ratelimit-remaining', '0');
      response.end('test-secret');
    });
    const client = new EngineHttp({ id: 'github', baseURL: server.url, auth: 'bearer', resolveApiKey: async () => 'test-secret', timeoutMs: 500 });
    for (const [path, kind] of [['/limited', 'rate-limit'], ['/quota', 'insufficient-credits'], ['/github-limit', 'rate-limit']]) {
      try { await client.call(path!, undefined); throw new Error('expected failure'); }
      catch (error) {
        expect(error).toBeInstanceOf(WebError);
        expect(readSearchFailureSignal(error)?.kind).toBe(kind);
        expect(String(error)).not.toContain('test-secret');
      }
    }
  });

  it('凭证或 HTTP 挂起时仍遵守限时，调用方取消优先', async () => {
    const resolveApiKey = () => new Promise<string | undefined>(() => undefined);
    const client = new EngineHttp({ id: 'tavily', baseURL: 'https://api.tavily.com', auth: 'bearer', resolveApiKey, timeoutMs: 20 });
    await expect(client.call('/search', {})).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    const hungHttp = new EngineHttp({ id: 'tavily', baseURL: 'https://api.tavily.com', auth: 'bearer', resolveApiKey: async () => 'test-secret', timeoutMs: 20, fetchImpl: async () => new Promise<Response>(() => undefined) });
    await expect(hungHttp.call('/search', {})).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    const controller = new AbortController();
    const pending = client.call('/search', {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' });
  });

  it('HTTP 200 的业务失败和形状错误不能作为成功候选', async () => {
    let payload: unknown = { ResponseMetadata: { Error: { Code: 'Denied' } }, Result: { WebResults: [] } };
    server = await startMockServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload)); });
    const engines = createAdditionalEngines({ doubao: { baseURL: server.url }, tavily: { baseURL: server.url } }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    await expect(engines[0]!.search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    payload = { results: 'invalid' };
    await expect(engines[1]!.search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    payload = { results: [], failed_results: [{ url: target, error: 'not found' }] };
    await expect(engines[1]!.extract!(target)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });

  it('GitHub 只对仓库与文件 URL 添加提取路，拒绝伪域名与坏转义', () => {
    expect(githubPath('https://github.com/a/b')).toEqual({ path: '/repos/a/b/readme' });
    expect(githubPath('https://github.com/a/b/blob/main/docs/read%20me.md')?.path).toBe('/repos/a/b/contents/docs/read%20me.md');
    for (const url of ['https://github.com.evil/a/b', 'https://github.com@evil/a/b', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/blob/main/%']) expect(githubPath(url)).toBeUndefined();
  });
});

describe('新增引擎进入聚合', () => {
  it('全部扩展搜索引擎并发参与 RRF，相同 URL 去重', async () => {
    const pendingResponses: (() => void)[] = [];
    server = await startMockServer((request, response) => {
      const id = request.url.split('/')[1] as AdditionalEngineId;
      pendingResponses.push(() => { response.setHeader('content-type', 'application/json'); response.end(id === 'bing' ? String(searchPayloads[id]) : JSON.stringify(searchPayloads[id])); });
      if (pendingResponses.length === ids.length) pendingResponses.forEach(reply => reply());
    });
    const config = Object.fromEntries(ids.map(id => [id, { baseURL: `${server!.url}/${id}` }]));
    const engines = createAdditionalEngines(config, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedSearchProvider({ engines, breaker: new CircuitBreaker(), zhihuQuotaCheck: false, maxFanoutMs: 500 });
    expect((await provider.search({ query: 'query' })).sources).toHaveLength(1);
    expect(server.requests).toHaveLength(ids.length);
  });

  it('入口配置真正接入搜索与提取；未配置引擎不派发', async () => {
    server = await startMockServer((request, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.url === '/search' ? searchPayloads.tavily : fetchPayloads.tavily));
    });
    let search!: WebSearchProvider;
    let fetch!: WebFetchProvider;
    const log = { info() {}, warn() {}, error() {} };
    const ctx = { web: { registerSearchProvider: (value: WebSearchProvider) => { search = value; }, registerFetchProvider: (value: WebFetchProvider) => { fetch = value; } }, credentials: { resolve: async (ref: string) => ref === 'MY_TAVILY' ? { value: 'test-secret' } : undefined }, tools: { register() {} }, logger: () => log } as unknown as Context;
    apply(ctx, Config({ controls: { preset: 'custom' }, engines: { tavily: { baseURL: server.url, apiKeyEnv: 'MY_TAVILY' }, exa: { enabled: false } }, search: { rerank: false, zhihuQuotaCheck: false } }));
    expect((await search.search({ query: 'query' })).sources[0]!.url).toBe(target);
    expect((await fetch.fetch({ url: target })).body.content).toContain('Body');
    expect(server.requests.map(request => request.url)).toEqual(['/search', '/extract']);
  });

  it('不向普通网页派发 GitHub 内容请求', async () => {
    const github = createAdditionalEngines({ github: {} }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
    const provider = new AggregatedFetchProvider({ additionalEngines: github });
    await expect(provider.fetch({ url: target })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });
});
