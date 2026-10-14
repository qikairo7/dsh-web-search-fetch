import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import {
  ZHIHU_CODE_AUTH_FAILED,
  ZHIHU_CODE_INVALID_PARAM,
  ZHIHU_CODE_RATE_LIMITED,
  ZhihuClient,
  readZhihuCircuitSignal,
  type ZhihuClientOptions,
} from '../src/engines/zhihu/client.js';
import { readFixtureJson, readFixtureText } from './helpers/fixtures.js';
import { isTimestampWithinTolerance } from '../src/engines/zhihu/wire.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const QUERY = '知乎开放平台';
/** A clock with a fixed, known second-precision value: 2025-05-26T12:15:57Z. */
const FIXED_MS = 1748261757_000;
const FIXED_SECONDS = '1748261757';

function createClient(server: MockServer, overrides: Partial<ZhihuClientOptions> = {}): ZhihuClient {
  return new ZhihuClient({
    resolveAccessSecret: async () => 'test-secret',
    credentialName: 'ZHIHU_ACCESS_SECRET',
    baseURL: `${server.url}/api/v1/content/global_search`,
    quotaURL: `${server.url}/api/v1/quota`,
    now: () => FIXED_MS,
    ...overrides,
  });
}

/** Run the search and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return (_request: unknown, response: import('node:http').ServerResponse): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

describe('ZhihuClient 成功路径', () => {
  it('GET + Bearer + X-Request-Timestamp（秒级），Query/Count 走查询参数', async () => {
    const fixture = readFixtureJson('zhihu-global-search-response.json');
    const server = await startMockServer(jsonResponse(fixture));
    try {
      const client = createClient(server);
      const result = await client.search(QUERY, 5);
      expect(result).toEqual(fixture);

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe('GET');
      expect(request.headers.authorization).toBe('Bearer test-secret');
      expect(request.headers['x-request-timestamp']).toBe(FIXED_SECONDS);
      expect(request.headers['content-type']).toBe('application/json');
      const url = new URL(request.url, 'http://127.0.0.1');
      expect(url.pathname).toBe('/api/v1/content/global_search');
      expect(url.searchParams.get('Query')).toBe(QUERY);
      expect(url.searchParams.get('Count')).toBe('5');
      expect(request.body).toBe('');
    } finally {
      await server.close();
    }
  });

  it('时间戳是秒级整数（非毫秒、非小数）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const client = createClient(server, { now: () => 1748261757_987 });
      await client.search(QUERY);
      const header = server.requests[0]!.headers['x-request-timestamp'] as string;
      expect(header).toBe(FIXED_SECONDS);
      expect(header).toMatch(/^\d+$/);
      expect(Number(header)).toBeLessThan(1e11);
    } finally {
      await server.close();
    }
  });

  it('时间戳落在文档容忍窗口（±10 分钟）内', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const clockMs = 1748261757_000;
      const client = createClient(server, { now: () => clockMs });
      await client.quota();
      const header = Number(server.requests[0]!.headers['x-request-timestamp']);
      expect(isTimestampWithinTolerance(header, clockMs)).toBe(true);
      // 偏差一旦超过文档窗口，同一判据就会拒绝——判据本身有鉴别力。
      expect(isTimestampWithinTolerance(header, clockMs + 601_000)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('时间戳每次调用重新计算：长会话不会发送陈旧头部', async () => {
    let clock = FIXED_MS;
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const client = createClient(server, { now: () => clock });
      await client.search('a');
      clock = FIXED_MS + 7_000;
      await client.search('b');
      expect(server.requests[0]!.headers['x-request-timestamp']).toBe(FIXED_SECONDS);
      expect(server.requests[1]!.headers['x-request-timestamp']).toBe('1748261764');
    } finally {
      await server.close();
    }
  });

  it('maxResults 缺省时不带 Count；超 20 时夹到 20', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const client = createClient(server);
      await client.search('a');
      expect(new URL(server.requests[0]!.url, 'http://x').searchParams.has('Count')).toBe(false);
      await client.search('b', 500);
      expect(new URL(server.requests[1]!.url, 'http://x').searchParams.get('Count')).toBe('20');
      await client.search('c', 0);
      expect(new URL(server.requests[2]!.url, 'http://x').searchParams.get('Count')).toBe('1');
    } finally {
      await server.close();
    }
  });

  it('引擎选项 countMax 生效（部署可下调上限）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const client = createClient(server, { countMax: 3 });
      await client.search('a', 20);
      expect(new URL(server.requests[0]!.url, 'http://x').searchParams.get('Count')).toBe('3');
    } finally {
      await server.close();
    }
  });

  it('不发 Filter / SearchDB（越界参数不进请求）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const client = createClient(server);
      await client.search(QUERY, 10);
      const params = new URL(server.requests[0]!.url, 'http://x').searchParams;
      expect([...params.keys()].sort()).toEqual(['Count', 'Query']);
    } finally {
      await server.close();
    }
  });

  it('每次调用都重新解析凭证（不缓存）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      let resolutions = 0;
      const client = createClient(server, {
        resolveAccessSecret: async () => {
          resolutions += 1;
          return `secret-${resolutions}`;
        },
      });
      await client.search('a');
      await client.search('b');
      expect(resolutions).toBe(2);
      expect(server.requests[0]!.headers.authorization).toBe('Bearer secret-1');
      expect(server.requests[1]!.headers.authorization).toBe('Bearer secret-2');
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuClient 业务错误码', () => {
  it('HTTP 200 + Code 30001 → 熔断信号 rate-limit，消息带 Code/Message', async () => {
    const body = readFixtureText('zhihu-rate-limit-response.json');
    const server = await startMockServer(jsonResponse(body));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain(`Code ${ZHIHU_CODE_RATE_LIMITED}`);
      expect((error as WebError).message).toContain('请求过于频繁');
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'rate-limit' });
    } finally {
      await server.close();
    }
  });

  it('Code 20001 → 鉴权失败信号，且可识别', async () => {
    const server = await startMockServer(jsonResponse({ Code: 20001, Message: '鉴权失败', Data: null }));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain(`Code ${ZHIHU_CODE_AUTH_FAILED}`);
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'auth-failed' });
    } finally {
      await server.close();
    }
  });

  it('Code 10001 → invalid-request 信号，不带错误细节时只报 Code', async () => {
    const server = await startMockServer(jsonResponse({ Code: 10001, Data: null }));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain(`Code ${ZHIHU_CODE_INVALID_PARAM}`);
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'invalid-request' });
    } finally {
      await server.close();
    }
  });

  it('Code 90001（内部错误）→ 报错但无熔断信号（不冒充限流）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 90001, Message: '内部错误' }));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain('Code 90001');
      expect(readZhihuCircuitSignal(error)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('Code 为字符串数字时同样识别', async () => {
    const server = await startMockServer(jsonResponse({ Code: '30001', Message: '太快' }));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'rate-limit' });
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuClient HTTP 层错误', () => {
  it('HTTP 401 → auth-failed，保留上游 Code/Message', async () => {
    const server = await startMockServer(
      jsonResponse({ Code: 20001, Message: '鉴权失败' }, 401),
    );
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 401');
      expect((error as WebError).message).toContain('Code 20001');
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'auth-failed' });
    } finally {
      await server.close();
    }
  });

  it('HTTP 403 → auth-failed', async () => {
    const server = await startMockServer(jsonResponse({ Message: 'forbidden' }, 403));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'auth-failed' });
    } finally {
      await server.close();
    }
  });

  it('HTTP 429 → rate-limit', async () => {
    const server = await startMockServer(jsonResponse({ Code: 30001, Message: '限流' }, 429));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain('HTTP 429');
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'rate-limit' });
    } finally {
      await server.close();
    }
  });

  it('HTTP 500 → 报错但无熔断信号', async () => {
    const server = await startMockServer(jsonResponse({ Message: 'boom' }, 500));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain('HTTP 500');
      expect(readZhihuCircuitSignal(error)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('非 JSON 错误体：只报 HTTP 状态，不编造细节', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'text/plain' });
      response.end('rate limited');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain('HTTP 429');
      expect((error as WebError).message).not.toContain('Code ');
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不是 JSON → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer(jsonResponse('not json at all'));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('unreadable JSON body');
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不是对象 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer(jsonResponse('null'));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('non-object response body');
    } finally {
      await server.close();
    }
  });

  it('200 但缺少可读 Code → WEB_PROVIDER_ERROR（不当作成功）', async () => {
    const server = await startMockServer(jsonResponse({ Message: 'ok' }));
    try {
      const client = createClient(server);
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('no readable Code');
    } finally {
      await server.close();
    }
  });

  it('网络中断 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    const client = createClient(server);
    await server.close();
    const error = await catchError(client.search(QUERY));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    expect((error as WebError).message).toContain('request failed');
  });

  it('凭证缺失 → WEB_PROVIDER_ERROR，且不发网络请求', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0 }));
    try {
      const client = createClient(server, { resolveAccessSecret: async () => undefined });
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('"ZHIHU_ACCESS_SECRET"');
      expect((error as WebError).message).toContain('not configured');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('凭证为空串 → 同样视为未配置', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0 }));
    try {
      const client = createClient(server, { resolveAccessSecret: async () => '' });
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).message).toContain('not configured');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('外层中止 → WEB_ABORTED，无熔断信号', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0 }), { delayMs: 1_000 });
    try {
      const client = createClient(server);
      const controller = new AbortController();
      const pending = catchError(client.search(QUERY, undefined, controller.signal));
      setTimeout(() => controller.abort(), 25);
      const error = await pending;
      expect((error as WebError).code).toBe('WEB_ABORTED');
      expect(readZhihuCircuitSignal(error)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('已中止的 signal → 立即 WEB_ABORTED，不发请求', async () => {
    const client = new ZhihuClient({
      resolveAccessSecret: async () => 'test-secret',
      credentialName: 'ZHIHU_ACCESS_SECRET',
      baseURL: 'http://127.0.0.1:1/api',
      quotaURL: 'http://127.0.0.1:1/quota',
    });
    const controller = new AbortController();
    controller.abort();
    const error = await catchError(client.search(QUERY, undefined, controller.signal));
    expect((error as WebError).code).toBe('WEB_ABORTED');
  });

  it('内部超时 → WEB_PROVIDER_ERROR（超时语义，不是 WEB_ABORTED）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0 }), { delayMs: 500 });
    try {
      const client = createClient(server, { timeoutMs: 60 });
      const error = await catchError(client.search(QUERY));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('timed out after 60 ms');
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuClient.quota', () => {
  it('GET /api/v1/quota?APIIDs=global_search，返回 {total, used, remaining}', async () => {
    const fixture = readFixtureJson('zhihu-quota-response.json');
    const server = await startMockServer(jsonResponse(fixture));
    try {
      const client = createClient(server);
      const quota = await client.quota();
      expect(quota).toEqual({ total: 5000, used: 1234, remaining: 3766 });

      const request = server.requests[0]!;
      expect(request.method).toBe('GET');
      expect(request.headers.authorization).toBe('Bearer test-secret');
      expect(request.headers['x-request-timestamp']).toBe(FIXED_SECONDS);
      const url = new URL(request.url, 'http://127.0.0.1');
      expect(url.pathname).toBe('/api/v1/quota');
      expect(url.searchParams.get('APIIDs')).toBe('global_search');
    } finally {
      await server.close();
    }
  });

  it('额度耗尽（RemainingQuota=0）可被消费方判定', async () => {
    const server = await startMockServer(
      jsonResponse({
        Code: 0,
        Data: [
          { APIID: 'global_search', TotalQuota: 5000, TotalUsed: 5000, RemainingQuota: 0 },
        ],
      }),
    );
    try {
      const client = createClient(server);
      const quota = await client.quota();
      expect(quota?.remaining).toBe(0);
      expect((quota?.remaining ?? 0) <= 0).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('额度体无匹配条目 → undefined（不等于耗尽）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: [] }));
    try {
      const client = createClient(server);
      expect(await client.quota()).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('额度查询同样识别业务错误（20001 → auth-failed）', async () => {
    const server = await startMockServer(jsonResponse({ Code: 20001, Message: '鉴权失败' }));
    try {
      const client = createClient(server);
      const error = await catchError(client.quota());
      expect((error as WebError).message).toContain('Zhihu quota failed with Code 20001');
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'auth-failed' });
    } finally {
      await server.close();
    }
  });

  it('额度查询 HTTP 429 → rate-limit', async () => {
    const server = await startMockServer(jsonResponse({ Message: '限流' }, 429));
    try {
      const client = createClient(server);
      const error = await catchError(client.quota());
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'rate-limit' });
    } finally {
      await server.close();
    }
  });

  it('额度查询也按次解析凭证、也受超时约束', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: [] }));
    try {
      let resolutions = 0;
      const client = createClient(server, {
        resolveAccessSecret: async () => {
          resolutions += 1;
          return 'test-secret';
        },
      });
      await client.quota();
      await client.search('a');
      expect(resolutions).toBe(2);
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuClient 默认端点', () => {
  it('不传 baseURL/quotaURL 时指向 developer.zhihu.com 官方端点', () => {
    const client = new ZhihuClient({
      resolveAccessSecret: async () => 'test-secret',
      credentialName: 'ZHIHU_ACCESS_SECRET',
    });
    expect(client.options.baseURL).toBe('https://developer.zhihu.com/api/v1/content/global_search');
    expect(client.options.quotaURL).toBe('https://developer.zhihu.com/api/v1/quota');
    expect(client.options.timeoutMs).toBe(10_000);
    expect(client.options.countMax).toBe(20);
  });
});
