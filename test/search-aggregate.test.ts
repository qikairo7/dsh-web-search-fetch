import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import { CircuitBreaker, type BreakerSignal } from '../src/breaker/index.js';
import { AnySearchClientError } from '../src/engines/anysearch/index.js';
import { mapZhipuSearchResponse } from '../src/engines/zhipu/wire.js';
import {
  AggregatedSearchProvider,
  normalizeSearchUrl,
  readSearchFailureSignal,
  rrfFuse,
  type SearchEngineClient,
  type SearchLogSink,
} from '../src/search-aggregate.js';
import { readFixtureJson } from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

function source(url: string, extra: Partial<WebSearchSource> = {}): WebSearchSource {
  return { url, ...extra };
}

function result(sources: readonly WebSearchSource[]): WebSearchResult {
  return { sources, truncated: false };
}

interface FakeEngine {
  readonly engine: SearchEngineClient;
  readonly requests: WebSearchRequest[];
}

function fakeEngine(
  id: string,
  search: (request: WebSearchRequest, signal?: AbortSignal) => Promise<WebSearchResult>,
  quota?: (signal?: AbortSignal) => Promise<{ remaining: number } | undefined>,
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
      ...(quota === undefined ? {} : { quota }),
    },
  };
}

function ok(sources: readonly WebSearchSource[]) {
  return async (): Promise<WebSearchResult> => result(sources);
}

function fails(error: unknown) {
  return async (): Promise<WebSearchResult> => {
    throw error;
  };
}

function hangs(): (request: WebSearchRequest) => Promise<WebSearchResult> {
  return () => new Promise<WebSearchResult>(() => undefined);
}

interface RecordingLogger extends SearchLogSink {
  readonly lines: string[];
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

async function expectWebError(promise: Promise<unknown>, code: string): Promise<WebError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebError);
    const webError = error as WebError;
    expect(webError.code).toBe(code);
    return webError;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// normalizeSearchUrl (#8: utm_* / fragment / protocol+host case / trailing slash)
// ---------------------------------------------------------------------------

