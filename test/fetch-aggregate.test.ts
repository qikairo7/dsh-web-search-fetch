import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { CircuitBreaker } from '../src/breaker/index.js';
import { AnySearchClientError } from '../src/engines/anysearch/error.js';
import { FirecrawlError } from '../src/engines/firecrawl/client.js';
import { additionalBreakerSignal } from '../src/engines/additional/http.js';
import {
  aggregateDynamicFetch,
  anysearchBreakerSignal,
  bodyFingerprint,
  classifyFetchRoute,
  extractBodyTitle,
  extractUrlSlug,
  firecrawlBreakerSignal,
  isUsableCandidate,
  scoreCandidate,
  selectBestCandidate,
  titleSimilarity,
} from '../src/fetch-aggregate.js';
import type { FetchEngineLeg, FetchPipelineLogger } from '../src/fetch-aggregate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REQUEST_URL = 'https://blog.example.com/posts/example-domain-guide';

function textResult(content: string, statusCode = 200, url = REQUEST_URL): WebFetchResult {
  return { url, statusCode, body: { kind: 'text', content }, truncated: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CountedLeg extends FetchEngineLeg {
  calls: number;
}

/** A leg that always succeeds with `content` after an optional delay. */
function okLeg(
  engineId: string,
  content: string,
  options: { statusCode?: number; delayMs?: number } = {},
): CountedLeg {
  const leg: CountedLeg = {
    engineId,
    calls: 0,
    async extract() {
      leg.calls += 1;
      if (options.delayMs !== undefined) await sleep(options.delayMs);
      return textResult(content, options.statusCode ?? 200);
    },
  };
  return leg;
}

/** A leg that always throws `error`; optional breaker-signal reader attached. */
function failingLeg(
  engineId: string,
  error: unknown,
  signalOf?: (error: unknown) => ReturnType<typeof firecrawlBreakerSignal>,
): CountedLeg {
  const leg: CountedLeg = {
    engineId,
    calls: 0,
    async extract() {
      leg.calls += 1;
      throw error;
    },
    ...(signalOf === undefined ? {} : { signalOf }),
  };
  return leg;
}

/** A leg that never resolves until its signal aborts (simulating a hung engine). */
function hangingLeg(engineId: string): CountedLeg {
  const leg: CountedLeg = {
    engineId,
    calls: 0,
    extract(_url, signal) {
      leg.calls += 1;
      return new Promise<WebFetchResult>((_resolve, reject) => {
        const fail = (): void => {
          reject(new WebError(`${engineId} aborted`, 'WEB_ABORTED'));
        };
        if (signal?.aborted === true) fail();
        else signal?.addEventListener('abort', fail, { once: true });
      });
    },
  };
  return leg;
}

function captureLogger(): { lines: { level: string; message: string }[]; logger: FetchPipelineLogger } {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => lines.push({ level: 'info', message }),
      warn: (message: string) => lines.push({ level: 'warn', message }),
    },
  };
}

