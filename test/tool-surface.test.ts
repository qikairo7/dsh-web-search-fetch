import { expect, it } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import WebRuntime from '@deepseek-ai/dsh-web';
import * as plugin from '../src/index.js';
import { startMockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';

class TestCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials'); }
  async resolve(ref: string) {
    return ['TAVILY_API_KEY', 'TINYFISH_API_KEY', 'SERPLY_API_KEY', 'MOONSHOT_API_KEY'].includes(ref) ? { value: 'test-key', source: 'test' } : undefined;
  }
}

it.each(['tavily', 'tinyfish-serply-bing', 'aihot', 'kimi'])('%s：仅注入两个原生工具，通过聚合 provider 搜索和提取', async mode => {
  const server = await startMockServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const url = 'https://example.com/page';
    if (path === '/v1/tools/search_pro') { response.end(JSON.stringify({ search_results: [{ url, title: 'Example', snippet: 'Search snippet', chunks: [{ text: 'Relevant chunk', score: 1 }] }] })); return; }
    if (path === '/v1/tools/fetch') { response.end(JSON.stringify({ url, title: 'Example', markdown: 'Extracted body' })); return; }
    if (path === '/api/v1/items') { response.end(JSON.stringify({ schemaVersion: 1, items: [{ title: 'Example', summary: 'AIHOT snippet', source: { name: 'Publisher' }, links: { original: url, aihot: 'https://aihot.news/items/sample' } }], page: { hasMore: false } })); return; }
    if (path === '/api/v1/agent/hot') { response.end('# AIHOT 热点\n\n1. Test event — https://example.com/original'); return; }
    if (path === '/bing/search') {
      response.end(`<rss><channel><item><link>${url}</link><title>Example</title><description>Search snippet</description></item></channel></rss>`);
      return;
    }
    if (path === '/serply/v1/request') { response.end('Extracted body'); return; }
    if (path === '/serply/v1/search/') { response.end(JSON.stringify({ results: [{ link: url, title: 'Example', description: 'Search snippet' }] })); return; }
    if (path === '/tinyfish') {
      response.end(JSON.stringify({ results: [{ url, title: 'Example', ...(request.method === 'GET' ? { snippet: 'Search snippet' } : { text: 'Extracted body' }) }] }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [{ url: 'https://example.com/page', title: 'Example',
      ...(request.url === '/search' ? { content: 'Search snippet' } : { raw_content: 'Extracted body' }),
    }] }));
  });
  const ctx = new Context();
  const fibers = [];
  try {
    fibers.push(await ctx.plugin(SystemPrompt));
    fibers.push(await ctx.plugin(ToolRuntime));
    fibers.push(await ctx.plugin(WebRuntime, { searchProvider: 'aggregated', fetchProvider: 'aggregated' }));
    fibers.push(await ctx.plugin(TestCredentials));
    fibers.push(await ctx.plugin(ToolWeb, { search: true, fetch: true }));
    const before = await ctx.systemPrompt.assemble();
    fibers.push(await ctx.plugin(plugin, {
      controls: { preset: 'custom' },
      engines: mode === 'kimi' ? { kimi: { baseURL: server.url } } : mode === 'aihot' ? { aihot: { baseURL: server.url }, tavily: { baseURL: server.url } } : mode === 'tavily' ? { tavily: { baseURL: server.url } } : {
        tinyfish: { baseURL: `${server.url}/tinyfish`, fetchBaseURL: `${server.url}/tinyfish` },
        serply: { baseURL: `${server.url}/serply` }, bing: { baseURL: `${server.url}/bing` },
      },
      search: { rerank: false, quotaCheck: false },
    }));
    const after = await ctx.systemPrompt.assemble();
    expect(after.tools.map(tool => tool.name).sort()).toEqual(['web_fetch', 'web_search']);
    expect(after.tools).toEqual(before.tools);
    const search = await ctx.tools.execute({ name: 'web_search', arguments: { queries: ['sample'] }, callId: ToolCallId('search'), signal: AbortSignal.timeout(5000) });
    expect(search.isError).toBeFalsy();
    expect(search.meta).toMatchObject({ sources: [{ url: 'https://example.com/page' }] });
    const fetched = await ctx.tools.execute({ name: 'web_fetch', arguments: { url: 'https://example.com/page' }, callId: ToolCallId('fetch'), signal: AbortSignal.timeout(5000) });
    expect(fetched.isError).toBeFalsy();
    expect(JSON.stringify(fetched)).toContain('Extracted body');
    if (mode === 'tavily') expect(server.requests.map(request => request.url)).toEqual(['/search', '/extract']);
    else if (mode === 'kimi') expect(server.requests.map(request => request.url)).toEqual(['/v1/tools/search_pro', '/v1/tools/fetch']);
    else if (mode === 'aihot') {
      const api = await ctx.tools.execute({ name: 'web_fetch', arguments: { url: 'https://aihot.news/api/v1/agent/hot' }, callId: ToolCallId('api'), signal: AbortSignal.timeout(5000) });
      expect(api.isError).toBeFalsy();
      expect(JSON.stringify(api)).toContain('AIHOT 热点');
      expect(server.requests.map(request => new URL(request.url, server.url).pathname).sort()).toEqual(['/api/v1/items', '/search', '/extract', '/api/v1/agent/hot'].sort());
    }
    else expect(server.requests.map(request => new URL(request.url, server.url).pathname).sort()).toEqual(['/bing/search', '/serply/v1/request', '/serply/v1/search/', '/tinyfish', '/tinyfish'].sort());
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await server.close();
  }
});
