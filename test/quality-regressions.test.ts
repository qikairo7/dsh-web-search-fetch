import { afterEach, expect, it, vi } from 'vitest';
import { AggregatedSearchProvider, rrfFuse } from '../src/search-aggregate.js';
import { organizeDocuments } from '../src/fetch-document/organize.js';
import { aggregateDynamicFetch } from '../src/fetch-aggregate.js';
import { CircuitBreaker } from '../src/breaker/index.js';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { budgetedFetch } from '../src/request-budget.js';
import { readFixtureJson } from './helpers/fixtures.js';

afterEach(() => vi.useRealTimers());
const multi = { preset: 'multi' as const, decision: { decide: async () => ({ depth: 'balanced' as const, model: 'test' }) } };
const page = (content: string): WebFetchResult => ({ url: 'https://docs.test/guide', statusCode: 200, truncated: false, body: { kind: 'text', content } });

it('补查缺失的官方文档，并在重排之后仍保留相关官方来源优先', async () => {
  const queries: string[] = [];
  const provider = new AggregatedSearchProvider({
    breaker: new CircuitBreaker(), resolveControls: () => multi,
    engines: ['a', 'b', 'c'].map(id => ({ id, search: async request => {
      queries.push(request.query);
      return { truncated: false, sources: request.query.includes('site:docs.python.org')
        ? [{ url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'asyncio TaskGroup — Python documentation' }]
        : [{ url: 'https://blog.test/taskgroup', title: 'Python TaskGroup guide' }] };
    } })),
    rerank: { rerank: async (_query, docs) => docs.map((_, index) => docs.length - index - 1) },
  });
  const result = await provider.search({ query: 'Python asyncio TaskGroup official documentation', maxResults: 5 });
  expect(queries.some(query => query.includes('site:docs.python.org'))).toBe(true);
  expect(result.sources[0]?.url).toContain('docs.python.org');
});

it('合并已知 MDN 参数变体和有相同内容证据的尾斜杠变体，不合并不同资源', () => {
  const snippet = 'The same article explains promise cancellation and error handling in detail. '.repeat(3);
  const results = rrfFuse([{ engineId: 'a', sources: [
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all?retiredLocale=de', title: 'Promise.all() - JavaScript | MDN' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all', title: 'Promise.all() - JavaScript | MDN' },
    { url: 'https://blog.test/guide', title: 'Promise cancellation guide', snippet },
    { url: 'https://blog.test/guide/', title: 'Promise cancellation guide', snippet },
    { url: 'https://api.test/resource', title: 'Resource' },
    { url: 'https://api.test/resource/', title: 'Different resource' },
  ] }], 60);
  expect(results).toHaveLength(4);
  expect(results[0]?.score).toBeCloseTo(1 / 61);
});

it('真实尾斜杠变体按归一化标题合并：站点后缀与摘要长度差异不阻止并键', () => {
  // 2026-10-19 审计保存的真实 sources（8 条里的两对变体，摘要为控制体积已截短）。
  // 两条 zair.top 与两条 syndataworks 是同一页面，标题被部分引擎加了站点后缀；
  // 旧规则要求标题全等 + 摘要同长，于是两对都留下了重复（P2-4）。
  const sources = readFixtureJson<{ url: string; title: string; snippet: string }[]>('slash-variants.json');
  const fused = rrfFuse([{ engineId: 'a', sources }], 60);
  expect(fused).toHaveLength(2);
  expect(new Set(fused.map(candidate => candidate.url))).toEqual(new Set([
    'https://www.zair.top/post/vector-database-compare/',
    'https://www.syndataworks.cn/blog/blog/2024-10-29-vectoc-db-eval/',
  ]));
  const zair = fused.find(candidate => candidate.url.includes('zair.top'));
  expect(zair?.snippet).toBe(sources[0]!.snippet);
});