describe('normalizeSearchUrl', () => {
  it('剥掉全部 utm_* 参数、锚点，并统一协议与主机名大小写', () => {
    expect(normalizeSearchUrl('HTTPS://Example.COM/?utm_source=x&utm_medium=y#frag')).toBe(
      'https://example.com/',
    );
  });

  it('保留非 utm 的 query 参数（参与判等），剥掉锚点', () => {
    expect(normalizeSearchUrl('https://example.com/p?utm_source=x&q=1#top')).toBe(
      'https://example.com/p?q=1',
    );
  });

  it('根路径尾斜杠归一：有斜杠与无斜杠同键', () => {
    expect(normalizeSearchUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeSearchUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('非根路径的尾斜杠保留（不误判为同键）', () => {
    expect(normalizeSearchUrl('https://example.com/path/')).toBe('https://example.com/path/');
    expect(normalizeSearchUrl('https://example.com/path/')).not.toBe(
      normalizeSearchUrl('https://example.com/path'),
    );
  });

  it('utm 前缀大小写不敏感；无法解析的 URL 原样返回', () => {
    expect(normalizeSearchUrl('https://example.com/?UTM_Source=x&a=1')).toBe('https://example.com/?a=1');
    expect(normalizeSearchUrl('not a url')).toBe('not a url');
  });
});

// ---------------------------------------------------------------------------
// rrfFuse: dedupe/merge + Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

describe('rrfFuse', () => {
  const K = 60;

  it('按各引擎排名倒数累加，给出融合分数与顺序', () => {
    const fused = rrfFuse(
      [
        { engineId: 'a', sources: [source('https://x/1'), source('https://x/2')] },
        { engineId: 'b', sources: [source('https://x/2'), source('https://x/3')] },
      ],
      K,
    );
    expect(fused.map((entry) => entry.url)).toEqual(['https://x/2', 'https://x/1', 'https://x/3']);
    expect(fused[0]!.score).toBeCloseTo(1 / (K + 2) + 1 / (K + 1), 10);
    expect(fused[1]!.score).toBeCloseTo(1 / (K + 1), 10);
    expect(fused[2]!.score).toBeCloseTo(1 / (K + 2), 10);
    expect(fused[0]!.contributors).toEqual(['a', 'b']);
    expect(fused[1]!.contributors).toEqual(['a']);
  });

  it('同归一键的多路命中合并为一条，保留 snippet 更长的一份', () => {
    const fused = rrfFuse(
      [
        {
          engineId: 'a',
          sources: [
            source('HTTPS://Example.COM/?utm_source=x&utm_medium=y#frag', {
              title: 'short',
              snippet: '短',
            }),
            source('https://example.com/path/'),
          ],
        },
        { engineId: 'b', sources: [source('https://example.com/', { snippet: '这是一段明显更长的摘要内容' })] },
      ],
      K,
    );
    expect(fused).toHaveLength(2);
    const merged = fused.find((entry) => entry.url === 'https://example.com/');
    expect(merged).toBeDefined();
    expect(merged!.snippet).toBe('这是一段明显更长的摘要内容');
    expect(merged!.title).toBe('short');
    expect(merged!.contributors).toEqual(['a', 'b']);
    expect(merged!.score).toBeCloseTo(2 / (K + 1), 10);
    expect(fused.some((entry) => entry.url === 'https://example.com/path/')).toBe(true);
  });

  it('同一引擎内重复的归一键只计一次排名', () => {
    const fused = rrfFuse(
      [{ engineId: 'a', sources: [source('https://example.com'), source('https://example.com/')] }],
      K,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(1 / (K + 1), 10);
    expect(fused[0]!.contributors).toEqual(['a']);
  });

  it('空输入返回空候选', () => {
    expect(rrfFuse([], K)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readSearchFailureSignal: engine failure vocabulary → BreakerSignal
// ---------------------------------------------------------------------------

describe('readSearchFailureSignal', () => {
  it('智谱 429 信号挂在 cause 上，Retry-After 一并读出（不改名）', () => {
    const error = new WebError('Zhipu web search failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
      cause: { kind: 'rate-limit', retryAfterMs: 2500 },
    });
    expect(readSearchFailureSignal(error)).toEqual({ kind: 'rate-limit', retryAfterMs: 2500 });
  });

  it('智谱 429 无 Retry-After 时只给 kind', () => {
    const error = new WebError('Zhipu web search failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
      cause: { kind: 'rate-limit' },
    });
    expect(readSearchFailureSignal(error)).toEqual({ kind: 'rate-limit' });
  });

  it('AnySearch 402（欠费）→ quota-exhausted，只留 kind 与 retryAfterMs', () => {
    const inner = new AnySearchClientError('AnySearch search failed', {
      operation: 'search',
      httpStatus: 402,
    });
    const wrapped = new WebError(inner.message, 'WEB_PROVIDER_ERROR', { cause: inner });
    expect(readSearchFailureSignal(wrapped)).toEqual({ kind: 'quota-exhausted' });
  });

  it('AnySearch 429 + retry-after 透传 retryAfterMs', () => {
    const inner = new AnySearchClientError('AnySearch search failed', {
      operation: 'search',
      httpStatus: 429,
      retryAfter: '3',
    });
    expect(readSearchFailureSignal(inner)).toEqual({ kind: 'rate-limit', retryAfterMs: 3000 });
  });

  it('无关失败不给信号', () => {
    expect(readSearchFailureSignal(new Error('boom'))).toBeUndefined();
    expect(readSearchFailureSignal(new WebError('nope', 'WEB_PROVIDER_ERROR'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AggregatedSearchProvider: fan-out, breaker, quota, rerank, truncation
// ---------------------------------------------------------------------------

function buildProvider(options: {
  engines: readonly SearchEngineClient[];
  breaker?: CircuitBreaker;
  logger?: SearchLogSink;
  rerank?: { rerank: (q: string, docs: readonly string[], topN: number, s?: AbortSignal) => Promise<number[] | null> };
  maxFanoutMs?: number;
  rrfK?: number;
  rerankPool?: number;
  quotaCheck?: boolean;
  now?: () => number;
}): AggregatedSearchProvider {
  return new AggregatedSearchProvider({
    breaker: new CircuitBreaker(),
    ...options,
  });
}

describe('AggregatedSearchProvider 多路并发', () => {
  it('三路成功：合并去重后按 RRF 序返回，三路都收到派发', async () => {
    const a = fakeEngine('anysearch', ok([source('https://a/1'), source('https://a/2')]));
    const z = fakeEngine('zhipu', ok([source('https://z/1')]));
    const h = fakeEngine('engine-a', ok([source('https://h/1')]));
    const provider = buildProvider({ engines: [a.engine, z.engine, h.engine] });
    const out = await provider.search({ query: '测试', maxResults: 10 });
    expect(out.sources.map((entry) => entry.url)).toEqual([
      'https://a/1',
      'https://z/1',
      'https://h/1',
      'https://a/2',
    ]);
    expect(out.truncated).toBe(false);
    expect(a.requests).toHaveLength(1);
    expect(z.requests).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(a.requests[0]!.maxResults).toBe(10);
    expect(a.requests[0]!.query).toBe('测试');
  });

  it('一路超时不阻塞其余：限时到点即丢弃该路并记日志', async () => {
    const slow = fakeEngine('anysearch', hangs());
    const fast = fakeEngine('zhipu', ok([source('https://z/1')]));
    const logger = recordingLogger();
    const provider = buildProvider({
      engines: [slow.engine, fast.engine],
      logger,
      maxFanoutMs: 40,
    });
    const started = Date.now();
    const out = await provider.search({ query: 'q' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://z/1']);
    const line = logger.lines.find((entry) => entry.includes('anysearch'));
    expect(line).toBeDefined();
    expect(line).toContain('超时');
    expect(line).toMatch(/\d+ms/);
  });

  it('两路失败一路成功：返回成功路结果，失败路日志带引擎名、延迟与原因', async () => {
    const bad = fakeEngine('anysearch', fails(new WebError('upstream exploded', 'WEB_PROVIDER_ERROR')));
    const worse = fakeEngine('engine-a', fails(new WebError('engine-a down', 'WEB_PROVIDER_ERROR')));
    const good = fakeEngine('zhipu', ok([source('https://z/1')]));
    const logger = recordingLogger();
    const provider = buildProvider({ engines: [bad.engine, worse.engine, good.engine], logger });
    const out = await provider.search({ query: 'q' });
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://z/1']);
    const anysearchLine = logger.lines.find((entry) => entry.includes('anysearch'));
    expect(anysearchLine).toContain('upstream exploded');
    expect(anysearchLine).toMatch(/\d+ms/);
    expect(logger.lines.some((entry) => entry.includes('engine-a') && entry.includes('engine-a down'))).toBe(true);
  });

  it('全败抛 WEB_PROVIDER_ERROR，摘要带各引擎失败原因', async () => {
    const a = fakeEngine('anysearch', fails(new WebError('a failed', 'WEB_PROVIDER_ERROR')));
    const z = fakeEngine('zhipu', fails(new WebError('z failed', 'WEB_PROVIDER_ERROR')));
    const h = fakeEngine('engine-a', fails(new WebError('h failed', 'WEB_PROVIDER_ERROR')));
    const provider = buildProvider({ engines: [a.engine, z.engine, h.engine] });
    const error = await expectWebError(provider.search({ query: 'q' }), 'WEB_PROVIDER_ERROR');
    expect(error.message).toContain('anysearch');
    expect(error.message).toContain('a failed');
    expect(error.message).toContain('engine-a');
  });

  it('引擎全部已被熔断时同样抛 WEB_PROVIDER_ERROR，摘要标注跳过', async () => {
    const a = fakeEngine('anysearch', ok([source('https://a/1')]));
    const breaker = new CircuitBreaker();
    breaker.recordSignal('anysearch', { kind: 'quota-exhausted' });
    const provider = buildProvider({ engines: [a.engine], breaker });
    const error = await expectWebError(provider.search({ query: 'q' }), 'WEB_PROVIDER_ERROR');
    expect(error.message).toMatch(/skip|跳过/i);
    expect(a.requests).toHaveLength(0);
  });

  it('熔断引擎被跳过：不派发、记日志，其余路照常', async () => {
    const z = fakeEngine('zhipu', ok([source('https://z/1')]));
    const a = fakeEngine('anysearch', ok([source('https://a/1')]));
    const breaker = new CircuitBreaker();
    breaker.recordSignal('zhipu', { kind: 'rate-limit', retryAfterMs: 60_000 });
    const logger = recordingLogger();
    const provider = buildProvider({ engines: [z.engine, a.engine], breaker, logger });
    const out = await provider.search({ query: 'q' });
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://a/1']);
    expect(z.requests).toHaveLength(0);
    expect(a.requests).toHaveLength(1);
    expect(logger.lines.some((line) => line.includes('zhipu') && /熔断|跳过/.test(line))).toBe(true);
  });

  it('外层 abort → WEB_ABORTED，且不当作引擎失败', async () => {
    const controller = new AbortController();
    const a = fakeEngine('anysearch', async (_request, signal) => {
      controller.abort();
      await Promise.resolve();
      throw new WebError('aborted', 'WEB_ABORTED', { cause: signal?.reason });
    });
    const provider = buildProvider({ engines: [a.engine] });
    await expectWebError(provider.search({ query: 'q' }, controller.signal), 'WEB_ABORTED');
  });

  it('已 abort 的信号在派发前直接拒绝', async () => {
    const a = fakeEngine('anysearch', ok([source('https://a/1')]));
    const provider = buildProvider({ engines: [a.engine] });
    const controller = new AbortController();
    controller.abort();
    await expectWebError(provider.search({ query: 'q' }, controller.signal), 'WEB_ABORTED');
    expect(a.requests).toHaveLength(0);
  });

  it('挂住的引擎在外层 abort 时立即结束，不当成超时也不记引擎失败', async () => {
    const controller = new AbortController();
    const stuck = fakeEngine('anysearch', hangs());
    const logger = recordingLogger();
    const provider = buildProvider({ engines: [stuck.engine], logger, maxFanoutMs: 5_000 });
    const pending = provider.search({ query: 'q' }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    await expectWebError(pending, 'WEB_ABORTED');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logger.lines.some((line) => line.includes('超时'))).toBe(false);
    expect(logger.lines.some((line) => line.includes('失败'))).toBe(false);
  });

  it('available() 为真且 id 为 aggregated', () => {
    const provider = buildProvider({ engines: [] });
    expect(provider.id).toBe('aggregated');
    expect(provider.available()).toBe(true);
  });
});

describe('AggregatedSearchProvider 熔断信号转发', () => {
  it('引擎 A 30001 转发 rate-limit；智谱 429 带 Retry-After；AnySearch 402 转当日熔断', async () => {
    const a = fakeEngine(
      'anysearch',
      fails(
        new WebError('AnySearch search failed', 'WEB_PROVIDER_ERROR', {
          cause: new AnySearchClientError('quota gone', { operation: 'search', httpStatus: 402 }),
        }),
      ),
    );
    const z = fakeEngine(
      'zhipu',
      fails(
        new WebError('Zhipu web search failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
          cause: { kind: 'rate-limit', retryAfterMs: 7000 },
        }),
      ),
    );
    const h = fakeEngine(
      'engine-a',
      fails(new WebError('engine-a limited', 'WEB_PROVIDER_ERROR', { cause: { kind: 'rate-limit' } })),
    );
    const logger = recordingLogger();
    const errors: string[] = [];
    const breaker = new CircuitBreaker({
      onEvent: (event) => errors.push(`${event.type}:${event.engineId}:${event.reason}`),
    });
    const provider = buildProvider({ engines: [a.engine, z.engine, h.engine], breaker, logger });
    await expectWebError(provider.search({ query: 'q' }), 'WEB_PROVIDER_ERROR');

    expect(errors).toContain('open:anysearch:quota-exhausted');
    expect(errors).toContain('open:zhipu:rate-limit');
    expect(errors).toContain('open:engine-a:rate-limit');
    expect(breaker.isBroken('anysearch')).toBe(true);
    expect(breaker.isBroken('zhipu')).toBe(true);
    expect(breaker.isBroken('engine-a')).toBe(true);
    const status = breaker.status('zhipu');
    expect(status.broken && status.reason === 'rate-limit' && status.cooldownUntil !== undefined).toBe(true);
  });

  it('词表三值原样透传，不改名不映射', async () => {
    const z = fakeEngine(
      'zhipu',
      fails(new WebError('insufficient balance', 'WEB_PROVIDER_ERROR', { cause: { kind: 'insufficient-credits' } })),
    );
    const breaker = new CircuitBreaker();
    const provider = buildProvider({ engines: [z.engine], breaker });
    await expectWebError(provider.search({ query: 'q' }), 'WEB_PROVIDER_ERROR');
    expect(breaker.status('zhipu').reason).toBe('insufficient-credits');
  });

  it('无关失败不触发熔断', async () => {
    const z = fakeEngine('zhipu', fails(new WebError('plain failure', 'WEB_PROVIDER_ERROR')));
    const breaker = new CircuitBreaker();
    const provider = buildProvider({ engines: [z.engine], breaker });
    await expectWebError(provider.search({ query: 'q' }), 'WEB_PROVIDER_ERROR');
    expect(breaker.isBroken('zhipu')).toBe(false);
  });
});

describe('AggregatedSearchProvider 引擎 A额度日检', () => {
  function quotaEngine(remaining: number, onQuota: () => void) {
    return fakeEngine(
      'engine-a',
      ok([source('https://h/1')]),
      async () => {
        onQuota();
        return { remaining };
      },
    );
  }

  it('当日首次搜索查一次 quota，之后同日搜索不再查', async () => {
    let probes = 0;
    const h = quotaEngine(3766, () => {
      probes += 1;
    });
    const provider = buildProvider({ engines: [h.engine], now: () => Date.UTC(2026, 9, 13, 4, 0, 0) });
    await provider.search({ query: 'q1' });
    await provider.search({ query: 'q2' });
    await provider.search({ query: 'q3' });
    expect(probes).toBe(1);
  });

  it('跨自然日重新查一次', async () => {
    let probes = 0;
    let nowMs = Date.UTC(2026, 9, 13, 4, 0, 0);
    const h = quotaEngine(3766, () => {
      probes += 1;
    });
    const provider = buildProvider({ engines: [h.engine], now: () => nowMs });
    await provider.search({ query: 'q1' });
    await provider.search({ query: 'q2' });
    expect(probes).toBe(1);
    nowMs += 24 * 60 * 60 * 1000;
    await provider.search({ query: 'q3' });
    expect(probes).toBe(2);
  });

  it('remaining<=0 → recordSignal quota-exhausted，本路跳过，其余路照常', async () => {
    let probes = 0;
    const h = quotaEngine(0, () => {
      probes += 1;
    });
    const a = fakeEngine('anysearch', ok([source('https://a/1')]));
    const logger = recordingLogger();
    const breaker = new CircuitBreaker();
    const provider = buildProvider({
      engines: [a.engine, h.engine],
      breaker,
      logger,
      now: () => Date.UTC(2026, 9, 13, 4, 0, 0),
    });
    const out = await provider.search({ query: 'q' });
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://a/1']);
    expect(probes).toBe(1);
    expect(breaker.status('engine-a').reason).toBe('quota-exhausted');
    expect(h.requests).toHaveLength(0);
  });

  it('engine-aQuotaCheck=false 时不查额度', async () => {
    let probes = 0;
    const h = quotaEngine(0, () => {
      probes += 1;
    });
    const provider = buildProvider({
      engines: [h.engine],
      quotaCheck: false,
      now: () => Date.UTC(2026, 9, 13, 4, 0, 0),
    });
    await provider.search({ query: 'q' });
    expect(probes).toBe(0);
  });

  it('额度查询自身失败不阻断搜索（fail-open）', async () => {
    const h = fakeEngine(
      'engine-a',
      ok([source('https://h/1')]),
      async () => {
        throw new WebError('quota endpoint down', 'WEB_PROVIDER_ERROR');
      },
    );
    const logger = recordingLogger();
    const breaker = new CircuitBreaker();
    const provider = buildProvider({ engines: [h.engine], breaker, logger, now: () => Date.UTC(2026, 9, 13, 4, 0, 0) });
    const out = await provider.search({ query: 'q' });
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://h/1']);
    expect(breaker.isBroken('engine-a')).toBe(false);
  });
});

describe('AggregatedSearchProvider rerank', () => {
  const fusedThree = (): [FakeEngine, FakeEngine] => [
    fakeEngine('anysearch', ok([source('https://x/1', { title: 'T1', snippet: 'S1' }), source('https://x/2', { title: 'T2', snippet: 'S2' })])),
    fakeEngine('zhipu', ok([source('https://x/2', { title: 'T2', snippet: 'S2' }), source('https://x/3', { title: 'T3' })])),
  ];

  it('rerank 成功：按返回的索引重排，document 为 title+snippet 拼接，top_n=maxResults', async () => {
    const seen: { query: string; documents: readonly string[]; topN: number }[] = [];
    const [a2, z2] = fusedThree();
    const reranker = {
      rerank: async (query: string, documents: readonly string[], topN: number) => {
        seen.push({ query, documents, topN });
        return documents.map((_doc, index) => documents.length - 1 - index);
      },
    };
    const provider = buildProvider({
      engines: [a2.engine, z2.engine],
      rerank: reranker,
      maxFanoutMs: 1000,
      quotaCheck: false,
    });
    const out = await provider.search({ query: '查询词', maxResults: 3 });
    // RRF 序：x/2, x/1, x/3 → 反转后：x/3, x/1, x/2
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://x/3', 'https://x/1', 'https://x/2']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.query).toBe('查询词');
    expect(seen[0]!.documents).toEqual(['T2 S2', 'T1 S1', 'T3']);
    expect(seen[0]!.topN).toBe(3);
  });

  it('rerank 返回 null 时保持 RRF 序并记降级日志', async () => {
    const [a, z] = fusedThree();
    const logger = recordingLogger();
    let degraded = 0;
    const provider = buildProvider({
      engines: [a.engine, z.engine],
      rerank: {
        rerank: async () => {
          degraded += 1;
          return null;
        },
      },
      logger,
      quotaCheck: false,
    });
    const out = await provider.search({ query: 'q', maxResults: 10 });
    expect(degraded).toBe(1);
    expect(out.sources.map((entry) => entry.url)).toEqual(['https://x/2', 'https://x/1', 'https://x/3']);
    expect(logger.lines.some((line) => line.includes('重排') && /降级|RRF/.test(line))).toBe(true);
  });

  it('rerank 只吃 rerankPool 条，池外候选按 RRF 序跟随返回', async () => {
    const many = Array.from({ length: 6 }, (_value, index) => source(`https://x/${index}`));
    const a = fakeEngine('anysearch', ok(many));
    const docs: string[][] = [];
    const provider = buildProvider({
      engines: [a.engine],
      rerank: {
        rerank: async (_q, documents) => {
          docs.push([...documents]);
          return documents.map((_doc, index) => index);
        },
      },
      rerankPool: 3,
      quotaCheck: false,
    });
    const out = await provider.search({ query: 'q', maxResults: 10 });
    // 只有池内 3 条进重排，其余 3 条按 RRF 序跟随在重排结果之后
    expect(docs[0]).toHaveLength(3);
    expect(out.sources.map((entry) => entry.url)).toEqual([
      'https://x/0',
      'https://x/1',
      'https://x/2',
      'https://x/3',
      'https://x/4',
      'https://x/5',
    ]);
    expect(out.truncated).toBe(false);
  });
});

describe('AggregatedSearchProvider 截断语义', () => {
  it('池大于 maxResults 时截断并置 truncated=true', async () => {
    const many = Array.from({ length: 5 }, (_value, index) => source(`https://x/${index}`));
    const a = fakeEngine('anysearch', ok(many));
    const provider = buildProvider({ engines: [a.engine], quotaCheck: false });
    const out = await provider.search({ query: 'q', maxResults: 2 });
    expect(out.sources).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it('maxResults 大于 rerank 池时仍返回足量（池外候选按 RRF 序跟随）', async () => {
    const many = Array.from({ length: 5 }, (_value, index) => source(`https://x/${index}`));
    const a = fakeEngine('anysearch', ok(many));
    const seen: number[] = [];
    const provider = buildProvider({
      engines: [a.engine],
      rerank: {
        rerank: async (_q, documents) => {
          seen.push(documents.length);
          return documents.map((_doc, index) => index);
        },
      },
      rerankPool: 2,
      quotaCheck: false,
    });
    const out = await provider.search({ query: 'q', maxResults: 4 });
    expect(seen).toEqual([2]);
    expect(out.sources.map((entry) => entry.url)).toEqual([
      'https://x/0',
      'https://x/1',
      'https://x/2',
      'https://x/3',
    ]);
    expect(out.truncated).toBe(true);
  });

  it('池不大于 maxResults 时不截断、truncated=false', async () => {
    const a = fakeEngine('anysearch', ok([source('https://x/0'), source('https://x/1')]));
    const provider = buildProvider({ engines: [a.engine], quotaCheck: false });
    const out = await provider.search({ query: 'q', maxResults: 5 });
    expect(out.sources).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it('未给 maxResults 时返回全部且 truncated=false', async () => {
    const many = Array.from({ length: 4 }, (_value, index) => source(`https://x/${index}`));
    const a = fakeEngine('anysearch', ok(many));
    const provider = buildProvider({ engines: [a.engine], quotaCheck: false });
    const out = await provider.search({ query: 'q' });
    expect(out.sources).toHaveLength(4);
    expect(out.truncated).toBe(false);
  });
});

describe('AggregatedSearchProvider publishedAt 直通', () => {
  it('publishedAt 原样穿过融合、重排与截断', async () => {
    const sources = [
      source('https://example.com/a', { publishedAt: '2025-05-23' }),
      source('https://example.com/b', { publishedAt: new Date(1748261757 * 1000).toISOString() }),
    ];
    const provider = buildProvider({
      engines: [{ id: 'engine-a', search: async () => result(sources) }],
      rerank: { rerank: async (_q, documents) => documents.map((_doc, index) => index) },
      quotaCheck: false,
    });
    const out = await provider.search({ query: 'q', maxResults: 10 });
    const byUrl = new Map(out.sources.map((entry) => [entry.url, entry.publishedAt]));
    expect(byUrl.get('https://example.com/a')).toBe('2025-05-23');
    expect(byUrl.get('https://example.com/b')).toBe(new Date(1748261757 * 1000).toISOString());
  });
});
