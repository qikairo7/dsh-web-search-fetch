import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import { CircuitBreaker } from '../src/breaker/index.js';
import { budgetedFetch } from '../src/request-budget.js';
import { AggregatedSearchProvider } from '../src/search-aggregate.js';
import type { SearchEngineClient } from '../src/search-aggregate.js';

// Issue #20 phase 2: a single-channel search that produced nothing usable
// widens to several channels exactly once. These cases pin the trigger (empty
// answer and fully filtered candidates), the exclusions (failure, budget,
// multi-channel presets) and the escalated run's result shape.

function source(url: string, extra: Partial<WebSearchSource> = {}): WebSearchSource {
  return { url, ...extra };
}

interface FakeEngine {
  readonly engine: SearchEngineClient;
  readonly requests: WebSearchRequest[];
}

function fakeEngine(
  id: string,
  search: (request: WebSearchRequest, signal?: AbortSignal) => Promise<WebSearchResult>,
): FakeEngine {
  const requests: WebSearchRequest[] = [];
  return {
    requests,
    engine: {
      id,
      search: (request, signal) => {
        requests.push(request);
        return search(request, signal);
      },
    },
  };
}

function ok(sources: readonly WebSearchSource[]) {
  return async (): Promise<WebSearchResult> => ({ sources, truncated: false });
}

function fails(error: unknown) {
  return async (): Promise<WebSearchResult> => {
    throw error;
  };
}

function buildProvider(options: {
  engines: readonly SearchEngineClient[];
  resolveControls: () => { preset?: 'auto' | 'single' | 'multi'; maxRequests?: number };
}): AggregatedSearchProvider {
  return new AggregatedSearchProvider({
    breaker: new CircuitBreaker(),
    engines: options.engines,
    resolveControls: options.resolveControls,
  });
}

/** The automatic preset's local rule keeps this query single-channel. */
const PLAIN_QUERY = '如何安装 Node.js';
const plainControls = () => ({ preset: 'auto' as const });

