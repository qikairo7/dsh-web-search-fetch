import { describe, expect, it, vi } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import { CircuitBreaker } from '../src/breaker/index.js';
import {
  AggregatedFetchProvider,
  createExtractionLegs,
} from '../src/fetch-pipeline.js';
import type { AggregatedFetchProviderOptions } from '../src/fetch-pipeline.js';
import type { FetchEngineLeg } from '../src/fetch-aggregate.js';
import { readFixtureText } from './helpers/fixtures.js';
import { startMockServer } from './helpers/mock-server.js';

/** Test resolver: the mock server always lives on 127.0.0.1. */
const resolveAddresses: HttpFetchResolver = async () => [{ address: '127.0.0.1', family: 4 }];

/** Everything this provider fetches is static — the http pass-through tests. */
function createProvider(overrides: AggregatedFetchProviderOptions = {}): AggregatedFetchProvider {
  return new AggregatedFetchProvider({
    resolveAddresses,
    route: { staticDomains: ['127.0.0.1'] },
    ...overrides,
  });
}

interface CountedLeg extends FetchEngineLeg {
  calls: number;
}

function countedLeg(
  engineId: string,
  extract: FetchEngineLeg['extract'] = async (url) => ({
    url,
    statusCode: 200,
    body: { kind: 'text', content: 'engine body' },
    truncated: false,
  }),
): CountedLeg {
  const leg: CountedLeg = {
    engineId,
    calls: 0,
    async extract(url, signal) {
      leg.calls += 1;
      return await extract(url, signal);
    },
  };
  return leg;
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the fetch to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

describe('AggregatedFetchProvider 身份', () => {
  it('id 为 aggregated，available 为 true', () => {
    const provider = createProvider();
    expect(provider.id).toBe('aggregated');
    expect(provider.available()).toBe(true);
  });
});

describe('AggregatedFetchProvider 静态档（复用 dsh-web-fetch-http）', () => {
  it('200 text/html → 解析为 html 正文', async () => {
    const html = readFixtureText('example-page.html');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    try {
      const provider = createProvider();
      const result = await provider.fetch({ url: `${server.url}/` });
      expect(result.statusCode).toBe(200);
      expect(result.url).toBe(`${server.url}/`);
      expect(result.body.kind).toBe('html');
      if (result.body.kind === 'html') {
        expect(result.body.content).toContain('Example Domain');
      }
      expect(result.truncated).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('200 text/plain → 解析为 text 正文', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('plain body');
    });
    try {
      const provider = createProvider();
      const result = await provider.fetch({ url: server.url });
      expect(result.statusCode).toBe(200);
      expect(result.body.kind).toBe('text');
      if (result.body.kind === 'text') {
        expect(result.body.content).toBe('plain body');
      }
    } finally {
      await server.close();
    }
  });

  it('非 2xx 是结果而非错误：404 原样返回状态码', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<h1>not found</h1>');
    });
    try {
      const provider = createProvider();
      const result = await provider.fetch({ url: server.url });
      expect(result.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('非 2xx 是结果而非错误：500 原样返回状态码', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('boom');
    });
    try {
      const provider = createProvider();
      const result = await provider.fetch({ url: server.url });
      expect(result.statusCode).toBe(500);
    } finally {
      await server.close();
    }
  });

  it('不支持的 Content-Type → WEB_UNSUPPORTED_CONTENT_TYPE', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from([0, 1, 2, 3]));
    });
    try {
      const provider = createProvider();
      const error = await catchError(provider.fetch({ url: server.url }));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE');
    } finally {
      await server.close();
    }
  });

  it('非 http(s) 协议 → WEB_INVALID_URL', async () => {
    const provider = createProvider();
    const error = await catchError(provider.fetch({ url: 'ftp://example.com/file' }));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_INVALID_URL');
  });

  it('已中止的 signal → WEB_ABORTED', async () => {
    const provider = createProvider();
    const controller = new AbortController();
    controller.abort();
    const error = await catchError(provider.fetch({ url: 'http://127.0.0.1:1/' }, controller.signal));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_ABORTED');
  });
});

