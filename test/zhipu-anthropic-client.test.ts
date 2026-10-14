/**
 * Contract tests for the Zhipu Anthropic-compatible transport channel: request
 * shape (endpoint, headers, body), the non-standard `tool_result` translation
 * into seam sources, and the error paths shared with the tools-api channel.
 * Every test talks to the local mock server only.
 *
 * The channel streams with early close (issue #14), so a handler must answer
 * according to the request's `accept` header: SSE for the streaming attempt,
 * JSON for the fallback. `serveJson` is the convenience for the many cases
 * that only care about the JSON shape — it declares a non-SSE content type,
 * which makes the client fall back and the assertions below still describe the
 * JSON path they were written for. Streaming behaviour itself is covered by
 * `zhipu-anthropic-stream-client.test.ts`.
 * @module test/zhipu-anthropic-client
 */
import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import {
  ZhipuClient,
  type ZhipuClientOptions,
} from '../src/engines/zhipu/client.js';
import { isZhipuRateLimitSignal } from '../src/engines/zhipu/transport.js';
import { readFixtureJson, readFixtureText } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const QUERY = '测试查询';

function createClient(server: MockServer, overrides: Partial<ZhipuClientOptions> = {}): ZhipuClient {
  return new ZhipuClient({
    resolveApiKey: async () => 'test-key',
    credentialName: 'ZHIPU_API_KEY',
    anthropicBaseURL: `${server.url}/api/anthropic/v1`,
    ...overrides,
  });
}

/** Answer every request with a JSON body (non-SSE content type). */
function serveJson(response: import('node:http').ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body);
}

/** The JSON request of an exchange that fell back: the second request. */
function fallbackRequest(server: MockServer): string {
  return server.requests[1]!.body;
}