it('去掉明确的导航控件，合并标题锚点差异，保留代码、正文链接与不同数字', () => {
  const navigation = '### Navigation\n\n- [index](https://docs.test/index)\n- [modules](https://docs.test/modules)\n\nTheme AutoLightDark\n\n';
  const article = '# Task groups\n\nAdded in version 3.11.\n\n```py\nprint("Navigation Theme")\n```\n\n[Reference](https://docs.test/reference)';
  const result = organizeDocuments('https://docs.test/guide', [
    { engineId: 'a', result: page(navigation + article) },
    { engineId: 'b', result: page(article.replace('# Task groups', '# Task groups [¶](https://docs.test/guide#task-groups)')) },
  ]);
  expect(result.body.content).not.toContain('### Navigation');
  expect(result.body.content).not.toContain('Theme AutoLightDark');
  expect(result.body.content.match(/Added in version 3\.11\./g)).toHaveLength(1);
  expect(result.body.content).toContain('print("Navigation Theme")');
  expect(result.body.content).toContain('[Reference](https://docs.test/reference)');
});

it('自动搜索在三路充分结果后取消慢路，不等待其十秒超时', async () => {
  vi.useFakeTimers(); let stopped = false;
  const provider = new AggregatedSearchProvider({ breaker: new CircuitBreaker(), resolveControls: () => multi,
    engines: ['a', 'b', 'c', 'slow'].map((id, index) => ({ id, search: async (_request, signal) => {
      if (id === 'slow') { signal?.addEventListener('abort', () => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 10_000)); }
      return { truncated: false, sources: Array.from({ length: 5 }, (_, n) => ({ url: `https://source${index}.test/${n}`, title: 'Useful reference ' + n })) };
    } })),
  });
  let completed = false;
  const work = provider.search({ query: 'useful reference', maxResults: 5 }).then(result => { completed = true; return result; });
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(completed).toBe(true); expect(stopped).toBe(true);
    expect((await work).content).toContain('提前');
  } finally { await vi.runAllTimersAsync(); await work; }
});

it('多路正文互补后自动结束慢路，并明确标记未等待完整结果', async () => {
  vi.useFakeTimers(); let stopped = false;
  const common = '# Reference\n\n' + 'A useful documented paragraph with stable content and a concrete explanation. '.repeat(25);
  let completed = false;
  const work = aggregateDynamicFetch({ url: 'https://docs.test/guide', mode: 'organize',
    legs: ['a', 'b', 'c', 'slow'].map((engineId, index) => ({ engineId, extract: async (_url, signal) => {
      if (engineId === 'slow') { signal?.addEventListener('abort', () => { stopped = true; }); await new Promise(resolve => setTimeout(resolve, 10_000)); }
      return page(common + '\n\nUnique supplement ' + index);
    } })),
  }).then(result => { completed = true; return result; });
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(completed).toBe(true); expect(stopped).toBe(true);
    const result = await work;
    expect(result.truncated).toBe(true);
    expect(result.body.content).toContain('Unique supplement 0');
    expect(result.body.content).toContain('Unique supplement 1');
    expect(result.body.content).toContain('提前');
  } finally { await vi.runAllTimersAsync(); await work; }
});

it('保留讲解导航的正文标题与标题之前的有效引用', () => {
  const body = '[Specification](https://spec.test/navigation)\n\n# Navigation\n\nNavigation is a meaningful article topic.\n\n## Navigation examples\n\nUse the documented API.';
  const result = organizeDocuments('https://docs.test/guide', [{ engineId: 'a', result: page(body) }]);
  expect(result.body.content).toContain('# Navigation');
  expect(result.body.content).toContain('[Specification](https://spec.test/navigation)');
});

it('不把同域名的无关官方 API 提升到相关官方文档前面', async () => {
  const provider = new AggregatedSearchProvider({ breaker: new CircuitBreaker(), engines: [{ id: 'a', search: async () => ({ truncated: false, sources: [
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/any', title: 'Promise.any()', snippet: 'Unlike Promise.all, this method returns the first fulfillment.' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled', title: 'Promise.allSettled()' },
    { url: 'https://blog.test/promise-all', title: 'Promise.all explanation' },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all', title: 'Promise.all()' },
  ] }) }] });
  const result = await provider.search({ query: 'Promise.all official documentation', maxResults: 4 });
  expect(result.sources[0]?.title).toBe('Promise.all()');
});