describe('AggregatedFetchProvider URL 感知分流', () => {
  it('静态扩展名（.json）→ 只调 http，付费引擎零调用', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    try {
      const legs = [countedLeg('firecrawl'), countedLeg('tavily'), countedLeg('anysearch')];
      const provider = new AggregatedFetchProvider({
        resolveAddresses,
        legs,
        route: { staticExtensions: ['json'] },
      });
      const result = await provider.fetch({ url: `${server.url}/data.json` });
      expect(result.statusCode).toBe(200);
      expect(result.body.kind).toBe('text');
      expect(legs.map((leg) => leg.calls)).toEqual([0, 0, 0]);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('无扩展网页 → 动态三路并发，http 未被调用', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500);
      response.end('http must not be used for the dynamic route');
    });
    try {
      const body = '# Example Domain Guide\n\n' + 'content '.repeat(100);
      const legs = [
        countedLeg('firecrawl', async (url) => ({
          url,
          statusCode: 200,
          body: { kind: 'text', content: body },
          truncated: false,
        })),
        countedLeg('tavily'),
        countedLeg('anysearch'),
      ];
      const provider = new AggregatedFetchProvider({ legs });
      const result = await provider.fetch({ url: `${server.url}/blog` });
      expect(result.body.kind).toBe('text');
      expect(result.body.content).toContain(body.split('\n\n')[0]);
      expect(result.body.content).toContain(body.split('\n\n')[1]!.trimEnd());
      expect(result.body.content).toContain('提取来源与处理说明');
      expect(legs.map((leg) => leg.calls)).toEqual([1, 1, 1]);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('.pdf → 动态路径（进付费引擎，不走 http 单发）', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(500);
      response.end('http must not be used for the dynamic route');
    });
    try {
      const legs = [
        countedLeg('firecrawl', async (url) => ({
          url,
          statusCode: 200,
          body: { kind: 'text', content: '# Paper Title\n\npaper text' },
          truncated: false,
        })),
      ];
      const provider = new AggregatedFetchProvider({ legs });
      const result = await provider.fetch({ url: `${server.url}/paper.pdf` });
      expect(result.body.content).toContain('paper text');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('分流开关关闭（enabled: false）→ 一律 http 单发，付费引擎零调用', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<p>pass-through</p>');
    });
    try {
      const legs = [countedLeg('firecrawl'), countedLeg('tavily'), countedLeg('anysearch')];
      const provider = new AggregatedFetchProvider({
        resolveAddresses,
        legs,
        route: { enabled: false },
      });
      const result = await provider.fetch({ url: `${server.url}/any/thing` });
      expect(result.statusCode).toBe(200);
      expect(legs.map((leg) => leg.calls)).toEqual([0, 0, 0]);
    } finally {
      await server.close();
    }
  });

  it('动态路径接入熔断：broken 引擎零派发，其余照常择优', async () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('firecrawl', { kind: 'insufficient-credits' });
    const legs = [
      countedLeg('firecrawl'),
      countedLeg('tavily', async (url) => ({
        url,
        statusCode: 200,
        body: { kind: 'text', content: '# Example Domain Guide\n\nsurvivor' },
        truncated: false,
      })),
    ];
    const provider = new AggregatedFetchProvider({ legs, breaker });
    const result = await provider.fetch({ url: 'https://blog.example.com/posts/example-domain-guide' });
    expect(result.body.content).toContain('survivor');
    expect(legs[0]!.calls).toBe(0);
    expect(legs[1]!.calls).toBe(1);
  });

  it('动态路径未配置引擎 → WEB_PROVIDER_ERROR（不静默回退 http）', async () => {
    const provider = createProvider();
    const error = await catchError(provider.fetch({ url: 'https://example.com/blog' }));
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
  });

  it('动态路径外层 abort → WEB_ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createProvider({ legs: [countedLeg('firecrawl')] });
    const error = await catchError(
      provider.fetch({ url: 'https://example.com/blog' }, controller.signal),
    );
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_ABORTED');
  });
});

describe('createExtractionLegs 引擎接线', () => {
  it('两路按 firecrawl → anysearch 顺序绑定，信号读取器就位', async () => {
    const firecrawlScrape = vi.fn(async (url: string): Promise<WebFetchResult> => ({
      url,
      statusCode: 200,
      body: { kind: 'text', content: 'fc' },
      truncated: false,
    }));
    const anysearchExtract = vi.fn(async (): Promise<WebFetchResult> => ({
      url: 'any',
      statusCode: 200,
      body: { kind: 'text', content: 'as' },
      truncated: false,
    }));
    const legs = createExtractionLegs({
      firecrawl: { scrape: firecrawlScrape },
      anysearch: { extract: anysearchExtract },
    });
    expect(legs.map((leg) => leg.engineId)).toEqual(['firecrawl', 'anysearch']);
    const url = 'https://example.com/page';
    await legs[0]!.extract(url);
    await legs[1]!.extract(url);
    expect(firecrawlScrape).toHaveBeenCalledWith(url, undefined);
    expect(anysearchExtract).toHaveBeenCalledWith({ url }, undefined);
    for (const leg of legs) expect(leg.signalOf).toBeTypeOf('function');
  });
});
