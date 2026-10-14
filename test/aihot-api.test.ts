import { afterEach, expect, it, vi } from 'vitest';
import { createAdditionalEngines } from '../src/engines/additional/index.js';
import { AggregatedFetchProvider } from '../src/fetch-pipeline.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';

let server: MockServer | undefined;
afterEach(async () => { vi.restoreAllMocks(); await server?.close(); server = undefined; });
function provider() {
  const additionalEngines = createAdditionalEngines({ aihot: { baseURL: server!.url } }, async () => { throw new Error('anonymous API must not resolve credentials'); }, { searchTimeoutMs: 500, fetchTimeoutMs: 500 });
  const paid = vi.fn(async () => { throw new Error('must not call paid extraction for an API'); });
  return { provider: new AggregatedFetchProvider({ additionalEngines, legs: [{ engineId: 'firecrawl', extract: paid }] }), paid };
}
const paths = [
  'items?category=tip&mode=all&window=24h&by=published&q=DeepSeek&limit=2&cursor=opaque%2B%2F%3D',
  'hot-topics', 'stories/from-hot-result', 'codex-resets/recent', 'codex-resets',
  'dailies', 'dailies/latest', 'dailies/2026-09-30', 'weeklies', 'weeklies/latest', 'weeklies/2026-W39',
  'monthlies', 'monthlies/latest', 'monthlies/2026-09',
  'selected/snapshot?fields=minimal&limit=2&page=opaque-page', 'selected/changes?cursor=opaque-cursor&limit=2',
  'agent', 'agent/latest?category=paper', 'agent/search?q=DeepSeek', 'agent/hot', 'agent/stories/from-hot-result',
  'agent/daily', 'agent/daily/2026-09-30', 'agent/weekly', 'agent/weekly/2026-W39',
  'agent/monthly', 'agent/monthly/2026-09', 'agent/codex-resets',
];
it.each(paths)('native fetch routes complete AIHOT API: %s', async path => {
  const json = { schemaVersion: 1, report: { title: 'Test report', references: [{ original: 'https://example.com/original' }] },
    attribution: { name: 'AIHOT', url: 'https://aihot.news' }, cursor: 'opaque+/=', hasMore: true, nextPage: 'next',
    changes: [{ op: 'remove', id: 'withdrawn' }, { op: 'upsert', item: { publishedAt: null, discoveredAt: '2026-10-01' } }] };
  server = await startMockServer((request, response) => {
    response.end(request.url.startsWith('/api/v1/agent') ? '# AIHOT\n\n[原文](https://example.com/original)' : JSON.stringify(json));
  });
  const { provider: fetcher, paid } = provider();
  const result = await fetcher.fetch({ url: `https://aihot.news/api/v1/${path}` });
  expect(result.statusCode).toBe(200);
  expect(result.truncated).toBe(false);
  expect(result.body?.kind).toBe('text');
  if (result.body?.kind === 'text') {
    if (path.startsWith('agent')) expect(result.body.content).toContain('[原文]');
    else expect(JSON.parse(result.body.content)).toEqual(json);
  }
  expect(paid).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1); // no implicit pagination, history scan or sync writes
  expect(server.requests[0]?.headers['accept-encoding']).toContain('gzip');
  const requested = new URL(server.requests[0]!.url, server.url);
  const expected = new URL(`https://aihot.news/api/v1/${path}`);
  expect(requested.pathname).toBe(expected.pathname);
  expected.searchParams.forEach((value, key) => expect(requested.searchParams.get(key)).toBe(value));
});

it('historical report revalidates ETag and replaces withdrawn references, never stale fallback', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let stage = 0;
  server = await startMockServer((_request, response) => {
    response.setHeader('etag', `"${stage}"`);
    response.setHeader('cache-control', 'max-age=60');
    if (stage === 1) response.statusCode = 304;
    if (stage === 3) response.statusCode = 503;
    response.end(stage === 1 || stage === 3 ? undefined : JSON.stringify({ schemaVersion: 1, report: { references: stage === 2 ? [] : ['withdrawn'] } }));
  });
  const { provider: fetcher } = provider();
  const request = { url: 'https://aihot.news/api/v1/dailies/2026-09-30' };
  expect(JSON.stringify(await fetcher.fetch(request))).toContain('withdrawn');
  await fetcher.fetch(request);
  expect(server.requests).toHaveLength(1);
  now += 60_001; stage = 1;
  expect(JSON.stringify(await fetcher.fetch(request))).toContain('withdrawn');
  expect(server.requests[1]?.headers['if-none-match']).toBe('"0"');
  now += 60_001; stage = 2;
  expect(JSON.stringify(await fetcher.fetch(request))).not.toContain('withdrawn');
  now += 60_001; stage = 3;
  await expect(fetcher.fetch(request)).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
});

it.each(['codex-resets', 'codex-resets/recent', 'agent/codex-resets'])('resets respect ten-minute cache: %s', async path => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  server = await startMockServer((_request, response) => { response.setHeader('etag', '"v1"'); response.end(path.startsWith('agent') ? '# resets' : '{"schemaVersion":1,"events":[]}'); });
  const { provider: fetcher } = provider();
  const request = { url: `https://aihot.news/api/v1/${path}` };
  await fetcher.fetch(request); now += 60_001; await fetcher.fetch(request);
  expect(server.requests).toHaveLength(1);
  now += 540_000; await fetcher.fetch(request);
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]?.headers['if-none-match']).toBe('"v1"');
});

it('API Retry-After suppresses immediate retries across different URLs', async () => {
  server = await startMockServer((_request, response) => { response.statusCode = 429; response.setHeader('retry-after', '120'); response.end(); });
  const { provider: fetcher } = provider();
  for (const path of ['hot-topics', 'dailies/latest']) await expect(fetcher.fetch({ url: `https://aihot.news/api/v1/${path}` })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  expect(server.requests).toHaveLength(1);
});

it.each(['https://aihot.news/api/v1/items/123', 'https://aihot.news/api/v1/admin', 'https://user@aihot.news/api/v1/items', 'http://aihot.news/api/v1/items', 'https://aihot.news:8443/api/v1/items'])('rejects unsupported AIHOT API without dispatch: %s', async url => {
  server = await startMockServer((_request, response) => { response.end('{}'); });
  const { provider: fetcher, paid } = provider();
  await expect(fetcher.fetch({ url })).rejects.toMatchObject({ code: 'WEB_INVALID_URL' });
  expect(server.requests).toHaveLength(0); expect(paid).not.toHaveBeenCalled();
});

it('oversized sync data is rejected instead of losing its cursor through truncation', async () => {
  server = await startMockServer((_request, response) => { response.end(JSON.stringify({ schemaVersion: 1, items: ['x'.repeat(100_001)], cursor: 'next' })); });
  const { provider: fetcher } = provider();
  await expect(fetcher.fetch({ url: 'https://aihot.news/api/v1/selected/snapshot' })).rejects.toMatchObject({ code: 'WEB_FETCH_TOO_LARGE' });
});