/** Run the call and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the call to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('ZhipuClient anthropic 通道：请求形状', () => {
  it('POST {baseURL}/messages，头带 Bearer 与 anthropic-version，体为 Anthropic Messages 形状', async () => {
    const fixture = readFixtureJson('zhipu-anthropic-response.json');
    const server = await startMockServer((_request, response) => {
      serveJson(response, 200, JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      await client.searchAnthropic(QUERY);
      // The streaming attempt is answered with JSON, so the client falls back;
      // the JSON request is the one whose shape this test pins.
      expect(server.requests).toHaveLength(2);
      const streaming = server.requests[0]!;
      expect(streaming.headers.accept).toBe('text/event-stream');
      expect(streaming.headers.authorization).toBe('Bearer test-key');
      expect(streaming.headers['anthropic-version']).toBe('2023-06-01');
      expect(JSON.parse(streaming.body)).toHaveProperty('stream', true);

      const request = server.requests[1]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/anthropic/v1/messages');
      expect(request.headers.authorization).toBe('Bearer test-key');
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        model: 'glm-4.6',
        max_tokens: 1_024,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: QUERY }],
      });
    } finally {
      await server.close();
    }
  });

  it('model / maxUses 可配并落入请求体', async () => {
    const fixture = readFixtureJson('zhipu-anthropic-response.json');
    const server = await startMockServer((_request, response) => {
      serveJson(response, 200, JSON.stringify(fixture));
    });
    try {
      const client = createClient(server, { anthropicModel: 'glm-4.5-air', anthropicMaxUses: 9 });
      expect(client.configuredTransport).toBe('anthropic');
      expect(client.configuredAnthropicModel).toBe('glm-4.5-air');
      expect(client.configuredAnthropicMaxUses).toBe(9);
      await client.searchAnthropic(QUERY);
      const body = JSON.parse(fallbackRequest(server)) as {
        model: string;
        tools: { max_uses: number }[];
      };
      expect(body.model).toBe('glm-4.5-air');
      expect(body.tools[0]!.max_uses).toBe(9);
    } finally {
      await server.close();
    }
  });

  it('每次调用都重新解析凭证（不缓存）；回退不重复解析', async () => {
    const fixture = readFixtureJson('zhipu-anthropic-response.json');
    const server = await startMockServer((_request, response) => {
      serveJson(response, 200, JSON.stringify(fixture));
    });
    try {
      let resolutions = 0;
      const client = createClient(server, {
        resolveApiKey: async () => {
          resolutions += 1;
          return `key-${resolutions}`;
        },
      });
      await client.searchAnthropic('a');
      // Two calls to the client, not four: the fallback inside one call reuses
      // the credential it already resolved (three requests in total, since the
      // first call fell back).
      expect(resolutions).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]!.headers.authorization).toBe('Bearer key-1');
      expect(server.requests[1]!.headers.authorization).toBe('Bearer key-1');
      await client.searchAnthropic('b');
      expect(resolutions).toBe(2);
      expect(server.requests).toHaveLength(4);
      expect(server.requests[2]!.headers.authorization).toBe('Bearer key-2');
      expect(server.requests[3]!.headers.authorization).toBe('Bearer key-2');
    } finally {
      await server.close();
    }
  });

  it('transport 默认 anthropic；非法值回落默认；tools-api 走旧端点与旧请求体', async () => {
    const anthropicFixture = readFixtureJson('zhipu-anthropic-response.json');
    const toolsFixture = readFixtureJson('zhipu-web-search-response.json');
    const server = await startMockServer((request, response) => {
      serveJson(
        response,
        200,
        JSON.stringify(
          request.url?.includes('/anthropic/') === true ? anthropicFixture : toolsFixture,
        ),
      );
    });
    try {
      const bare = createClient(server, { baseURL: `${server.url}/api/paas/v4/web_search` });
      expect(bare.configuredTransport).toBe('anthropic');
      await bare.searchSeam(QUERY);
      // Streaming attempt + JSON fallback, both on the anthropic endpoint.
      expect(server.requests.map((request) => request.url)).toEqual([
        '/api/anthropic/v1/messages',
        '/api/anthropic/v1/messages',
      ]);

      const bogus = createClient(server, { transport: 'nope' as never });
      expect(bogus.configuredTransport).toBe('anthropic');

      const tools = createClient(server, {
        transport: 'tools-api',
        baseURL: `${server.url}/api/paas/v4/web_search`,
      });
      await tools.searchSeam(QUERY, 5);
      // `bogus` never dispatched, so the tools-api call is the third request.
      const toolsRequest = server.requests[2]!;
      expect(server.requests).toHaveLength(3);
      expect(toolsRequest.url).toBe('/api/paas/v4/web_search');
      expect(JSON.parse(toolsRequest.body)).toEqual({
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

  it('70 字符截断只属 tools-api 通道：anthropic 原样、tools-api 截断', async () => {
    const server = await startMockServer((request, response) => {
      serveJson(
        response,
        200,
        JSON.stringify(
          request.url?.includes('/anthropic/') === true
            ? readFixtureJson('zhipu-anthropic-response.json')
            : readFixtureJson('zhipu-web-search-response.json'),
        ),
      );
    });
    try {
      const longQuery = `查${'x'.repeat(200)}尾`;
      await createClient(server).searchSeam(longQuery);
      const anthropicBody = JSON.parse(fallbackRequest(server)) as {
        messages: { content: string }[];
      };
      expect(anthropicBody.messages[0]!.content).toBe(longQuery);

      await createClient(server, {
        transport: 'tools-api',
        baseURL: `${server.url}/api/paas/v4/web_search`,
      }).searchSeam(longQuery);
      const toolsBody = JSON.parse(server.requests[2]!.body) as { search_query: string };
      expect(toolsBody.search_query).toBe(longQuery.slice(0, 70));
      expect(toolsBody.search_query).not.toBe(longQuery);
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：seam 映射', () => {
  it('searchSeam 返回 seam sources（非标 tool_result → link→url/摘要进 snippet）', async () => {
    const fixture = readFixtureJson('zhipu-anthropic-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      expect(await client.searchSeam(QUERY)).toEqual({
        sources: [
          {
            url: 'https://www.sohu.com/a/897879632_121123890',
            title: '2025年5月23日财经早资讯',
            snippet: '一、1-4月我国对外直接投资575.4亿美元，同比增长7.5%。',
            publishedAt: '2025-05-23',
          },
        ],
        truncated: false,
      });
    } finally {
      await server.close();
    }
  });

  it('标准 Anthropic 布局同样归一（web_search_tool_result）', async () => {
    const fixture = readFixtureJson('zhipu-anthropic-standard-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      const result = await client.searchSeam('标准布局');
      expect(result.sources.map((source) => source.url)).toEqual([
        'https://example.com/std-a',
        'https://example.com/std-b',
      ]);
      expect(result.sources[0]!.snippet).toBe('引用正文 A');
      expect(result.truncated).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('无结果块 → 空 sources（不报错、不编造）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: '未触发搜索' }] }));
    });
    try {
      const client = createClient(server);
      expect(await client.searchSeam(QUERY)).toEqual({ sources: [], truncated: false });
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：失败路径', () => {
  it('429 → WEB_PROVIDER_ERROR + cause 携带熔断信号（Retry-After 可读时含 retryAfterMs）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      response.end(
        JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: '请求过于频繁' } }),
      );
    });
    try {
      const client = createClient(server);
      const error = (await catchError(client.searchAnthropic(QUERY))) as WebError;
      expect(error).toBeInstanceOf(WebError);
      expect(error.code).toBe('WEB_PROVIDER_ERROR');
      expect(error.message).toContain('HTTP 429');
      expect(error.message).toContain('请求过于频繁');
      expect(isZhipuRateLimitSignal(error.cause)).toBe(true);
      expect(error.cause).toEqual({ kind: 'rate-limit', retryAfterMs: 7_000 });
    } finally {
      await server.close();
    }
  });

  it('非 429 的失败（401/500）→ WEB_PROVIDER_ERROR，保留上游 message，不带熔断信号', async () => {
    for (const status of [401, 500] as const) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { message: `上游 ${status}` } }));
      });
      try {
        const client = createClient(server);
        const error = (await catchError(client.searchAnthropic(QUERY))) as WebError;
        expect(error.code).toBe('WEB_PROVIDER_ERROR');
        expect(error.message).toContain(`HTTP ${status}`);
        expect(error.message).toContain(`上游 ${status}`);
        expect(isZhipuRateLimitSignal(error.cause)).toBe(false);
      } finally {
        await server.close();
      }
    }
  });

  it('非 JSON 错误体：只报 HTTP 状态，不编造细节', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('upstream exploded');
    });
    try {
      const client = createClient(server);
      const error = (await catchError(client.searchAnthropic(QUERY))) as WebError;
      expect(error.code).toBe('WEB_PROVIDER_ERROR');
      expect(error.message).toContain('HTTP 503');
      expect(error.message).not.toContain('code ');
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不可解析/非对象 → WEB_PROVIDER_ERROR', async () => {
    for (const [body, expected] of [
      ['not json', 'unreadable JSON body'],
      ['null', 'non-object response body'],
    ] as const) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      });
      try {
        const client = createClient(server);
        const error = (await catchError(client.searchAnthropic(QUERY))) as WebError;
        expect(error.code).toBe('WEB_PROVIDER_ERROR');
        expect(error.message).toContain(expected);
      } finally {
        await server.close();
      }
    }
  });

  it('网络中断 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const client = createClient(server);
    await server.close();
    const error = await catchError(client.searchAnthropic(QUERY));
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
      const error = (await catchError(client.searchAnthropic(QUERY))) as WebError;
      expect(error.code).toBe('WEB_PROVIDER_ERROR');
      expect(error.message).toContain('"ZHIPU_API_KEY"');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('外层中止 → WEB_ABORTED；内部超时 → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      },
      { delayMs: 400 },
    );
    try {
      const client = createClient(server, { timeoutMs: 500 });
      const controller = new AbortController();
      const pending = catchError(client.searchAnthropic(QUERY, controller.signal));
      setTimeout(() => controller.abort(), 25);
      const aborted = (await pending) as WebError;
      expect(aborted.code).toBe('WEB_ABORTED');

      const timedOut = (await catchError(
        createClient(server, { timeoutMs: 60 }).searchAnthropic(QUERY),
      )) as WebError;
      expect(timedOut.code).toBe('WEB_PROVIDER_ERROR');
      expect(timedOut.message).toContain('timed out after 60 ms');
    } finally {
      await server.close();
    }
  });

  it('已中止的 signal → 立即 WEB_ABORTED', async () => {
    const client = new ZhipuClient({
      resolveApiKey: async () => 'test-key',
      credentialName: 'ZHIPU_API_KEY',
      anthropicBaseURL: 'http://127.0.0.1:1/api/anthropic/v1',
    });
    const controller = new AbortController();
    controller.abort();
    const error = (await catchError(client.searchSeam(QUERY, undefined, controller.signal))) as WebError;
    expect(error).toBeInstanceOf(WebError);
    expect(error.code).toBe('WEB_ABORTED');
  });
});

describe('ZhipuClient anthropic 通道：错误语义与 tools-api 通道一致', () => {
  it('两通道的 429 都携带同一形状的熔断信号', async () => {
    const failure = readFixtureText('zhipu-error-response.json');
    const server = await startMockServer((request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
      response.end(request.url?.includes('/anthropic/') === true ? JSON.stringify({ error: { code: '1301', message: '限流' } }) : failure);
    });
    try {
      const toolsError = (await catchError(
        createClient(server, {
          transport: 'tools-api',
          baseURL: `${server.url}/api/paas/v4/web_search`,
        }).searchSeam(QUERY),
      )) as WebError;
      const anthropicError = (await catchError(createClient(server).searchSeam(QUERY))) as WebError;
      expect(toolsError.code).toBe('WEB_PROVIDER_ERROR');
      expect(anthropicError.code).toBe('WEB_PROVIDER_ERROR');
      expect(toolsError.cause).toEqual({ kind: 'rate-limit', retryAfterMs: 3_000 });
      expect(anthropicError.cause).toEqual({ kind: 'rate-limit', retryAfterMs: 3_000 });
    } finally {
      await server.close();
    }
  });
});