describe('单通道空结果自动补派多路', () => {
  it('自动档单通道成功空返回：补派其余通道并返回其结果', async () => {
    const empty = fakeEngine('anysearch', ok([]));
    const backup = fakeEngine(
      'engine-z',
      ok([source('https://docs.test/node-install', { title: '如何安装 Node.js', snippet: '安装 Node.js 的步骤' })]),
    );
    const provider = buildProvider({ engines: [empty.engine, backup.engine], resolveControls: plainControls });
    const out = await provider.search({ query: PLAIN_QUERY });
    expect(out.sources.map(entry => entry.url)).toEqual(['https://docs.test/node-install']);
    expect(out.content).toContain('单路 anysearch 空结果');
    expect(out.content).toContain('已补派 1 路搜索');
    expect(empty.requests).toHaveLength(1);
    expect(backup.requests).toHaveLength(1);
  });

  it('自动档单通道有返回但全被相关性过滤：同样补派', async () => {
    const irrelevant = fakeEngine(
      'anysearch',
      ok([source('https://unrelated.test/x', { title: 'Weather forecast', snippet: 'Sunny.' })]),
    );
    const backup = fakeEngine(
      'engine-z',
      ok([source('https://docs.test/token', { title: 'zxqvj plorptastic nonsense token', snippet: 'token reference' })]),
    );
    const provider = buildProvider({ engines: [irrelevant.engine, backup.engine], resolveControls: plainControls });
    const out = await provider.search({ query: 'zxqvj plorptastic nonsense token' });
    expect(out.sources.map(entry => entry.url)).toEqual(['https://docs.test/token']);
    expect(out.content).toContain('已补派 1 路搜索');
    expect(backup.requests).toHaveLength(1);
  });

  it('固定单通道预设同样补派，与提取侧 singleChannelEscalate 先例对齐', async () => {
    const empty = fakeEngine('anysearch', ok([]));
    const backup = fakeEngine(
      'engine-z',
      ok([source('https://docs.test/harness', { title: 'DeepSeek Harness guide', snippet: 'DeepSeek Harness 使用入门' })]),
    );
    const provider = buildProvider({
      engines: [empty.engine, backup.engine],
      resolveControls: () => ({ preset: 'single' as const }),
    });
    const out = await provider.search({ query: 'DeepSeek Harness 使用入门' });
    expect(out.sources.map(entry => entry.url)).toEqual(['https://docs.test/harness']);
    expect(out.content).toContain('已补派 1 路搜索');
  });

  it('限流的一路不触发补派：该路已消耗预算，本次照旧报 WEB_PROVIDER_ERROR', async () => {
    const limited = fakeEngine(
      'anysearch',
      fails(new WebError('AnySearch search failed', 'WEB_PROVIDER_ERROR', { cause: { kind: 'rate-limit' } })),
    );
    const backup = fakeEngine('engine-z', ok([source('https://docs.test/node-install', { title: '如何安装 Node.js' })]));
    const provider = buildProvider({
      engines: [limited.engine, backup.engine],
      resolveControls: () => ({ preset: 'single' as const }),
    });
    await expect(provider.search({ query: PLAIN_QUERY })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
    expect(backup.requests).toHaveLength(0);
  });

  it('请求预算用尽时不补派，并在说明里如实写明', async () => {
    let requests = 0;
    const transport = budgetedFetch(async () => {
      requests += 1;
      return new Response('{}');
    });
    const empty = fakeEngine('anysearch', async () => {
      await transport('https://anysearch.test/search');
      return { sources: [], truncated: false };
    });
    const backup = fakeEngine('engine-z', async () => {
      await transport('https://z.test/search');
      return { sources: [source('https://docs.test/node-install', { title: '如何安装 Node.js' })], truncated: false };
    });
    const provider = buildProvider({
      engines: [empty.engine, backup.engine],
      resolveControls: () => ({ preset: 'single' as const, maxRequests: 1 }),
    });
    const out = await provider.search({ query: PLAIN_QUERY });
    expect(requests).toBe(1);
    expect(backup.requests).toHaveLength(0);
    expect(out.sources).toEqual([]);
    expect(out.content).toContain('请求预算已用尽');
    expect(out.content).toContain('未补派其他通道');
  });

  it('多通道预设不补派：原本就派发了多路', async () => {
    const first = fakeEngine('anysearch', ok([]));
    const second = fakeEngine('engine-z', ok([]));
    const provider = buildProvider({
      engines: [first.engine, second.engine],
      resolveControls: () => ({ preset: 'multi' as const }),
    });
    const out = await provider.search({ query: PLAIN_QUERY });
    expect(out.sources).toEqual([]);
    expect(out.content).not.toContain('已补派');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('自动档已判定多通道（调研类查询）不补派', async () => {
    const first = fakeEngine('anysearch', ok([]));
    const second = fakeEngine('engine-z', ok([]));
    const provider = buildProvider({
      engines: [first.engine, second.engine],
      resolveControls: plainControls,
    });
    const out = await provider.search({ query: '对比 Node.js 与 Deno 最新资料' });
    expect(out.sources).toEqual([]);
    expect(out.content).not.toContain('已补派');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('补派结果走正常融合：重复 URL 合并、说明同时含升级事实与结果', async () => {
    const empty = fakeEngine('anysearch', ok([]));
    const second = fakeEngine('engine-z', ok([
      source('https://docs.test/node-install', { title: '如何安装 Node.js', snippet: '安装 Node.js 的步骤' }),
      source('https://docs.test/node-version', { title: '如何安装 Node.js 并确认版本', snippet: '如何安装后检查 Node.js 版本' }),
    ]));
    const third = fakeEngine('engine-y', ok([
      source('https://docs.test/node-install', { title: '如何安装 Node.js', snippet: '安装 Node.js 的详细步骤与版本要求' }),
      source('https://docs.test/node-nvm', { title: '如何安装 Node.js（nvm）', snippet: '如何安装 Node.js 的 nvm 方式' }),
    ]));
    const provider = buildProvider({
      engines: [empty.engine, second.engine, third.engine],
      resolveControls: plainControls,
    });
    const out = await provider.search({ query: PLAIN_QUERY });
    expect(out.sources.map(entry => entry.url)).toEqual([
      'https://docs.test/node-install',
      'https://docs.test/node-version',
      'https://docs.test/node-nvm',
    ]);
    expect(out.content).toContain('已补派 2 路搜索');
    expect(out.content).toContain('本插件 HTTP 请求');
    expect(second.requests).toHaveLength(1);
    expect(third.requests).toHaveLength(1);
  });

  it('补派只发生一次：补派后仍为空也不再二次升级', async () => {
    const empty = fakeEngine('anysearch', ok([]));
    const second = fakeEngine('engine-z', ok([]));
    const third = fakeEngine('engine-y', ok([]));
    const provider = buildProvider({
      engines: [empty.engine, second.engine, third.engine],
      resolveControls: plainControls,
    });
    const out = await provider.search({ query: PLAIN_QUERY });
    expect(out.sources).toEqual([]);
    expect(out.content?.match(/已补派/g)).toHaveLength(1);
    expect(empty.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(third.requests).toHaveLength(1);
  });
});
