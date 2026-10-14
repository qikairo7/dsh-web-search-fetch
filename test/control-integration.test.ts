import { expect, it } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import WebRuntime from '@deepseek-ai/dsh-web';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import * as plugin from '../src/index.js';
import { startMockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';
import { readFixtureText } from './helpers/fixtures.js';

const fixtureRefs = ['TAVILY_API_KEY', 'EXA_API_KEY', 'ZHIPU_API_KEY', 'ZHIHU_ACCESS_SECRET', 'SILICONFLOW_API_KEY', 'DOUBAO_FETCH_API_KEY'];

class Credentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials'); }
  async resolve(ref: string) { return fixtureRefs.includes(String(ref)) ? { value: 'fixture', source: 'test' } : undefined; }
  async describe(ref: string) { return { configured: fixtureRefs.includes(String(ref)), writable: true }; }
}

it('native tools organize both extracts, apply live controls and respect actual HTTP permits', async () => {
  const url = 'https://example.com/guide';
  const server = await startMockServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.includes('doubao')) {
      response.end(JSON.stringify({ ResponseMetadata: {}, Result: { Data: { Url: url, ContentText: '# Guide\n\nOnly doubao.', StatusCode: 200 } } }));
      return;
    }
    const exa = path.startsWith('/exa');
    const content = `# Guide\n\nShared.\n\nOnly ${exa ? 'exa' : 'tavily'}.`;
    response.end(JSON.stringify({ results: [{ url, title: 'Guide', content: 'snippet', text: content, raw_content: content }] }));
  });
  const ctx = new Context();
  const fibers = [];
  try {
    for (const component of [SystemPrompt, ToolRuntime, WebRuntime, Credentials]) fibers.push(await ctx.plugin(component));
    fibers.push(await ctx.plugin(ToolWeb, { fetch: true, search: true }));
    const config = plugin.Config({
      engines: { tavily: { baseURL: `${server.url}/tavily` }, exa: { baseURL: `${server.url}/exa` }, doubao: { baseURL: `${server.url}/doubao`, apiKeyEnv: 'MISSING_SEARCH_REF' } },
      controls: { searchServices: ['tavily', 'exa'], fetchServices: ['tavily', 'exa'] },
      search: { rerank: false, zhihuQuotaCheck: false },
    });
    let controls = config.controls!.get()!;
    config.controls = { get: () => controls } as typeof config.controls;
    fibers.push(await ctx.plugin({ name: 'controlled-integration', inject: ['web', 'credentials'], apply: (host: Context) => plugin.apply(host, config) }));
    const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(name), signal: AbortSignal.timeout(5000) });
    const fetched = await execute('web_fetch', { url });
    expect(fetched.isError).toBeFalsy();
    expect(JSON.stringify(fetched)).toContain('Only tavily.');
    expect(JSON.stringify(fetched)).toContain('Only exa.');
    expect(server.requests).toHaveLength(2);
    controls = { ...controls, mode: 'select', maxFetchServices: 1 };
    const single = await execute('web_fetch', { url });
    expect(single.isError).toBeFalsy();
    expect(JSON.stringify(single)).toContain('Only tavily.');
    expect(JSON.stringify(single)).not.toContain('Only exa.');
    expect(server.requests).toHaveLength(3);
    controls = { ...controls, maxRequests: 1 };
    const searched = await execute('web_search', { queries: ['sample'] });
    expect(searched.isError).toBeFalsy();
    expect(JSON.stringify(searched)).toContain('请求预算');
    expect(server.requests).toHaveLength(4);
    controls = { ...controls, mode: 'organize', fetchServices: ['doubao'] };
    const independentFetch = await execute('web_fetch', { url });
    expect(independentFetch.isError).toBeFalsy();
    expect(JSON.stringify(independentFetch)).toContain('Only doubao.');
    expect(server.requests).toHaveLength(5);
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name).sort()).toEqual(['web_fetch', 'web_search']);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await server.close();
  }
});

it('shares the HTTP budget with Zhipu fallback, Zhihu quota and optional reranking', async () => {
  const server = await startMockServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    response.end(path.includes('zhipu') ? JSON.stringify({ content: [] })
      : readFixtureText(path.includes('quota') ? 'zhihu-quota-response.json' : 'zhihu-global-search-response.json'));
  });
  const ctx = new Context();
  const fibers = [];
  try {
    for (const component of [SystemPrompt, ToolRuntime, WebRuntime, Credentials]) fibers.push(await ctx.plugin(component));
    fibers.push(await ctx.plugin(ToolWeb, { search: true }));
    const config = plugin.Config({
      controls: { searchServices: ['zhipu'], maxRequests: 1 },
      search: { zhipuAnthropicBaseURL: `${server.url}/zhipu`, zhihuBaseURL: `${server.url}/search`, zhihuQuotaURL: `${server.url}/quota`, rerankBaseURL: `${server.url}/rerank` },
    });
    let controls = config.controls!.get()!;
    config.controls = { get: () => controls } as typeof config.controls;
    fibers.push(await ctx.plugin({ name: 'budget-integration', inject: ['web', 'credentials'], apply: (host: Context) => plugin.apply(host, config) }));
    const execute = () => ctx.tools.execute({ name: 'web_search', arguments: { queries: ['fixture'] }, callId: ToolCallId('budget'), signal: AbortSignal.timeout(5000) });
    const fallback = await execute();
    expect(fallback.isError).toBe(true);
    expect(server.requests).toHaveLength(1); // Non-SSE response would otherwise dispatch a second request.
    controls = { ...controls, searchServices: ['zhihu'], maxRequests: 2 };
    const searched = await execute();
    expect(searched.isError).toBeFalsy();
    expect(server.requests).toHaveLength(3); // Quota + search; rerank is refused before HTTP.
    expect(server.requests.filter(request => request.url.includes('quota'))).toHaveLength(1);
    expect(server.requests.filter(request => request.url.includes('rerank'))).toHaveLength(0);
    expect(JSON.stringify(searched)).toContain('请求预算');
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await server.close();
  }
});