it('真实文档的转义分隔符、面包屑与主题控件不会挤占正文', () => {
  const raw = '### Navigation\n\n- [index](https://docs.test/index)\n- [modules](https://docs.test/modules) \\|\n- [next](https://docs.test/next) \\|\n- German \\| DeutschGreek \\| ΕλληνικάEnglishSpanish\n\n- [Library](https://docs.test/library) »\n- [Tasks](https://docs.test/tasks)\n- \\|\n\n- Theme\nAutoLightDark \\|\n\n# Tasks\n\nActual useful content.';
  const result = organizeDocuments('https://docs.test/guide', [{ engineId: 'a', result: page(raw) }]);
  expect(result.body.content).not.toContain('[index]');
  expect(result.body.content).not.toContain('[Library]');
  expect(result.body.content).not.toContain('AutoLightDark');
  expect(result.body.content).toContain('Actual useful content.');
});

it('官方补查也必须取得 HTTP 预算，不能绕过调用上限', async () => {
  let requests = 0;
  const transport = budgetedFetch(async () => { requests++; return new Response('{}'); });
  const provider = new AggregatedSearchProvider({ breaker: new CircuitBreaker(), resolveControls: () => ({ ...multi, maxRequests: 1 }),
    engines: [{ id: 'a', search: async () => { await transport('https://service.test/search'); return { truncated: false, sources: [{ url: 'https://blog.test/python', title: 'Python TaskGroup' }] }; } }],
  });
  const result = await provider.search({ query: 'Python TaskGroup official docs' });
  expect(requests).toBe(1);
  expect(result.content).toContain('请求预算');
  expect(result.sources).toHaveLength(1);
});

it('合并已核实的官方文档协议、推广参数和 HTML 别名', () => {
  const sources = [
    'http://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all?source=post_page-----example',
    'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9',
    'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html',
  ].map(url => ({ url }));
  expect(rrfFuse([{ engineId: 'a', sources }], 60)).toHaveLength(2);
});

it('正文标题不一致时继续等待，不以共同模板提前取消其他来源', async () => {
  vi.useFakeTimers(); let ended = false, completed = false;
  const template = 'Shared template paragraph and a long explanation. '.repeat(30);
  const work = aggregateDynamicFetch({ url: 'https://docs.test/guide', mode: 'organize', legs: ['a', 'b', 'c', 'late'].map(engineId => ({
    engineId, extract: async (_url, signal) => {
      if (engineId === 'late') { signal?.addEventListener('abort', () => { ended = true; }); await new Promise(resolve => setTimeout(resolve, 5000)); }
      return page('# Different ' + engineId + '\n\n' + template);
    },
  })) }).then(result => { completed = true; return result; });
  try { await vi.advanceTimersByTimeAsync(2000); expect(completed).toBe(false); expect(ended).toBe(false); }
  finally { await vi.runAllTimersAsync(); await work; }
});

it('等待宽限期内返回的独有内容，仍取消真正的慢路', async () => {
  vi.useFakeTimers();
  const common = '# Reference\n\n' + 'A useful documented paragraph with stable content and a concrete explanation. '.repeat(25);
  const work = aggregateDynamicFetch({ url: 'https://docs.test/guide', mode: 'organize', legs: ['a', 'b', 'c', 'complement', 'slow'].map(engineId => ({
    engineId, extract: async () => {
      if (engineId === 'complement') await new Promise(resolve => setTimeout(resolve, 900));
      if (engineId === 'slow') await new Promise(resolve => setTimeout(resolve, 10_000));
      return page(common + (engineId === 'complement' ? '\n\n## Exclusive\n\nLate but useful details.' : ''));
    },
  })) });
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect((await work).body.content).toContain('Late but useful details.');
  } finally { await vi.runAllTimersAsync(); await work; }
});
