import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { FirecrawlClient, FirecrawlError, type FirecrawlClientOptions } from '../src/engines/firecrawl/client.js';
import { buildFirecrawlScrapeRequest } from '../src/engines/firecrawl/wire.js';
import { readFixtureJson } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const URL_ = 'https://example.com/article';

function createClient(server: MockServer, overrides: Partial<FirecrawlClientOptions> = {}): FirecrawlClient {
  return new FirecrawlClient({
    resolveApiKey: async () => 'test-key',
    credentialName: 'FIRECRAWL_API_KEY',
    baseURL: `${server.url}/v2/scrape`,
    ...overrides,
  });
}

/** Run the scrape and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the scrape to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('FirecrawlClient 成功路径', () => {
  it('POST JSON + Bearer，请求体形状契约（maxAge=0、timeout=45000），数据映射为 WebFetchResult', async () => {
    const fixture = readFixtureJson<{ data: { markdown: string } }>('firecrawl-scrape-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      const result = await client.scrape(URL_);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v2/scrape');
      expect(request.headers.authorization).toBe('Bearer test-key');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        url: URL_,
        formats: ['markdown'],
        onlyMainContent: true,
        maxAge: 0,
        timeout: 45_000,
      });
      expect(result).toEqual({
        url: URL_,
        statusCode: 200,
        body: { kind: 'text', content: fixture.data.markdown },
        truncated: false,
      });
    } finally {
      await server.close();
    }
  });

  it('timeout 可配：client 预算与请求体 timeout 同步', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { markdown: 'x' } }));
    });
    try {
      const client = createClient(server, { timeoutMs: 12_000 });
      await client.scrape(URL_);
      expect(JSON.parse(server.requests[0]!.body).timeout).toBe(12_000);
    } finally {
      await server.close();
    }
  });

  it('每次调用都重新解析凭证（不缓存）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { markdown: 'x' } }));
    });
    try {
      let resolutions = 0;
      const client = createClient(server, {
        resolveApiKey: async () => {
          resolutions += 1;
          return `key-${resolutions}`;
        },
      });
      await client.scrape('https://example.com/a');
      await client.scrape('https://example.com/b');
      expect(resolutions).toBe(2);
      expect(server.requests[1]!.headers.authorization).toBe('Bearer key-2');
    } finally {
      await server.close();
    }
  });

  it('目标站非 200 但有文档 → 返回 result 不抛错，statusCode 透传', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          data: {
            markdown: '# 404 页面：未找到',
            metadata: { statusCode: 404, sourceURL: 'https://gone.example/x' },
          },
        }),
      );
    });
    try {
      const client = createClient(server);
      const result = await client.scrape('https://gone.example/x');
      expect(result.statusCode).toBe(404);
      expect(result.body).toEqual({ kind: 'text', content: '# 404 页面：未找到' });
      expect(result.url).toBe('https://gone.example/x');
    } finally {
      await server.close();
    }
  });
});

describe('FirecrawlClient 熔断信号（402/429，不向上抛死：分类结构可被熔断模块消费）', () => {
  it('402 → FirecrawlError.classification = breaker + insufficient-credits', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(402, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'Insufficient credits', code: 'insufficient_credits' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect(error).toBeInstanceOf(FirecrawlError);
      expect(error).toBeInstanceOf(WebError);
      expect((error as FirecrawlError).classification).toEqual({
        class: 'breaker',
        status: 402,
        signal: { kind: 'insufficient-credits' },
      });
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 402');
      expect((error as WebError).message).toContain('code insufficient_credits');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('429 带 Retry-After → breaker + rate-limit + retryAfterMs（毫秒）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      response.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect(error).toBeInstanceOf(FirecrawlError);
      expect((error as FirecrawlError).classification).toEqual({
        class: 'breaker',
        status: 429,
        signal: { kind: 'rate-limit', retryAfterMs: 120_000 },
      });
    } finally {
      await server.close();
    }
  });

  it('429 无 Retry-After → 信号不带 retryAfterMs', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'Rate limit exceeded' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect((error as FirecrawlError).classification).toEqual({
        class: 'breaker',
        status: 429,
        signal: { kind: 'rate-limit' },
      });
      expect('retryAfterMs' in ((error as FirecrawlError).classification as { signal: object }).signal).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('HTTP 200 但 success:false 且码为欠费 → 同样产出熔断信号（不看 HTTP 状态）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'Insufficient credits', code: 'insufficient_credits' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect((error as FirecrawlError).classification).toEqual({
        class: 'breaker',
        status: 200,
        signal: { kind: 'insufficient-credits' },
      });
    } finally {
      await server.close();
    }
  });
});

describe('FirecrawlClient 可重试集合与错误码映射', () => {
  it('可重试集合成员 → classification = retryable，且引擎本身不重试（恰一次请求）', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, error: 'upstream wobble' }));
      });
      try {
        const client = createClient(server);
        const error = await catchError(client.scrape(URL_));
        expect(error).toBeInstanceOf(FirecrawlError);
        const classification = (error as FirecrawlError).classification;
        // 429 走熔断信号（rate-limit），其余判 retryable；两者都由上层决定是否重试。
        if (status === 429) {
          expect(classification.class).toBe('breaker');
        } else {
          expect(classification).toEqual({ class: 'retryable', status });
        }
        expect(server.requests).toHaveLength(1);
      } finally {
        await server.close();
      }
    }
  });

  it('503 带 Retry-After → retryable 携带 retryAfterMs', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' });
      response.end(JSON.stringify({ success: false, error: 'unavailable' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect((error as FirecrawlError).classification).toEqual({
        class: 'retryable',
        status: 503,
        retryAfterMs: 30_000,
      });
    } finally {
      await server.close();
    }
  });

  it('400 → WEB_INVALID_URL（fatal）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'Invalid URL', code: 'BAD_REQUEST' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape('not-a-url'));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_INVALID_URL');
      expect((error as WebError).message).toContain('HTTP 400');
      expect((error as WebError).message).toContain('Invalid URL');
      expect((error as FirecrawlError).classification).toEqual({ class: 'fatal', status: 400 });
    } finally {
      await server.close();
    }
  });

  it('403/404（firecrawl 自身错误，无文档）→ WEB_BLOCKED_URL', async () => {
    for (const status of [403, 404]) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, error: 'blocked by target' }));
      });
      try {
        const client = createClient(server);
        const error = await catchError(client.scrape(URL_));
        expect((error as WebError).code, `status ${status}`).toBe('WEB_BLOCKED_URL');
        expect((error as FirecrawlError).classification).toEqual({ class: 'fatal', status });
      } finally {
        await server.close();
      }
    }
  });

  it('非 JSON 错误体：只报 HTTP 状态，不编造上游细节', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('internal error');
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('HTTP 500');
      expect((error as WebError).message).not.toContain('code ');
      expect((error as FirecrawlError).classification).toEqual({ class: 'retryable', status: 500 });
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不可读/缺 markdown → WEB_PROVIDER_ERROR', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: 'weird' }));
    });
    try {
      const client = createClient(server);
      const error = await catchError(client.scrape(URL_));
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('without a scraped document');
    } finally {
      await server.close();
    }
  });

  it('凭证缺失 → WEB_PROVIDER_ERROR，且不发网络请求', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const client = createClient(server, { resolveApiKey: async () => undefined });
      const error = await catchError(client.scrape(URL_));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('"FIRECRAWL_API_KEY"');
      expect((error as WebError).message).toContain('not configured');
      expect(server.requests).toHaveLength(0);
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
    const error = await catchError(client.scrape(URL_));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
    expect((error as WebError).message).toContain('request failed');
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
      const pending = catchError(client.scrape(URL_, controller.signal));
      setTimeout(() => controller.abort(), 25);
      const error = await pending;
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_ABORTED');
    } finally {
      await server.close();
    }
  });

  it('已中止的 signal → 立即 WEB_ABORTED', async () => {
    const client = new FirecrawlClient({
      resolveApiKey: async () => 'test-key',
      credentialName: 'FIRECRAWL_API_KEY',
      baseURL: 'http://127.0.0.1:1/v2/scrape',
    });
    const controller = new AbortController();
    controller.abort();
    const error = await catchError(client.scrape(URL_, controller.signal));
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
      const error = await catchError(client.scrape(URL_));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      expect((error as WebError).message).toContain('timed out after 60 ms');
      // 请求体 timeout 与 client 预算同步（DESIGN.md 单路上限可配）。
      expect(JSON.parse(server.requests[0]!.body).timeout).toBe(60);
    } finally {
      await server.close();
    }
  });
});

describe('FirecrawlClient 请求体与 wire 构建器一致', () => {
  it('scrape 发出的请求体等于 buildFirecrawlScrapeRequest 的产物', () => {
    expect(buildFirecrawlScrapeRequest(URL_)).toEqual({
      url: URL_,
      formats: ['markdown'],
      onlyMainContent: true,
      maxAge: 0,
      timeout: 45_000,
    });
  });
});
