import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AggregatedSearchProvider } from '../lib/search-aggregate.js';
import { AggregatedFetchProvider, createExtractionLegs } from '../lib/fetch-pipeline.js';
import { CircuitBreaker } from '../lib/breaker/index.js';
import { budgetedFetch } from '../lib/request-budget.js';
import { createAggregatedSearchProvider } from '../lib/search-pipeline.js';
import { createAdditionalEngines } from '../lib/engines/additional/index.js';
import { FirecrawlClient } from '../lib/engines/firecrawl/client.js';
import { AnySearchEngine } from '../lib/engines/anysearch/engine.js';
import { searchCases, longArticle, relevance, retention } from './quality-cases.mjs';

const url = 'https://article.test/guide';
const page = content => ({ url, statusCode: 200, truncated: false, body: { kind: 'text', content } });

export async function evaluateQuality({ live = false } = {}) {
  const rows = [];
  const trial = async (id, category, make, inspect) => {
    const cost = { requests: 0, completed: 0, cancelled: 0, byKind: {}, monetaryCost: null };
    // Offline requests cross the real request-budget boundary, but use synthetic transport.
    const transport = budgetedFetch(async (input, init) => {
      const item = JSON.parse(init.body);
      cost.requests++;
      cost.byKind[item.kind] = (cost.byKind[item.kind] ?? 0) + 1;
      try {
        await delay(item.delayMs ?? 0, undefined, { signal: init.signal });
        cost.completed++;
        return Response.json(item.result);
      } catch (error) { if (init.signal?.aborted) cost.cancelled++; throw error; }
    });
    const request = async (kind, result, signal, delayMs = 0) => (await transport('https://fixture.test/' + kind,
      { method: 'POST', body: JSON.stringify({ kind, result, delayMs }), signal })).json();
    const started = performance.now();
    const row = { id, category, scope: 'synthetic replay', status: 'PASS', cost };
    try {
      const result = await make(request);
      Object.assign(row, inspect(result, cost), { truncated: result.truncated });
    } catch (error) { row.status = 'FAIL'; row.errorCode = error.code ?? error.name; row.message = error.message; }
    row.ms = Math.round(performance.now() - started);
    rows.push(row);
  };
  for (const item of searchCases) {
    await trial(item.id, item.category, request => new AggregatedSearchProvider({ breaker: new CircuitBreaker(),
      resolveControls: () => ({ preset: 'custom', maxRequests: 3 }),
      engines: [0, 1, 2].map(n => ({ id: 'fixture-' + n, search: async (_query, signal) => request('search', {
        sources: [item.documents[n], ...item.documents.filter((_, i) => i !== n)].map(({ grade, ...source }) => source), truncated: false,
      }, signal) })),
    }).search({ query: item.query, maxResults: 5 }), result => {
      const metrics = relevance(result.sources, item.documents);
      assert(metrics.precisionAt5 >= (item.category === 'news' ? 0.6 : 0.8));
      assert(metrics.ndcgAt5 >= 0.9);
      const dated = result.sources.filter(source => source.publishedAt);
      return { ...metrics, ...(item.since ? { datedSources: dated.length,
        inWindowSources: dated.filter(source => source.publishedAt >= item.since && source.publishedAt <= item.until).length } : {}) };
    });
  }
  for (const variant of ['select', 'organize', 'budget']) {
    const mode = variant === 'select' ? 'select' : 'organize';
    await trial('long-chinese-' + variant, 'long-article', request => new AggregatedFetchProvider({
      resolveControls: () => ({ preset: 'custom', mode, maxOutputChars: variant === 'budget' ? 1000 : 100_000 }),
      legs: longArticle.bodies.map((content, n) => ({ engineId: 'fixture-' + n, extract: (_url, signal) => request('extract', page(content), signal) })),
    }).fetch({ url }), result => {
      const metrics = retention(result.body.content, longArticle.markers);
      if (variant === 'organize') assert.equal(metrics.markerRecall, 1);
      if (variant === 'budget') { assert(result.truncated); assert(metrics.markerRecall < 1); }
      const retainedSections = Array.from({ length: 60 }, (_, n) => `## 第 ${n + 1} 节`).filter(marker => result.body.content.includes(marker)).length;
      if (variant !== 'budget') assert.equal(retainedSections, 60);
      return { ...metrics, retainedSections, sectionTotal: 60, bodyChars: result.body.content.length };
    });
  }
  const challenge = '# Just a moment...\n\nVerify you are human. Checking your browser before accessing the site. Enable JavaScript and cookies to continue.';
  for (const allBlocked of [false, true]) {
    await trial(allBlocked ? 'all-challenged' : 'challenge-with-article', 'challenge', async request => {
      const provider = new AggregatedFetchProvider({ resolveControls: () => ({ preset: 'custom' }),
        legs: (allBlocked ? [challenge] : [challenge, longArticle.bodies[0]]).map((content, n) => ({
          engineId: 'fixture-' + n, extract: (_url, signal) => request('extract', page(content), signal),
        })),
      });
      try { return await provider.fetch({ url }); }
      catch (error) {
        if (allBlocked && error.code === 'WEB_PROVIDER_ERROR' && /没有可整理的目标网页正文/.test(error.message)) return { rejected: true, code: error.code, truncated: false };
        throw error;
      }
    }, result => {
      if (allBlocked) { assert.equal(result.rejected, true); return { challengeRejected: true }; }
      assert(!result.body.content.includes('Verify you are human'));
      assert(result.body.content.includes('甲渠道独有的联络流程。'));
      return { challengeExcluded: true, articleRetained: true };
    });
  }
  for (const face of ['search', 'fetch']) for (const preset of ['custom', 'auto']) {
    await trial(`slow-${face}-${preset}`, 'slow-channel', async request => {
      const controls = { preset, maxRequests: 5, decision: { decide: (_face, _text, signal) =>
        request('decision', { depth: 'balanced', model: 'fixture-decision' }, signal) } };
      const ids = ['fixture-a', 'fixture-b', 'fixture-c', 'fixture-slow'];
      if (face === 'search') return new AggregatedSearchProvider({ breaker: new CircuitBreaker(), resolveControls: () => controls,
        engines: ids.map(id => ({ id, search: (_query, signal) => request('search', {
          sources: Array.from({ length: 5 }, (_, n) => ({ url: `https://${id}.test/${n}`, title: searchCases[0].query + '：指南 ' + n })), truncated: false,
        }, signal, id.endsWith('slow') ? 2200 : 0) })),
      }).search({ query: searchCases[0].query, maxResults: 5 });
      const shared = '# 城市防汛手册\n\n' + '暴雨积水期间优先保障人员安全，核查道路通行情况并制定出行方案。'.repeat(65);
      return new AggregatedFetchProvider({ resolveControls: () => controls,
        legs: ids.map(id => ({ engineId: id, extract: (_url, signal) => request('extract', page(shared + '\n\n## 补充\n\n独有内容' + id), signal, id.endsWith('slow') ? 2200 : 0) })),
      }).fetch({ url });
    }, (result, cost) => {
      assert.equal(cost.cancelled, preset === 'auto' ? 1 : 0);
      assert.equal(cost.requests, preset === 'auto' ? 5 : 4);
      if (face === 'fetch') assert.equal(result.body.content.includes('独有内容fixture-slow'), preset !== 'auto');
      if (preset === 'auto') assert.equal(result.truncated, true);
      return face === 'fetch' ? { slowContentRetained: result.body.content.includes('独有内容fixture-slow') } : { sourceCount: result.sources.length };
    });
  }
  if (live) rows.push(...await evaluateLive());
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? 'dirty' : 'clean',
    scope: 'Synthetic judgments test pipeline rules; live anonymous rows measure current availability and relevance proxies, not human relevance scores. Requests count dispatched attempts, including cancelled lanes; no currency estimate.', rows };
}

