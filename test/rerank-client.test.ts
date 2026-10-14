import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { RerankClient, type RerankClientOptions } from '../src/engines/rerank/client.js';
import { readFixtureJson } from './helpers/fixtures.js';
import type { RerankResponse } from '../src/engines/rerank/types.js';
import { startMockServer, type MockHandler, type MockServer } from './helpers/mock-server.js';

const QUERY = '测试查询';
const DOCUMENTS = ['标题一\n摘要一', '标题二\n摘要二', '标题三\n摘要三', '标题四\n摘要四', '标题五\n摘要五'];

function createClient(server: MockServer, overrides: Partial<RerankClientOptions> = {}): RerankClient {
  return new RerankClient({
    resolveApiKey: async () => 'test-key',
    credentialName: 'SILICONFLOW_API_KEY',
    baseURL: `${server.url}/v1/rerank`,
    ...overrides,
  });
}

/** Run the call and return whatever it rejected with. */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error('expected the rerank call to reject, but it resolved');
    },
    (error: unknown) => error,
  );
}

function respondWithFixture(fixture: RerankResponse): MockHandler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fixture));
  };
}

describe('RerankClient 正常路径', () => {
  it('POST JSON + Bearer，按分数降序返回原数组下标序列', async () => {
    const fixture = readFixtureJson<RerankResponse>('siliconflow-rerank-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      const order = await client.rerank(QUERY, DOCUMENTS, 3);
      expect(order).toEqual([2, 0, 4, 3, 1]);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/rerank');
      expect(request.headers.authorization).toBe('Bearer test-key');
      expect(request.headers['content-type']).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        model: 'BAAI/bge-reranker-v2-m3',
        query: QUERY,
        documents: DOCUMENTS,
        top_n: 3,
        return_documents: false,
      });
    } finally {
      await server.close();
    }
  });

  it('topN 缺省时不传 top_n：以窄化后的 top_n 覆盖全部文档', async () => {
    const fixture = readFixtureJson<RerankResponse>('siliconflow-rerank-response.json');
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture));
    });
    try {
      const client = createClient(server);
      await client.rerank(QUERY, DOCUMENTS, DOCUMENTS.length);
      expect(JSON.parse(server.requests[0]!.body).top_n).toBe(DOCUMENTS.length);
    } finally {
      await server.close();
    }
  });

  it('每次调用都重新解析凭证（不缓存）', async () => {
    const fixture = readFixtureJson<RerankResponse>('siliconflow-rerank-response.json');
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
      await client.rerank('a', ['doc-a'], 1);
      await client.rerank('b', ['doc-b'], 1);
      expect(resolutions).toBe(2);
      expect(server.requests[0]!.headers.authorization).toBe('Bearer key-1');
      expect(server.requests[1]!.headers.authorization).toBe('Bearer key-2');
    } finally {
      await server.close();
    }
  });
});

describe('RerankClient 降级路径（返回 null，不抛错）', () => {
  it('内部超时 → null', async () => {
    const server = await startMockServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"results":[]}');
      },
      { delayMs: 500 },
    );
    try {
      const client = createClient(server, { timeoutMs: 60 });
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('429 限流 → null', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 50601, message: 'TPM limit reached' }));
    });
    try {
      const client = createClient(server);
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('5xx → null', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('unavailable');
    });
    try {
      const client = createClient(server);
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('200 但响应体不是 JSON → null', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json at all');
    });
    try {
      const client = createClient(server);
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('200 但 results 全部不可用 → null', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{ index: 42, relevance_score: 0.9 }] }));
    });
    try {
      const client = createClient(server);
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('网络中断 → null', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const client = createClient(server);
    await server.close();
    await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
  });

  it('documents 为空 → null，且不发网络请求', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server);
      await expect(client.rerank(QUERY, [], 3)).resolves.toBeNull();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('query 为空或全空白 → null，且不发网络请求', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server);
      await expect(client.rerank('', DOCUMENTS, 3)).resolves.toBeNull();
      await expect(client.rerank('   ', DOCUMENTS, 3)).resolves.toBeNull();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('凭证缺失 → null（降级而非崩溃），且不发网络请求', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server, { resolveApiKey: async () => undefined });
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('凭证为空串 → null，且不发网络请求', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server, { resolveApiKey: async () => '' });
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('凭证解析自身抛错 → null（不打穿主流程）', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server, {
        resolveApiKey: async () => {
          throw new Error('credential service unavailable');
        },
      });
      await expect(client.rerank(QUERY, DOCUMENTS, 3)).resolves.toBeNull();
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe('RerankClient 降级回调（DESIGN §4 记日志）', () => {
  it('每次降级都带上原因与详情，供管线记日志', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 50601, message: 'TPM limit reached' }));
    });
    try {
      const seen: { reason: string; detail: string }[] = [];
      const client = createClient(server, {
        onDegrade: (reason, detail) => seen.push({ reason, detail }),
      });
      await client.rerank(QUERY, DOCUMENTS, 3);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.reason).toBe('http-error');
      expect(seen[0]!.detail).toContain('HTTP 429');
      expect(seen[0]!.detail).toContain('TPM limit reached');
      // 详情只含上游文本，绝不含凭证值。
      expect(seen[0]!.detail).not.toContain('test-key');
    } finally {
      await server.close();
    }
  });

  it('回调自身抛错不影响降级结果', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server, {
        onDegrade: () => {
          throw new Error('logger exploded');
        },
      });
      await expect(client.rerank('', DOCUMENTS, 3)).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe('RerankClient 中止语义（唯一允许抛错的场景）', () => {
  it('外层中止 → 抛 WEB_ABORTED', async () => {
    const server = await startMockServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"results":[]}');
      },
      { delayMs: 1_000 },
    );
    try {
      const client = createClient(server);
      const controller = new AbortController();
      const pending = catchError(client.rerank(QUERY, DOCUMENTS, 3, controller.signal));
      setTimeout(() => controller.abort(), 25);
      const error = await pending;
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_ABORTED');
    } finally {
      await server.close();
    }
  });

  it('已中止的 signal → 立即抛 WEB_ABORTED，不发网络请求', async () => {
    const server = await startMockServer(respondWithFixture(readFixtureJson('siliconflow-rerank-response.json')));
    try {
      const client = createClient(server);
      const controller = new AbortController();
      controller.abort();
      const error = await catchError(client.rerank(QUERY, DOCUMENTS, 3, controller.signal));
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe('WEB_ABORTED');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
