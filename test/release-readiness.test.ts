import { expect, it } from 'vitest';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { CircuitBreaker } from '../src/breaker/index.js';
import { AggregatedFetchProvider } from '../src/fetch-pipeline.js';
import { organizeDocuments } from '../src/fetch-document/organize.js';
import { AggregatedSearchProvider } from '../src/search-aggregate.js';
import { budgetedFetch, requestCount, runOperation } from '../src/request-budget.js';
import { startMockServer } from './helpers/mock-server.js';

const url = 'https://example.com/guide';
const body = (content: string, extra: Partial<WebFetchResult> = {}): WebFetchResult => ({
  url, statusCode: 200, body: { kind: 'text', content }, truncated: false, ...extra,
});
const candidate = (content: string, extra: Partial<WebFetchResult> = {}) => ({ engineId: 'fixture', result: body(content, extra) });

it('returns completed extracts when the total deadline stops an unresponsive lane', async () => {
  const provider = new AggregatedFetchProvider({
    resolveControls: () => ({ fetchDeadlineMs: 30 }),
    legs: [
      { engineId: 'fast', extract: async () => body('# Guide\n\nAvailable content.') },
      { engineId: 'hung', extract: () => new Promise(() => {}) },
    ],
  });
  const output = await provider.fetch({ url });
  expect(output.body.content).toContain('Available content.');
  expect(output.body.content).toContain('总限时');
  expect(output.truncated).toBe(true);
});

it('returns search survivors and upstream truncation when the total deadline expires', async () => {
  const provider = new AggregatedSearchProvider({
    breaker: new CircuitBreaker(), resolveControls: () => ({ searchDeadlineMs: 30 }),
    engines: [
      { id: 'fast', search: async () => ({ sources: [{ url }], truncated: true }) },
      { id: 'hung', search: () => new Promise(() => {}) },
    ],
  });
  const output = await provider.search({ query: 'fixture' });
  expect(output.sources).toHaveLength(1);
  expect(output.content).toContain('总限时');
  expect(output.truncated).toBe(true);
});

it('keeps completed search results if reranking ignores deadline cancellation', async () => {
  const provider = new AggregatedSearchProvider({
    breaker: new CircuitBreaker(), resolveControls: () => ({ searchDeadlineMs: 30 }),
    engines: [{ id: 'fast', search: async () => ({ sources: [{ url }], truncated: false }) }],
    rerank: { rerank: () => new Promise(() => {}) },
  });
  expect((await provider.search({ query: 'fixture' })).sources).toHaveLength(1);
});

it('still rejects caller cancellation even after a lane succeeds', async () => {
  const caller = new AbortController();
  const provider = new AggregatedFetchProvider({ legs: [
    { engineId: 'fast', extract: async () => body('Available content.') },
    { engineId: 'hung', extract: () => new Promise(() => {}) },
  ] });
  const pending = provider.fetch({ url }, caller.signal);
  setTimeout(() => caller.abort(), 20);
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' });
});

it('does not follow API redirects behind a one-request permit', async () => {
  const server = await startMockServer((_request, response) => {
    response.writeHead(307, { location: '/again' }); response.end();
  });
  try {
    await runOperation({ maxRequests: 1 }, 'fetch', undefined, async () => {
      await expect(budgetedFetch()(server.url)).rejects.toThrow();
      expect(requestCount()).toBe(1);
    });
    expect(server.requests).toHaveLength(1);
  } finally { await server.close(); }
});

it('prioritizes a caller cancellation immediately after the operation deadline', async () => {
  const caller = new AbortController();
  const pending = runOperation({ fetchDeadlineMs: 10 }, 'fetch', caller.signal, signal => {
    signal.addEventListener('abort', () => queueMicrotask(() => caller.abort()), { once: true });
    return new Promise(() => {});
  });
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' });
});

it('applies output budgets and provenance to non-2xx target bodies', () => {
  const output = organizeDocuments(url, [candidate('# Not found\n\n' + 'x'.repeat(2000), { statusCode: 404 })], 1000);
  expect(output.statusCode).toBe(404);
  expect(output.body.content.length).toBeLessThanOrEqual(1000);
  expect(output.body.content).toContain('提取来源');
  expect(output.truncated).toBe(true);
  expect(() => organizeDocuments(url, [candidate('foreign error', { statusCode: 404, url: 'https://other.test/' })])).toThrow('没有可整理');
});

it('isolates explicit version differences even with the same title and shared text', () => {
  const output = organizeDocuments(url, [
    candidate('# Setup\n\nShared introduction.\n\nVersion: 1.0\n\nInstall old-package.'),
    candidate('# Setup\n\nShared introduction.\n\nVersion: 2.0\n\nInstall new-package.'),
  ]).body.content;
  expect(output.split('## 补充片段')[0]).not.toContain('new-package');
  expect(output).toContain('版本标记不同');
  expect(output).toContain('new-package');
});

it('preserves conflicting reference definitions as separate original Markdown documents', () => {
  const output = organizeDocuments(url, [
    candidate('# Guide\n\nRead [manual][doc].\n\n[doc]: https://example.com/v1'),
    candidate('# Guide\n\nRead [manual][doc].\n\n[doc]: https://example.com/v2'),
  ]).body.content;
  expect(output.match(/Read \[manual\]\[doc\]\./g)).toHaveLength(2);
  expect(output).toContain('引用定义');
  expect(output).toContain('https://example.com/v1');
  expect(output).toContain('https://example.com/v2');
  expect(output).toContain('```markdown');
});

it('rejects common challenge pages and ignores their upstream truncation flag', () => {
  const challenge = candidate('# Attention Required! | Cloudflare\n\nVerify you are human to continue.', { truncated: true });
  expect(() => organizeDocuments(url, [challenge])).toThrow('没有可整理');
  const output = organizeDocuments(url, [candidate('# Guide\n\nActual content.'), challenge]);
  expect(output.truncated).toBe(false);
  expect(output.body.content).not.toContain('Verify you are human');
});

it('bounds original Markdown fencing without expanding untrusted matches into call arguments', () => {
  const output = organizeDocuments(url, [candidate('# Guide\n\n' + '`a` '.repeat(100000) + '\n\n[x]: https://example.com/manual')], 1000);
  expect(output.body.content.length).toBeLessThanOrEqual(1000);
  expect(output.truncated).toBe(true);
});

it('propagates successful upstream pagination even without local truncation', async () => {
  const provider = new AggregatedSearchProvider({ breaker: new CircuitBreaker(), engines: [
    { id: 'aihot', search: async () => ({ sources: [{ url }], truncated: true }) },
  ] });
  expect((await provider.search({ query: 'fixture' })).truncated).toBe(true);
});