async function evaluateLive() {
  const cost = { requests: 0, byKind: {} };
  const countedFetch = (input, init) => {
    cost.requests++;
    const kind = /\/(?:search|scrape|extract)$/.exec(new URL(String(input)).pathname)?.[0].slice(1) ?? 'other';
    cost.byKind[kind] = (cost.byKind[kind] ?? 0) + 1;
    return fetch(input, init);
  };
  const resolveCredential = async () => undefined;
  const controls = { preset: 'custom', mode: 'organize', searchServices: ['anysearch', 'firecrawl', 'tavily'],
    fetchServices: ['anysearch', 'firecrawl', 'tavily'], maxRequests: 5, maxOutputChars: 50_000,
    searchDeadlineMs: 15_000, fetchDeadlineMs: 50_000 };
  const additionalEngines = createAdditionalEngines({ firecrawl: {}, tavily: {} }, resolveCredential,
    { searchTimeoutMs: 10_000, fetchTimeoutMs: 45_000, fetchImpl: countedFetch });
  const anysearch = new AnySearchEngine({ resolveApiKey: async () => undefined, credentialName: 'ANONYMOUS', fetchImpl: budgetedFetch(countedFetch) });
  const search = createAggregatedSearchProvider({ resolveCredential, additionalEngines, resolveControls: () => controls,
    overrides: { fetchImpl: countedFetch }, rerank: false, quotaCheck: false });
  const extract = new AggregatedFetchProvider({ additionalEngines, resolveControls: () => controls, legs: createExtractionLegs({ anysearch,
    firecrawl: new FirecrawlClient({ resolveApiKey: async () => undefined, credentialName: 'ANONYMOUS', fetchImpl: budgetedFetch(countedFetch) }),
  }) });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const cases = [
    { id: 'live-chinese', query: 'Python asyncio TaskGroup 任务失败时如何取消其他任务 官方文档', terms: ['TaskGroup', '取消', 'cancel'] },
    { id: 'live-news', query: '嫦娥六号 2024年6月25日 返回器 着陆 官方消息', terms: ['嫦娥六号', '着陆', '返回器'] },
    { id: 'live-current-news', query: today + ' 人工智能 最新新闻', terms: ['人工智能', 'AI', '模型'], since: today },
    { id: 'live-long-article', url: 'https://docs.python.org/zh-cn/3/library/asyncio-task.html', markers: ['TaskGroup', 'create_task', 'shield', 'timeout', 'CancelledError'] },
  ];
  const rows = [];
  for (const item of cases) {
    cost.requests = 0;
    cost.byKind = {};
    const started = performance.now();
    const row = { id: item.id, scope: 'live anonymous core API', status: 'PASS', qualityStatus: 'PROXY_ONLY' };
    try {
      const result = item.url ? await extract.fetch({ url: item.url }) : await search.search({ query: item.query, maxResults: 5 });
      assert(item.url ? result.statusCode >= 200 && result.statusCode < 300 && result.body.content.trim().length > 0 : result.sources.length > 0, 'no usable output');
      row.truncated = result.truncated;
      if (item.url) Object.assign(row, retention(result.body.content, item.markers), { bodyChars: result.body.content.length });
      else {
        row.sourceCount = result.sources.length;
        row.topicMatchAt5 = result.sources.slice(0, 5).filter(source => item.terms.some(term => `${source.title} ${source.snippet}`.toLowerCase().includes(term.toLowerCase()))).length / 5;
        row.urls = result.sources.map(source => source.url);
        row.datedSources = result.sources.filter(source => source.publishedAt).length;
        if (item.since) {
          row.inWindowSources = result.sources.filter(source => {
            const timestamp = Date.parse(source.publishedAt ?? '');
            return Number.isFinite(timestamp) && timestamp >= Date.parse(item.since + 'T00:00:00+08:00') && timestamp <= Date.now();
          }).length;
          row.freshnessStatus = row.datedSources === 0 ? 'UNKNOWN' : 'METADATA_ONLY';
        }
      }
    } catch (error) { row.status = 'FAIL'; row.errorCode = error.code ?? error.name; }
    row.ms = Math.round(performance.now() - started);
    row.cost = { requests: cost.requests, byKind: { ...cost.byKind }, monetaryCost: null };
    rows.push(row);
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputIndex = process.argv.indexOf('--output');
  const report = await evaluateQuality({ live: process.argv.includes('--live') });
  if (outputIndex >= 0) {
    assert(process.argv[outputIndex + 1], '--output requires a filename');
    await writeFile(process.argv[outputIndex + 1], JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.rows.some(row => row.status === 'FAIL')) process.exitCode = 1;
}
