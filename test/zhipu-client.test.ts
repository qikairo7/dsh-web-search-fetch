import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { ZhipuClient, type ZhipuClientOptions } from '../src/engines/zhipu/client.js';
import { buildZhipuSearchRequest } from '../src/engines/zhipu/wire.js';
import { isZhipuRateLimitSignal } from '../src/engines/zhipu/transport.js';
import { readFixtureJson, readFixtureText } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const QUERY = '测试查询';

function createClient(server: MockServer, overrides: Partial<ZhipuClientOptions> = {}): ZhipuClient {
  return new ZhipuClient({
    resolveApiKey: async () => 'test-key',
    credentialName: 'ZHIPU_API_KEY',
    baseURL: `${server.url}/api/paas/v4/web_search`,
    ...overrides,
  });
}

/** Run the search and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the search to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('ZhipuClient 成功路径', () => {
  it('POST JSON + Bearer，返回解析后的响应体', async () => {
    const fixture = readFixtureJson('zhipu-web-search-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      const result = await client.search(buildZhipuSearchRequest(QUERY, 5));
      expect(result).toEqual(fixture);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/paas/v4/web_search');
      expect(request.headers.authorization).toBe('Bearer test-key');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        search_engine: 'search_pro',
        search_query: QUERY,
        search_intent: false,
        content_size: 'medium',
        count: 5,
      });
    } finally {
      await server.close();
    }
  });

  it('每次调用都重新解析凭证（不缓存）', async () => {
    const fixture = readFixtureJson('zhipu-web-search-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      let resolutions = 0;
      const client = createClient(server, {
        resolveApiKey: async () => {
          resolutions += 1;
          return `key-${resolutions}`;
        },
      });
      await client.search(buildZhipuSearchRequest('a'));
      await client.search(buildZhipuSearchRequest('b'));
      expect(resolutions).toBe(2);
      expect(server.requests[1]!.headers.authorization).toBe('Bearer key-2');
    } finally {
      await server.close();
    }
  });

  it('引擎 options 可配：searchEngine/contentSize 落入线上请求体，默认 search_pro/medium', async () => {
    const fixture = readFixtureJson('zhipu-web-search-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const tuned = createClient(server, { searchEngine: 'search_pro_quark', contentSize: 'high' });
      expect(tuned.configuredSearchEngine).toBe('search_pro_quark');
      expect(tuned.configuredContentSize).toBe('high');
      await tuned.searchQuery('q', 3);
      expect(JSON.parse(server.requests[0]!.body)).toEqual({
        search_engine: 'search_pro_quark',
        content_size: 'high',
        search_query: 'q',
        search_intent: false,
        count: 3,
      });
      const plain = createClient(server);
      expect(plain.configuredSearchEngine).toBe('search_pro');
      expect(plain.configuredContentSize).toBe('medium');
      await plain.searchQuery('q');
      expect(JSON.parse(server.requests[1]!.body)).toEqual({
        search_engine: 'search_pro',
        content_size: 'medium',
        search_query: 'q',
        search_intent: false,
      });
    } finally {
      await server.close();
    }
  });

  it('非法运行时档位回落默认（不把未验证值发给上游）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const client = createClient(server, {
        searchEngine: 'search_ultra' as never,
        contentSize: 'low' as never,
      });
      await client.searchQuery('q');
      expect(JSON.parse(server.requests[0]!.body)).toEqual({
        search_engine: 'search_pro',
        content_size: 'medium',
        search_query: 'q',
        search_intent: false,
      });
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient 失败路径', () => {
  it('429 → WEB_PROVIDER_ERROR，消息带 HTTP 状态与上游 error.code/message', async () => {
    const errorBody = readFixtureText('zhipu-error-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(errorBody);
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 429');
      expect((error as WebError).message).toContain('code 1701');
      expect((error as WebError).message).toContain('并发已达上限');
    } finally {
      await server.close();
    }
  });

  it('429 → cause 携带熔断信号（Retry-After 可读时含 retryAfterMs），供上层停用引擎', async () => {
    const errorBody = readFixtureText('zhipu-error-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '12' });
      response.end(errorBody);
    });
    try {
      const client = createClient(server);
      const error = (await catchError(client.search(buildZhipuSearchRequest(QUERY)))) as WebError;
      expect(isZhipuRateLimitSignal(error.cause)).toBe(true);
      expect(error.cause).toEqual({ kind: 'rate-limit', retryAfterMs: 12_000 });
    } finally {
      await server.close();
    }
  });

  it('非 429 的失败不携带熔断信号（cause 不外泄分类）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('boom');
    });
    try {
      const client = createClient(server);
      const error = (await catchError(client.search(buildZhipuSearchRequest(QUERY)))) as WebError;
      expect(isZhipuRateLimitSignal(error.cause)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('1702/1703 专属错误码 → WEB_PROVIDER_ERROR，code/message 保留', async () => {
    for (const [code, message] of [
      [1702, '无可用引擎'],
      [1703, '引擎无有效数据'],
    ] as const) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code, message } }));
      });
      try {
        const client = createClient(server);
        const error = (await catchError(client.search(buildZhipuSearchRequest(QUERY)))) as WebError;
        expect(error.code).toBe('WEB_PROVIDER_ERROR');
        expect(error.message).toContain(`code ${code}`);
        expect(error.message).toContain(message);
      } finally {
        await server.close();
      }
    }
  });

  it('5xx → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('internal error');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 500');
    } finally {
      await server.close();
    }
  });

  it('401 → WEB_PROVIDER_ERROR，保留上游 code/message', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: '1001', message: '认证失败' } }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 401');
      expect((error as WebError).message).toContain('code 1001');
    } finally {
      await server.close();
    }
  });

  it('非 JSON 的错误体：只报 HTTP 状态，不编造细节', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'text/plain' });
      response.end('rate limited');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 429');
      expect((error as WebError).message).not.toContain('code ');
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不是 JSON → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json at all');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('unreadable JSON body');
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不是对象 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('null');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('non-object response body');
    } finally {
      await server.close();
    }
  });

  it('网络中断 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const client = createClient(server);
    await server.close();
    const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    expect((error as WebError).message).toContain('request failed');
  });

  it('凭证缺失 → WEB_PROVIDER_ERROR，且不发网络请求', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const client = createClient(server, { resolveApiKey: async () => undefined });
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('"ZHIPU_API_KEY"');
      expect((error as WebError).message).toContain('not configured');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('外层中止 → WEB_ABORTED', async () => {
    const server = await startMockServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
      { delayMs: 1_000 },
    );
    try {
      const client = createClient(server);
      const controller = new AbortController();
      const pending = catchError(client.search(buildZhipuSearchRequest(QUERY), controller.signal));
      setTimeout(() => controller.abort(), 25);
      const error = await pending;
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_ABORTED');
    } finally {
      await server.close();
    }
  });

  it('已中止的 signal → 立即 WEB_ABORTED', async () => {
    const client = new ZhipuClient({
      resolveApiKey: async () => 'test-key',
      credentialName: 'ZHIPU_API_KEY',
      baseURL: 'http://127.0.0.1:1/api',
    });
    const controller = new AbortController();
    controller.abort();
    const error = await catchError(client.search(buildZhipuSearchRequest(QUERY), controller.signal));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_ABORTED');
  });

  it('内部超时 → WEB_PROVIDER_ERROR（超时语义，不是 WEB_ABORTED）', async () => {
    const server = await startMockServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
      { delayMs: 500 },
    );
    try {
      const client = createClient(server, { timeoutMs: 60 });
      const error = await catchError(client.search(buildZhipuSearchRequest(QUERY)));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('timed out after 60 ms');
    } finally {
      await server.close();
    }
  });
});
