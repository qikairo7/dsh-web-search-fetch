import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it, vi } from 'vitest';
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

const fixtureRefs = ['TAVILY_API_KEY', 'EXA_API_KEY', 'ZHIPU_API_KEY', 'SILICONFLOW_API_KEY'];

class Credentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials'); }
  async resolve(ref: string) { return fixtureRefs.includes(String(ref)) ? { value: 'fixture', source: 'test' } : undefined; }
  async describe(ref: string) { return { configured: fixtureRefs.includes(String(ref)), writable: true }; }
}

it('native tools organize both extracts, apply live controls and respect actual HTTP permits', async () => {
  const url = 'https://example.com/guide';
  const server = await startMockServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
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
      engines: { tavily: { baseURL: `${server.url}/tavily` }, exa: { baseURL: `${server.url}/exa` } },
      controls: { preset: 'custom', searchServices: ['tavily', 'exa'], fetchServices: ['tavily', 'exa'] },
      search: { rerank: false, quotaCheck: false },
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
    expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name).sort()).toEqual(['web_fetch', 'web_search']);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await server.close();
  }
});

class AnonymousCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials'); }
  async resolve() { return undefined; }
  async describe() { return { configured: false, writable: true }; }
}

it('固定预设在无凭证时派发三家推荐服务', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
    const target = 'https://example.com/guide';
    const body = '# Guide\n\nShared.\n\nFrom ' + new URL(url).hostname;
    if (url.includes('anysearch')) return Response.json({ code: 0, message: 'success', data: url.endsWith('/search')
      ? { results: [{ url: target, title: 'Guide' }], metadata: { total_results: 1, search_time_ms: 1 } }
      : { url: target, title: 'Guide', content: body } });
    if (url.includes('firecrawl')) return Response.json(url.endsWith('/search')
      ? { success: true, data: { web: [{ url: target, title: 'Guide' }] } }
      : { success: true, data: { markdown: body, metadata: { sourceURL: target, title: 'Guide' } } });
    if (url.includes('tavily')) return Response.json({ results: [{ url: target, title: 'Guide', content: 'Snippet', raw_content: body }] });
    throw new Error('Unexpected service');
  });
  const ctx = new Context(), fibers = [];
  try {
    for (const component of [SystemPrompt, ToolRuntime, WebRuntime, AnonymousCredentials]) fibers.push(await ctx.plugin(component));
    fibers.push(await ctx.plugin(ToolWeb, { search: true, fetch: true }));
    const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
    const config = plugin.Config({ ...bundle[1].insert[0].config, controls: { ...bundle[1].insert[0].config.controls, preset: 'custom' } });
    fibers.push(await ctx.plugin({ name: 'anonymous-starter', inject: ['web', 'credentials'], apply: (host: Context) => plugin.apply(host, config) }));
    const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(name), signal: AbortSignal.timeout(5000) });
    expect((await execute('web_search', { queries: ['Example'] })).isError).toBeFalsy();
    expect(calls).toHaveLength(3);
    const fetched = await execute('web_fetch', { url: 'https://example.com/guide' });
    expect(fetched.isError).toBeFalsy();
    for (const name of ['anysearch', 'firecrawl', 'tavily']) expect(JSON.stringify(fetched)).toContain(name);
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.headers.has('authorization')).toBe(false);
      expect(call.headers.get('x-tavily-access-mode')).toBe(call.url.includes('tavily') ? 'keyless' : null);
    }
  } finally { for (const fiber of fibers.reverse()) await fiber.dispose(); mock.mockRestore(); }
});
