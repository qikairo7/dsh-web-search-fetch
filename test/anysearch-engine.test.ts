/**
 * Contract tests for the AnySearch engine faces (`search` / `extract`): the
 * seam mapping, the reference implementation's Extract error-code translations,
 * and the classification the quota circuit breaker (#7) consumes. All HTTP is
 * served by the local mock server.
 */
import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
// Side effect: refuse any non-loopback request, so this suite cannot reach the real API.
import './helpers/anysearch-network-guard.js';
import {
  AnySearchEngine,
  failureSignalOf,
  mapExtractErrorCodeToWebErrorCode,
  type AnySearchEngineOptions,
} from '../src/engines/anysearch/index.js';
import { readFixtureJson } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

function createEngine(
  server: MockServer,
  overrides: Partial<AnySearchEngineOptions> = {},
): AnySearchEngine {
  return new AnySearchEngine({
    resolveApiKey: async () => 'as_sk_test_key',
    credentialName: 'ANYSEARCH_API_KEY',
    baseURL: server.url,
    ...overrides,
  });
}

/** Answer every request with one JSON body and status. */
function responder(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return (_request: unknown, response: import('node:http').ServerResponse): void => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

/** Run a promise and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('AnySearchEngine.search', () => {
  it('正常路径映射为 seam sources，truncated=false', async () => {
    const server = await startMockServer(responder(readFixtureJson('anysearch-search-response.json')));
    try {
      const result = await createEngine(server).search({ query: 'x', maxResults: 10 });
      expect(result).toEqual({
        sources: [
          { url: 'https://a.example.com/one', title: 'Result A', snippet: 'First summary' },
          { url: 'https://b.example.com/two', title: 'Result B', snippet: 'Second summary' },
        ],
        truncated: false,
      });
      // maxResults 透传成 max_results（上游限流是一次成本优化）
      expect(JSON.parse(server.requests[0]!.body)).toEqual({ query: 'x', max_results: 10 });
    } finally {
      await server.close();
    }
  });

  it('无 url 的结构化结果在 seam 映射层被过滤（seam source 必须有 url）', async () => {
    const server = await startMockServer(
      responder({
        code: 0,
        message: 'success',
        data: {
          results: [
            { title: 'Web source', url: 'https://source.test/result', snippet: 'S' },
            { title: 'Finance data', url: '', content: '{"close":1272.75}' },
            { title: 'Relative', url: '/not-absolute', content: 'discarded' },
          ],
          metadata: { total_results: 3, search_time_ms: 9 },
        },
      }),
    );
    try {
      const result = await createEngine(server).search({ query: 'x' });
      expect(result.sources).toEqual([
        { url: 'https://source.test/result', title: 'Web source', snippet: 'S' },
      ]);
    } finally {
      await server.close();
    }
  });

  it('search 面失败 → WEB_PROVIDER_ERROR（不泄漏 extract 专属码）', async () => {
    const server = await startMockServer(
      responder({ code: -1, error_code: 'extract_target_blocked', message: 'x', data: null }, 403),
    );
    try {
      const error = await catchError(createEngine(server).search({ query: 'x' }));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    } finally {
      await server.close();
    }
  });

  it('外层中止 → WEB_ABORTED', async () => {
    const server = await startMockServer(responder({}));
    try {
      const controller = new AbortController();
      controller.abort();
      const error = await catchError(createEngine(server).search({ query: 'x' }, controller.signal));
      expect((error as WebError).code).toBe('WEB_ABORTED');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('凭证未配置（无 resolver）→ WEB_PROVIDER_ERROR，且不发请求', async () => {
    const server = await startMockServer(responder({}));
    try {
      const engine = new AnySearchEngine({ baseURL: server.url });
      const error = await catchError(engine.search({ query: 'x' }));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('AnySearchEngine.extract', () => {
  it('正常路径映射为 WebFetchResult（text 正文、状态码 200）', async () => {
    const server = await startMockServer(responder(readFixtureJson('anysearch-extract-response.json')));
    try {
      const result = await createEngine(server).extract({ url: 'https://example.com/article' });
      expect(result).toEqual({
        url: 'https://example.com/article',
        statusCode: 200,
        body: { kind: 'text', content: '# Example article\n\nCleaned body.' },
        truncated: false,
      });
      expect(server.requests[0]!.url).toBe('/v1/extract');
    } finally {
      await server.close();
    }
  });

  it('available() 透传客户端的本地判定', async () => {
    const server = await startMockServer(responder({}));
    try {
      expect(createEngine(server).available()).toBe(true);
      expect(createEngine(server, { baseURL: 'file:///tmp/api' }).available()).toBe(false);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it.each([
    ['extract_canceled', 'WEB_ABORTED'],
    ['invalid_extract_url', 'WEB_INVALID_URL'],
    ['extract_target_blocked', 'WEB_BLOCKED_URL'],
    ['extract_content_too_large', 'WEB_FETCH_TOO_LARGE'],
    ['extract_unsupported_content', 'WEB_UNSUPPORTED_CONTENT_TYPE'],
    ['extract_timeout', 'WEB_FETCH_TIMEOUT'],
  ])('错误码 %s → %s（对齐参考实现的六组映射）', async (errorCode, webCode) => {
    const server = await startMockServer(
      responder({ code: -1, message: 'Safe Extract failure.', request_id: 'req_failed', error_code: errorCode, data: null }, 502),
    );
    try {
      const error = await catchError(
        createEngine(server).extract({ url: 'https://example.test/article' }),
      );
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe(webCode);
    } finally {
      await server.close();
    }
  });

  it('未知 extract 错误码 → WEB_PROVIDER_ERROR（对齐参考实现的兜底）', async () => {
    const server = await startMockServer(
      responder({ code: -1, message: 'x', error_code: 'extract_proxy_unavailable', data: null }, 502),
    );
    try {
      const error = await catchError(
        createEngine(server).extract({ url: 'https://example.test/a' }),
      );
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    } finally {
      await server.close();
    }
  });

  it('外层中止（未发请求）→ WEB_ABORTED', async () => {
    const server = await startMockServer(responder({}));
    try {
      const controller = new AbortController();
      controller.abort();
      const error = await catchError(
        createEngine(server).extract({ url: 'https://example.test/a' }, controller.signal),
      );
      expect((error as WebError).code).toBe('WEB_ABORTED');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('纯映射函数：mapExtractErrorCodeToWebErrorCode', () => {
  it('六组映射逐条成立', () => {
    expect(mapExtractErrorCodeToWebErrorCode('extract_canceled')).toBe('WEB_ABORTED');
    expect(mapExtractErrorCodeToWebErrorCode('invalid_extract_url')).toBe('WEB_INVALID_URL');
    expect(mapExtractErrorCodeToWebErrorCode('extract_target_blocked')).toBe('WEB_BLOCKED_URL');
    expect(mapExtractErrorCodeToWebErrorCode('extract_content_too_large')).toBe('WEB_FETCH_TOO_LARGE');
    expect(mapExtractErrorCodeToWebErrorCode('extract_unsupported_content')).toBe(
      'WEB_UNSUPPORTED_CONTENT_TYPE',
    );
    expect(mapExtractErrorCodeToWebErrorCode('extract_timeout')).toBe('WEB_FETCH_TIMEOUT');
  });

  it('undefined 与未知码都兜底为 WEB_PROVIDER_ERROR', () => {
    expect(mapExtractErrorCodeToWebErrorCode(undefined)).toBe('WEB_PROVIDER_ERROR');
    expect(mapExtractErrorCodeToWebErrorCode('something_new')).toBe('WEB_PROVIDER_ERROR');
  });
});

describe('熔断信号（#7 消费面）', () => {
  it('429 → rate-limit，可从 WebError.cause 读出', async () => {
    const server = await startMockServer(
      responder({ code: 42903, message: 'rate_limit_exceeded', request_id: 'req_x', data: null }, 429, {
        'retry-after': '12',
      }),
    );
    try {
      const error = await catchError(createEngine(server).search({ query: 'x' }));
      expect(error).toBeInstanceOf(WebError);
      // 向上是 seam 的 WEB_ERROR，分类信号挂在 cause 上：不向上抛死也不丢信息。
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect(failureSignalOf(error)).toMatchObject({
        kind: 'rate-limit',
        operation: 'search',
        httpStatus: 429,
        requestId: 'req_x',
        retryAfterMs: 12_000,
      });
    } finally {
      await server.close();
    }
  });

  it('402 → quota-exhausted', async () => {
    const server = await startMockServer(
      responder({ code: 40201, message: 'insufficient balance', data: null }, 402),
    );
    try {
      const error = await catchError(createEngine(server).search({ query: 'x' }));
      expect(failureSignalOf(error)?.kind).toBe('quota-exhausted');
    } finally {
      await server.close();
    }
  });

  it('error_code 里的额度词即使 200 也判定为 quota-exhausted', async () => {
    const server = await startMockServer(
      responder({ code: -1, error_code: 'account_quota_exhausted', message: 'no quota', data: null }, 200),
    );
    try {
      const error = await catchError(createEngine(server).extract({ url: 'https://example.test/a' }));
      expect(failureSignalOf(error)?.kind).toBe('quota-exhausted');
    } finally {
      await server.close();
    }
  });

  it('非本引擎的错误 → failureSignalOf 返回 undefined（管线可区分来源）', () => {
    expect(failureSignalOf(new WebError('other engine', 'WEB_PROVIDER_ERROR'))).toBeUndefined();
    expect(failureSignalOf(new Error('boom'))).toBeUndefined();
  });

  it('凭证未配置与占位 key 都归类为 config，不误报为额度问题', async () => {
    const server = await startMockServer(responder({}));
    try {
      for (const value of [undefined, 'as_sk_your_key']) {
        const error = await catchError(
          createEngine(server, { resolveApiKey: async () => value }).search({ query: 'x' }),
        );
        expect(failureSignalOf(error)?.kind).toBe('config');
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('熔断器输入兼容（#7）：kind 落在 BreakerReason 集合内，retryAfterMs 可直接喂', async () => {
    // #7 落在 main 上的 BreakerReason 取值。这里以字符串字面量钉住契约，
    // 避免本分支 import main 的模块（分支未合，import 会编译不过）。
    const breakerReasons = ['rate-limit', 'quota-exhausted', 'insufficient-credits'] as const;

    const limited = await startMockServer(
      responder({ code: 42903, message: 'rate_limit_exceeded', data: null }, 429, {
        'retry-after': '45',
      }),
    );
    try {
      const error = await catchError(createEngine(limited).search({ query: 'x' }));
      const signal = failureSignalOf(error)!;
      expect(breakerReasons).toContain(signal.kind as (typeof breakerReasons)[number]);
      expect(signal.retryAfterMs).toBe(45_000);
      // BreakerSignal 的形状：{kind, retryAfterMs?}
      expect({ kind: signal.kind, retryAfterMs: signal.retryAfterMs }).toEqual({
        kind: 'rate-limit',
        retryAfterMs: 45_000,
      });
    } finally {
      await limited.close();
    }

    const spent = await startMockServer(
      responder({ code: 40201, message: 'insufficient credits', data: null }, 402),
    );
    try {
      const signal = failureSignalOf(
        await catchError(createEngine(spent).search({ query: 'x' })),
      )!;
      expect(breakerReasons).toContain(signal.kind as (typeof breakerReasons)[number]);
      expect(signal.kind).toBe('quota-exhausted');
      // 额度耗尽没有 Retry-After 语义：不塞 0，让熔断器按「当日停用」处理。
      expect(signal.retryAfterMs).toBeUndefined();
    } finally {
      await spent.close();
    }
  });
});
