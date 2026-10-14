import { expect, it, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import WebRuntime from '@deepseek-ai/dsh-web';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import * as plugin from '../src/index.js';
import { FirecrawlClient } from '../src/engines/firecrawl/client.js';
import { isFirecrawlKeylessEndpoint } from '../src/engines/firecrawl/wire.js';
import { createAdditionalEngines } from '../src/engines/additional/index.js';

const url = 'https://example.com/guide';
const scrape = () => new Response(JSON.stringify({ success: true, data: { markdown: '# Guide\n\nOriginal body.', metadata: { statusCode: 200, sourceURL: url } } }));
const search = () => new Response(JSON.stringify({ success: true, data: { web: [{ url, title: 'Guide', description: 'Original snippet.' }] } }));

it('uses anonymous official search and scrape without sending an authorization header', async () => {
  const requests: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(init!);
    expect(new URL(String(input)).origin).toBe('https://api.firecrawl.dev');
    return String(input).endsWith('/search') ? search() : scrape();
  };
  const engines = createAdditionalEngines({ firecrawl: {} }, async () => undefined, { searchTimeoutMs: 1000, fetchTimeoutMs: 1000, fetchImpl });
  expect((await engines[0]!.search({ query: 'fixture' })).sources).toHaveLength(1);
  const client = new FirecrawlClient({ resolveApiKey: async () => undefined, credentialName: 'FIRECRAWL_API_KEY', fetchImpl });
  expect((await client.scrape(url)).body.content).toContain('Original body.');
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(new Headers(request.headers).has('authorization')).toBe(false);
});

it('keeps configured keys and rejects anonymous custom endpoints before dispatch', async () => {
  let sent = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent++;
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer configured-key');
    return scrape();
  };
  const keyed = new FirecrawlClient({ resolveApiKey: async () => 'configured-key', credentialName: 'REF', fetchImpl });
  await keyed.scrape(url);
  const custom = new FirecrawlClient({ resolveApiKey: async () => undefined, credentialName: 'REF', baseURL: 'https://custom.test/v2/scrape', fetchImpl });
  await expect(custom.scrape(url)).rejects.toThrow('not configured');
  const engines = createAdditionalEngines({ firecrawl: { baseURL: 'https://custom.test' } }, async () => undefined, { searchTimeoutMs: 1000, fetchTimeoutMs: 1000, fetchImpl });
  await expect(engines[0]!.search({ query: 'fixture' })).rejects.toThrow('not configured');
  expect(sent).toBe(1);
});

it('restricts keyless eligibility to exact official operations', () => {
  for (const endpoint of ['https://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/scrape']) expect(isFirecrawlKeylessEndpoint(endpoint)).toBe(true);
  for (const endpoint of ['http://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev.evil.test/v2/search', 'https://user@api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/search?token=x', 'https://api.firecrawl.dev/v2/batch/scrape', 'invalid']) expect(isFirecrawlKeylessEndpoint(endpoint)).toBe(false);
});

class NoCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentials'); }
  async resolve() { return undefined; }
  async describe() { return { configured: false, writable: true }; }
}

it('makes native tools usable with zero configured credentials despite readiness filtering', async () => {
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new URL(String(input)).origin).toBe('https://api.firecrawl.dev');
    return String(input).endsWith('/search') ? search() : scrape();
  });
  const ctx = new Context();
  const fibers = [];
  try {
    for (const component of [SystemPrompt, ToolRuntime, WebRuntime, NoCredentials]) fibers.push(await ctx.plugin(component));
    fibers.push(await ctx.plugin(ToolWeb, { search: true, fetch: true }));
    fibers.push(await ctx.plugin(plugin, {
      engines: { firecrawl: {} }, controls: { searchServices: ['firecrawl'], fetchServices: ['firecrawl'] },
      search: { rerank: false, zhihuQuotaCheck: false },
    }));
    const invoke = (name: string, args: Record<string, unknown>) => ctx.tools.execute({ name, arguments: args, callId: ToolCallId(name), signal: AbortSignal.timeout(5000) });
    const searched = await invoke('web_search', { queries: ['fixture'] });
    expect(searched.isError).toBeFalsy();
    expect(searched.meta).toMatchObject({ sources: [{ url }] });
    const fetched = await invoke('web_fetch', { url });
    expect(fetched.isError).toBeFalsy();
    expect(JSON.stringify(fetched)).toContain('Original body.');
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    transport.mockRestore();
  }
});
