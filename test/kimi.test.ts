import { afterEach, expect, it } from 'vitest';
import { createAdditionalEngines } from '../src/engines/additional/index.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';
let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

it.each(['basic', 'pro'] as const)('Kimi %s: one REST call, bounded excerpts and original query', async mode => {
  server = await startMockServer((_request, response) => { response.end(JSON.stringify({ search_results: [
    { url: 'https://example.com/a', title: 'Example', site_name: 'Publisher', authority: 'S', date: '2026-10-01', snippet: 'Summary', ...(mode === 'pro' ? { chunks: [{ text: 'Relevant excerpt', score: 1 }, { text: 'x'.repeat(9000), score: 0.5 }] } : {}) },
  ] })); });
  const refs: string[] = [];
  const engine = createAdditionalEngines({ kimi: { baseURL: server.url, searchMode: mode } }, async ref => { refs.push(ref); return 'test-secret'; }, { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
  const result = await engine.search({ query: '中文 original query', maxResults: 100 });
  expect(server.requests).toHaveLength(1);
  expect(server.requests[0]!.url).toBe(mode === 'basic' ? '/v1/tools/search' : '/v1/tools/search_pro');
  expect(JSON.parse(server.requests[0]!.body)).toEqual({ text_query: '中文 original query', limit: 20, timeout_seconds: 10, ...(mode === 'basic' ? { include_content: false } : {}) });
  expect(refs).toEqual(['MOONSHOT_API_KEY']);
  expect(result.sources[0]).toMatchObject({ url: 'https://example.com/a', publishedAt: '2026-10-01' });
  expect(result.sources[0]!.snippet).toContain('来源：Publisher');
  expect(result.sources[0]!.snippet).toContain('Kimi 来源等级：S');
  if (mode === 'pro') { expect(result.sources[0]!.snippet).toContain('Relevant excerpt'); expect(result.sources[0]!.snippet).toHaveLength(6000); }
});

it('empty results are valid; Pro without chunks keeps the summary', async () => {
  let results: unknown[] = [];
  server = await startMockServer((_request, response) => { response.end(JSON.stringify({ search_results: results })); });
  const engine = createAdditionalEngines({ kimi: { baseURL: server.url } }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
  expect(await engine.search({ query: 'query' })).toEqual({ sources: [], truncated: false });
  results = [{ url: 'https://example.com/a', snippet: 'Only summary', chunks: [], date: '' }];
  expect((await engine.search({ query: 'query' })).sources).toEqual([{ url: 'https://example.com/a', snippet: 'Only summary' }]);
});

it('Kimi rejects business errors, invalid chunks and blank extraction, without echoing private error text', async () => {
  let payload: unknown = { error: { message: 'test-secret' } };
  server = await startMockServer((_request, response) => { response.end(JSON.stringify(payload)); });
  const engine = createAdditionalEngines({ kimi: { baseURL: server.url } }, async () => 'test-secret', { searchTimeoutMs: 500, fetchTimeoutMs: 500 })[0]!;
  await expect(engine.search({ query: 'query' })).rejects.toThrow('kimi: search rejected');
  await expect(engine.extract!('https://example.com')).rejects.toThrow('kimi: extraction rejected');
  payload = { search_results: [{ url: 'https://example.com/a', chunks: 'invalid' }] };
  await expect(engine.search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  payload = { url: 'https://example.com', title: 'Empty', markdown: '   ' };
  await expect(engine.extract!('https://example.com')).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
});
