import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { createZhihuEngine, ZhihuEngine } from '../src/engines/zhihu/adapter.js';
import { ZhihuClient } from '../src/engines/zhihu/client.js';
import { readFixtureJson } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const FIXED_MS = 1748261757_000;

function createEngine(server: MockServer, timeoutMs?: number): ZhihuEngine {
  return createZhihuEngine({
    resolveAccessSecret: async () => 'test-secret',
    credentialName: 'ZHIHU_ACCESS_SECRET',
    baseURL: `${server.url}/api/v1/content/global_search`,
    quotaURL: `${server.url}/api/v1/quota`,
    now: () => FIXED_MS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

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
    response.end(JSON.stringify(body));
  };
}

describe('ZhihuEngine.search（seam 形状）', () => {
  it('WebSearchRequest → seam sources：count 透传、UTM 剥离、高亮清洗、EditTime→publishedAt', async () => {
    const fixture = readFixtureJson('zhihu-global-search-response.json');
    const server = await startMockServer(jsonResponse(fixture));
    try {
      const engine = createEngine(server);
      const result = await engine.search({ query: '知乎开放平台', maxResults: 12 });
      expect(result).toEqual({
        sources: [
          {
            url: 'https://www.zhihu.com/question/123456/answer/987654321',
            title: '如何评价 <em>知乎</em> 开放平台？',
            snippet: '开放平台把搜索能力做成 OpenAPI，按日限额免费调用。',
            publishedAt: '2025-05-26T12:15:57.000Z',
          },
          {
            url: 'https://zhuanlan.zhihu.com/p/2234567890',
            title: '知乎 OpenAPI 使用体验',
            snippet: '文档清晰，但 Count 上限只有 20。',
            publishedAt: '2025-05-27T12:15:57.000Z',
          },
        ],
        truncated: false,
      });
      expect(new URL(server.requests[0]!.url, 'http://x').searchParams.get('Count')).toBe('12');
    } finally {
      await server.close();
    }
  });

  it('maxResults 超 20 时聚合面数值被夹到 20', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const engine = createEngine(server);
      await engine.search({ query: 'q', maxResults: 50 });
      expect(new URL(server.requests[0]!.url, 'http://x').searchParams.get('Count')).toBe('20');
    } finally {
      await server.close();
    }
  });

  it('maxResults 缺省时请求不带 Count', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: { Items: [] } }));
    try {
      const engine = createEngine(server);
      await engine.search({ query: 'q' });
      expect(new URL(server.requests[0]!.url, 'http://x').searchParams.has('Count')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('空 Items → 空 sources，不抛错', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Message: 'success', Data: { HasMore: false, Items: [] } }));
    try {
      const engine = createEngine(server);
      expect(await engine.search({ query: 'q' })).toEqual({ sources: [], truncated: false });
    } finally {
      await server.close();
    }
  });

  it('业务错误以 WebError 抛出，熔断信号不被适配层吃掉', async () => {
    const server = await startMockServer(jsonResponse({ Code: 30001, Message: '限流' }));
    try {
      const engine = createEngine(server);
      const error = await catchError(engine.search({ query: 'q' }));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR');
      const { readZhihuCircuitSignal } = await import('../src/engines/zhihu/client.js');
      expect(readZhihuCircuitSignal(error)).toEqual({ kind: 'rate-limit' });
    } finally {
      await server.close();
    }
  });

  it('外层中止透传为 WEB_ABORTED', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0 }), { delayMs: 1_000 });
    try {
      const engine = createEngine(server);
      const controller = new AbortController();
      const pending = catchError(engine.search({ query: 'q' }, controller.signal));
      setTimeout(() => controller.abort(), 25);
      expect(((await pending) as WebError).code).toBe('WEB_ABORTED');
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuEngine.quota（熔断消费）', () => {
  it('返回 {total, used, remaining}，供 remaining<=0 判额度耗尽', async () => {
    const fixture = readFixtureJson('zhihu-quota-response.json');
    const server = await startMockServer(jsonResponse(fixture));
    try {
      const engine = createEngine(server);
      const quota = await engine.quota();
      expect(quota).toEqual({ total: 5000, used: 1234, remaining: 3766 });
      expect((quota?.remaining ?? 0) <= 0).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('额度耗尽时 remaining<=0 为真', async () => {
    const server = await startMockServer(
      jsonResponse({
        Code: 0,
        Data: [{ APIID: 'global_search', TotalQuota: 5000, TotalUsed: 5000, RemainingQuota: '0' }],
      }),
    );
    try {
      const engine = createEngine(server);
      expect((await engine.quota())?.remaining).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('额度读不到 → undefined，不冒充耗尽', async () => {
    const server = await startMockServer(jsonResponse({ Code: 0, Data: [] }));
    try {
      const engine = createEngine(server);
      expect(await engine.quota()).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('ZhihuEngine 构造', () => {
  it('接受与 client 相同的 options；默认指向官方端点', () => {
    const engine = new ZhihuEngine(
      new ZhihuClient({
        resolveAccessSecret: async () => 'test-secret',
        credentialName: 'ZHIHU_ACCESS_SECRET',
      }),
    );
    expect(engine).toBeInstanceOf(ZhihuEngine);
  });
});