function joinLogs(lines: { level: string; message: string }[]): string {
  return lines.map((line) => line.message).join('\n');
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

// ---------------------------------------------------------------------------
// URL 感知分流（纯函数规则表）
// ---------------------------------------------------------------------------

describe('classifyFetchRoute 静态判定', () => {
  it('明确静态扩展名 → static（大小写不敏感、忽略查询串）', () => {
    expect(classifyFetchRoute('https://example.com/report.csv?download=1')).toBe('static');
    expect(classifyFetchRoute('https://example.com/NOTES.TXT')).toBe('static');
    expect(classifyFetchRoute('https://example.com/page.md')).toBe('static');
    expect(classifyFetchRoute('https://example.com/feed.xml#top')).toBe('static');
    expect(classifyFetchRoute('https://example.com/data.json')).toBe('static');
    expect(classifyFetchRoute('https://example.com/rows.tsv')).toBe('static');
  });

  it('PDF、.html、未知扩展、无扩展、目录路径 → dynamic', () => {
    expect(classifyFetchRoute('https://example.com/paper.pdf')).toBe('dynamic');
    expect(classifyFetchRoute('https://example.com/index.html')).toBe('dynamic');
    expect(classifyFetchRoute('https://example.com/api/v1/items')).toBe('dynamic');
    expect(classifyFetchRoute('https://example.com/')).toBe('dynamic');
    expect(classifyFetchRoute('https://example.com/blog/')).toBe('dynamic');
    expect(classifyFetchRoute('https://example.com/archive.tar.gz')).toBe('dynamic');
  });

  it('配置的静态域名画像：主机相等或子域命中', () => {
    const options = { staticDomains: ['docs.example.com'] };
    expect(classifyFetchRoute('https://docs.example.com/a/b', options)).toBe('static');
    expect(classifyFetchRoute('https://cdn.docs.example.com/a/b', options)).toBe('static');
    expect(classifyFetchRoute('https://example.com/a/b', options)).toBe('dynamic');
    // 后缀边界：必须以点分隔，`evildocs.example.com` 不命中 `docs.example.com`。
    expect(classifyFetchRoute('https://evildocs.example.com/a/b', options)).toBe('dynamic');
  });

  it('静态域名画像对带扩展名的路径同样生效（域名优先）', () => {
    const options = { staticDomains: ['static.example.net'] };
    expect(classifyFetchRoute('https://static.example.net/anything.pdf', options)).toBe('static');
  });

  it('非 http(s) 或不可解析 URL → static（交由 http 路给出 WEB_INVALID_URL）', () => {
    expect(classifyFetchRoute('ftp://example.com/file')).toBe('static');
    expect(classifyFetchRoute('not a url')).toBe('static');
  });

  it('分流开关关闭 → 一律 static（http 单发）', () => {
    expect(classifyFetchRoute('https://example.com/api/v1/items', { enabled: false })).toBe('static');
  });

  it('staticExtensions 覆盖默认表', () => {
    expect(classifyFetchRoute('https://example.com/paper.pdf', { staticExtensions: ['pdf'] })).toBe(
      'static',
    );
    expect(classifyFetchRoute('https://example.com/notes.txt', { staticExtensions: ['pdf'] })).toBe(
      'dynamic',
    );
    // 条目可以带点、大小写混杂，内部规范化。
    expect(classifyFetchRoute('https://example.com/a.CSV', { staticExtensions: ['.csv'] })).toBe(
      'static',
    );
  });
});

// ---------------------------------------------------------------------------
// 质量信号（纯函数）
// ---------------------------------------------------------------------------

describe('候选有效性与质量分', () => {
  it('空正文 / 纯空白正文视为无效', () => {
    expect(isUsableCandidate(textResult(''))).toBe(false);
    expect(isUsableCandidate(textResult('   \n\t  '))).toBe(false);
    expect(isUsableCandidate(textResult('non-empty'))).toBe(true);
  });

  it('scoreCandidate：权重 + 长度分 + 密度分 + 标题匹配分', () => {
    const url = 'https://example.com/docs/example-domain';
    const content = '# Example Domain\n\nClean prose body.';
    const scored = scoreCandidate('firecrawl', textResult(content), url);
    expect(scored.engineId).toBe('firecrawl');
    expect(scored.breakdown.weight).toBe(3);
    expect(scored.breakdown.titleMatch).toBeCloseTo(1.5, 10);
    expect(scored.score).toBeCloseTo(
      scored.breakdown.weight +
        scored.breakdown.length +
        scored.breakdown.density +
        scored.breakdown.titleMatch,
      10,
    );
  });

  it('长度分封顶：更长的正文得分更高但不超过上限', () => {
    const short = scoreCandidate('anysearch', textResult('x'.repeat(100)), REQUEST_URL);
    const long = scoreCandidate('anysearch', textResult('x'.repeat(10_000)), REQUEST_URL);
    expect(long.breakdown.length).toBeGreaterThan(short.breakdown.length);
    expect(long.breakdown.length).toBeLessThanOrEqual(2);
  });

  it('标题匹配分：slug 词元命中正文标题得分更高', () => {
    const matched = scoreCandidate('anysearch', textResult('# Example Domain Guide\n\nbody'), REQUEST_URL);
    const unmatched = scoreCandidate('anysearch', textResult('# 完全无关\n\nbody'), REQUEST_URL);
    expect(matched.breakdown.titleMatch).toBeGreaterThan(unmatched.breakdown.titleMatch);
  });

  it('未知引擎 id 退化为默认权重', () => {
    const scored = scoreCandidate('mystery-engine', textResult('body'), REQUEST_URL);
    expect(scored.breakdown.weight).toBe(2);
  });

  it('selectBestCandidate：取最高分，平手时先到先得', () => {
    const url = 'https://example.com/docs/example-domain';
    const candidates = [
      { engineId: 'firecrawl', result: textResult('short', 200, url) },
      { engineId: 'tavily', result: textResult('# Example Domain\n\n' + 'long body '.repeat(200), 200, url) },
    ];
    // 默认权重下质量信号仍可越过 firecrawl 的权重优势：长正文且标题匹配的一路胜出。
    const selection = selectBestCandidate(url, candidates, {});
    expect(selection.best?.engineId).toBe('tavily');

    const tie = selectBestCandidate(
      url,
      [
        { engineId: 'a', result: textResult('# Same\n\nidentical', 200, url) },
        { engineId: 'b', result: textResult('# Same\n\nidentical', 200, url) },
      ],
      {},
    );
    expect(tie.best?.engineId).toBe('a');
  });
});

describe('标题相似度与正文哈希（一致性信号素材）', () => {
  it('extractUrlSlug：末段去扩展、分隔符归一、小写', () => {
    expect(extractUrlSlug('https://example.com/blog/Hello_World-page.html?x=1')).toBe('hello world page');
    expect(extractUrlSlug('https://example.com/')).toBe('');
    expect(extractUrlSlug('nonsense')).toBe('');
  });

  it('extractBodyTitle：优先取前 500 字内的第一个 markdown 标题，否则首个非空行', () => {
    expect(extractBodyTitle('some paragraph\n\n# The Real Title\n\nmore')).toBe('The Real Title');
    expect(extractBodyTitle('plain first line\nsecond line')).toBe('plain first line');
    expect(extractBodyTitle('   \n\n  ')).toBe('');
  });

  it('titleSimilarity：Jaccard 词元相似度，空输入得 0', () => {
    expect(titleSimilarity('Example Domain', 'example domain')).toBe(1);
    expect(titleSimilarity('example domain', 'Example Domain — Full Guide')).toBeCloseTo(0.5, 10);
    expect(titleSimilarity('alpha', 'beta')).toBe(0);
    expect(titleSimilarity('', 'anything')).toBe(0);
  });

  it('bodyFingerprint：sha1 十六进制前 8 位，内容不同则哈希不同', () => {
    const hash = bodyFingerprint('same body');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(bodyFingerprint('same body')).toBe(hash);
    expect(bodyFingerprint('other body')).not.toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// 熔断信号读取（词表直传，不改名）
// ---------------------------------------------------------------------------

describe('引擎熔断信号读取', () => {
  it('firecrawl：classification.breaker 的 signal 直传', () => {
    const rateLimited = new FirecrawlError('429', 'WEB_PROVIDER_ERROR', {
      class: 'breaker',
      status: 429,
      signal: { kind: 'rate-limit', retryAfterMs: 5_000 },
    });
    expect(firecrawlBreakerSignal(rateLimited)).toEqual({ kind: 'rate-limit', retryAfterMs: 5_000 });

    const noCredits = new FirecrawlError('402', 'WEB_PROVIDER_ERROR', {
      class: 'breaker',
      status: 402,
      signal: { kind: 'insufficient-credits' },
    });
    expect(firecrawlBreakerSignal(noCredits)).toEqual({ kind: 'insufficient-credits' });

    const fatal = new FirecrawlError('404', 'WEB_BLOCKED_URL', { class: 'fatal', status: 404 });
    expect(firecrawlBreakerSignal(fatal)).toBeUndefined();
    expect(firecrawlBreakerSignal(new Error('nope'))).toBeUndefined();
  });

  it('HTTP 引擎：429 挂在 cause 上的 rate-limit 信号', () => {
    const error = new WebError('HTTP engine failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
      cause: { kind: 'rate-limit', retryAfterMs: 30_000 },
    });
    expect(additionalBreakerSignal(error)).toEqual({ kind: 'rate-limit', retryAfterMs: 30_000 });
    expect(additionalBreakerSignal(new WebError('boom', 'WEB_PROVIDER_ERROR'))).toBeUndefined();
  });

  it('anysearch：rate-limit / quota-exhausted 两种 kind 透传', () => {
    const rateLimited = new AnySearchClientError('throttled', {
      operation: 'extract',
      httpStatus: 429,
      retryAfter: '12',
    });
    expect(anysearchBreakerSignal(new WebError('wrapped', 'WEB_PROVIDER_ERROR', { cause: rateLimited }))).toEqual(
      { kind: 'rate-limit', retryAfterMs: 12_000 },
    );

    const exhausted = new AnySearchClientError('no balance', { operation: 'extract', httpStatus: 402 });
    expect(anysearchBreakerSignal(exhausted)).toEqual({ kind: 'quota-exhausted' });

    const blocked = new AnySearchClientError('blocked target', {
      operation: 'extract',
      errorCode: 'extract_target_blocked',
    });
    expect(anysearchBreakerSignal(blocked)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 动态路径编排（mock 引擎客户端注入）
// ---------------------------------------------------------------------------

describe('aggregateDynamicFetch 编排', () => {
  it('三路并发派发（不是串行回退）', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const makeLeg = (engineId: string, content: string): FetchEngineLeg => ({
      engineId,
      async extract() {
        started.push(engineId);
        await gate;
        return textResult(content);
      },
    });
    const pending = aggregateDynamicFetch({
      url: REQUEST_URL,
      legs: [makeLeg('firecrawl', 'a'), makeLeg('tavily', 'b'), makeLeg('anysearch', 'c')],
      perEngineTimeoutMs: 5_000,
    });
    await sleep(20);
    expect(started).toEqual(['firecrawl', 'tavily', 'anysearch']);
    release();
    await pending;
  });

  it('质量差异夹具：firecrawl 权重与质量均占优时胜出', async () => {
    const url = REQUEST_URL;
    const firecrawlBody = '# Example Domain Guide\n\n' + 'This domain is for use in illustrative examples in documents. '.repeat(70);
    const legs = [
      okLeg('firecrawl', firecrawlBody),
      okLeg('tavily', '# 相关文章\n\nshort.'),
      okLeg('anysearch', 'tiny'),
    ];
    const result = await aggregateDynamicFetch({ url, legs });
    expect(result.body.kind).toBe('text');
    expect(result.body.content).toBe(firecrawlBody);
    expect(legs.map((leg) => leg.calls)).toEqual([1, 1, 1]);
  });

  it('质量差异夹具：正文质量显著更高的一路可以越过引擎权重', async () => {
    const url = REQUEST_URL;
    const tavilyBody = '# Example Domain Guide\n\n' + 'This domain is for use in illustrative examples in documents. '.repeat(70);
    const firecrawlBody = '# Stub\n\nstub.';
    const anysearchBody = '# Example Domain Guide\n\n' + 'Half length. '.repeat(90);
    const legs = [
      okLeg('firecrawl', firecrawlBody),
      okLeg('tavily', tavilyBody),
      okLeg('anysearch', anysearchBody),
    ];
    const scores = [
      scoreCandidate('firecrawl', textResult(firecrawlBody, 200, url), url),
      scoreCandidate('tavily', textResult(tavilyBody, 200, url), url),
      scoreCandidate('anysearch', textResult(anysearchBody, 200, url), url),
    ];
    const tavilyScore = scores[1]!.score;
    expect(tavilyScore).toBeGreaterThan(scores[0]!.score);
    expect(tavilyScore).toBeGreaterThan(scores[2]!.score);

    const result = await aggregateDynamicFetch({ url, legs });
    expect(result.body.kind).toBe('text');
    expect(result.body.content).toBe(tavilyBody);
  });

  it('单路失败时在剩余候选中择优，并向熔断器转发失败信号', async () => {
    const breaker = new CircuitBreaker();
    const rateLimited = new FirecrawlError('Firecrawl scrape failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
      class: 'breaker',
      status: 429,
      signal: { kind: 'rate-limit', retryAfterMs: 5_000 },
    });
    const legs = [
      failingLeg('firecrawl', rateLimited, firecrawlBreakerSignal),
      okLeg('tavily', '# Example Domain Guide\n\ntavily body'),
      okLeg('anysearch', 'short'),
    ];
    const { lines, logger } = captureLogger();
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs, breaker, logger });
    expect(result.body.content).toContain('tavily body');
    expect(breaker.isBroken('firecrawl')).toBe(true);
    expect(breaker.status('firecrawl')).toMatchObject({ broken: true, reason: 'rate-limit' });
    expect(joinLogs(lines)).toContain('firecrawl');
  });

  it('HTTP 引擎 429 与 anysearch 402 各自触发对应熔断', async () => {
    const breaker = new CircuitBreaker();
    const tavilyError = new WebError('HTTP engine failed with HTTP 429', 'WEB_PROVIDER_ERROR', {
      cause: { kind: 'rate-limit' },
    });
    const anysearchError = new AnySearchClientError('no balance', { operation: 'extract', httpStatus: 402 });
    const legs = [
      failingLeg('tavily', tavilyError, additionalBreakerSignal),
      failingLeg('anysearch', anysearchError, anysearchBreakerSignal),
      okLeg('firecrawl', '# Example Domain Guide\n\nfirecrawl body'),
    ];
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs, breaker });
    expect(result.body.content).toContain('firecrawl body');
    expect(breaker.status('tavily')).toMatchObject({ broken: true, reason: 'rate-limit' });
    expect(breaker.status('anysearch')).toMatchObject({ broken: true, reason: 'quota-exhausted' });
  });

  it('熔断引擎跳过并记日志：零派发', async () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('firecrawl', { kind: 'insufficient-credits' });
    const legs = [
      okLeg('firecrawl', 'should not be called'),
      okLeg('tavily', '# Example Domain Guide\n\ntavily body'),
    ];
    const { lines, logger } = captureLogger();
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs, breaker, logger });
    expect(legs[0]!.calls).toBe(0);
    expect(legs[1]!.calls).toBe(1);
    expect(result.body.content).toContain('tavily body');
    expect(joinLogs(lines)).toContain('熔断');
  });

  it('全部引擎都被熔断 → WEB_PROVIDER_ERROR，零派发', async () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('firecrawl', { kind: 'quota-exhausted' });
    breaker.recordSignal('tavily', { kind: 'insufficient-credits' });
    breaker.recordSignal('anysearch', { kind: 'rate-limit' });
    const legs = [okLeg('firecrawl', 'a'), okLeg('tavily', 'b'), okLeg('anysearch', 'c')];
    const error = await catchError(aggregateDynamicFetch({ url: REQUEST_URL, legs, breaker }));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    expect(legs.map((leg) => leg.calls)).toEqual([0, 0, 0]);
  });

  it('单路限时：悬挂的一路被丢弃，其余正常择优', async () => {
    const legs = [hangingLeg('tavily'), okLeg('firecrawl', '# Example Domain Guide\n\nfirecrawl body')];
    const { lines, logger } = captureLogger();
    const result = await aggregateDynamicFetch({
      url: REQUEST_URL,
      legs,
      perEngineTimeoutMs: 25,
      logger,
    });
    expect(result.body.content).toContain('firecrawl body');
    expect(legs[0]!.calls).toBe(1);
    expect(joinLogs(lines)).toContain('超时');
  });

  it('忽略取消信号的慢引擎到期被丢弃，迟到正文不参与择优', async () => {
    const result = await aggregateDynamicFetch({
      url: REQUEST_URL,
      legs: [okLeg('firecrawl', 'late body', { delayMs: 100 }), okLeg('anysearch', 'on time')],
      perEngineTimeoutMs: 10,
    });
    expect(result.body.content).toBe('on time');
  });

  it('并发结果同分时按派发顺序择优，而非响应先后', async () => {
    const result = await aggregateDynamicFetch({
      url: REQUEST_URL,
      legs: [okLeg('first', 'aaaa', { delayMs: 20 }), okLeg('second', 'bbbb')],
    });
    expect(result.body.content).toBe('aaaa');
  });

  it('全败：取最具体的一路错误码（WEB_BLOCKED_URL 优先于 WEB_PROVIDER_ERROR）', async () => {
    const blocked = new FirecrawlError('Firecrawl scrape failed with HTTP 404', 'WEB_BLOCKED_URL', {
      class: 'fatal',
      status: 404,
    });
    const provider = new WebError('HTTP engine returned empty content', 'WEB_PROVIDER_ERROR');
    const legs = [
      failingLeg('firecrawl', blocked),
      failingLeg('tavily', provider),
      failingLeg('anysearch', new WebError('AnySearch extract failed', 'WEB_PROVIDER_ERROR')),
    ];
    const error = await catchError(aggregateDynamicFetch({ url: REQUEST_URL, legs }));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_BLOCKED_URL');
    expect((error as WebError).message).toContain('firecrawl');
  });

  it('200 但正文为空/纯白空的候选不给分；全部为空视为全败', async () => {
    const legs = [
      okLeg('firecrawl', '   \n  '),
      okLeg('tavily', ''),
      okLeg('anysearch', '# Example Domain Guide\n\nreal body'),
    ];
    const { lines, logger } = captureLogger();
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs, logger });
    expect(result.body.content).toContain('real body');
    expect(joinLogs(lines)).toContain('空正文');

    const emptyOnly = [okLeg('firecrawl', ''), okLeg('tavily', '  ')];
    const error = await catchError(aggregateDynamicFetch({ url: REQUEST_URL, legs: emptyOnly }));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    expect((error as WebError).message.toLowerCase()).toContain('empty');
  });

  it('目标站非 2xx 但有正文 → result（statusCode 原样），不 throw', async () => {
    const legs = [
      okLeg('firecrawl', '# Example Domain Guide\n\n404 page still has a body', { statusCode: 404 }),
      failingLeg('tavily', new WebError('nope', 'WEB_PROVIDER_ERROR')),
    ];
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs });
    expect(result.statusCode).toBe(404);
    expect(result.body.content).toContain('404 page still has a body');
  });

  it('外层 abort → WEB_ABORTED（未派发时立即中止）', async () => {
    const controller = new AbortController();
    controller.abort();
    const legs = [okLeg('firecrawl', 'a'), okLeg('tavily', 'b')];
    const error = await catchError(
      aggregateDynamicFetch({ url: REQUEST_URL, legs, signal: controller.signal }),
    );
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_ABORTED');
    expect(legs.map((leg) => leg.calls)).toEqual([0, 0]);
  });

  it('外层 abort → WEB_ABORTED（飞行中中止悬挂的路）', async () => {
    const controller = new AbortController();
    const legs = [hangingLeg('firecrawl'), hangingLeg('tavily')];
    const pending = aggregateDynamicFetch({
      url: REQUEST_URL,
      legs,
      perEngineTimeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const error = await catchError(pending);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_ABORTED');
  });

  it('一致性信号进日志、不改变返回值', async () => {
    const body = '# Shared Title\n\n' + 'content '.repeat(50);
    const legs = [
      okLeg('firecrawl', body),
      okLeg('tavily', body),
      okLeg('anysearch', '# Other\n\nnothing shared'),
    ];
    const { lines, logger } = captureLogger();
    const result = await aggregateDynamicFetch({ url: REQUEST_URL, legs, logger });
    // 返回值与择优路逐字段一致，一致性信号只出现在日志里。
    expect(result).toEqual(textResult(body));
    const joined = joinLogs(lines);
    expect(joined).toContain('一致性信号');
    expect(joined).toContain(bodyFingerprint(body));
    // firecrawl 与 tavily 返回同一正文：标题相似度 1.00。
    expect(joined).toContain('1.00');
    // 择优路与哈希都带引擎标注，便于人工核对一致性。
    expect(joined).toContain('firecrawl');
    expect(joined).toContain('tavily');
  });
});
