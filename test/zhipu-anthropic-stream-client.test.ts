/**
 * Contract tests for the Zhipu Anthropic-compatible channel's streaming
 * early-close behaviour (issue #14): the SSE request it sends, the point at
 * which it stops reading, the two paths that fall back to a plain JSON
 * request, and the preserved 429/abort/timeout semantics. Every test talks to
 * the local mock server only.
 * @module test/zhipu-anthropic-stream-client
 */
import { describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { ZhipuClient, type ZhipuClientOptions } from '../src/engines/zhipu/client.js';
import { isZhipuRateLimitSignal } from '../src/engines/zhipu/transport.js';
import { readFixtureJson } from './helpers/fixtures.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import {
  SSE_HEADERS,
  sseText,
  textBlock,
  zhipuSearchResultFrames,
  zhipuSearchStreamFrames,
  type SseFrameSpec,
} from './helpers/sse.js';

const QUERY = '测试查询';

function createClient(server: MockServer, overrides: Partial<ZhipuClientOptions> = {}): ZhipuClient {
  return new ZhipuClient({
    resolveApiKey: async () => 'test-key',
    credentialName: 'ZHIPU_API_KEY',
    anthropicBaseURL: `${server.url}/api/anthropic/v1`,
    ...overrides,
  });
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

/** The 2xx JSON body the endpoint would return for a non-streaming request. */
function jsonResponseBody(): string {
  return JSON.stringify(readFixtureJson('zhipu-anthropic-response.json'));
}

/**
 * Wait (bounded) for a condition the peer reports asynchronously. The socket
 * close that proves a client's early close is observed by the server a tick
 * after the client's `cancel()` resolves, so asserting on it directly is a race.
 */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

/** Record what a streaming handler actually managed to write to the socket. */
interface StreamRecord {
  /** Frames the handler was told to send. */
  readonly scripted: readonly SseFrameSpec[];
  /** Raw text the server wrote before the client closed the connection. */
  written: string;
  /** True once the socket closed (the client's `reader.cancel()` reaching us). */
  closed: boolean;
}

/**
 * Start a server that answers the streaming request with SSE and the fallback
 * request with JSON, recording how much of the stream each client consumed.
 *
 * `pauseAfterFrames` + `tailPauseMs` split the script: everything after the
 * pause is only attempted once the client has had time to close. That makes
 * "the tail was never sent" a deterministic observation rather than a race
 * between the server's writes and the client's `reader.cancel()`.
 */
async function startStreamServer(
  frames: readonly SseFrameSpec[],
  options: {
    chunkSize?: number;
    gapMs?: number;
    jsonBody?: string;
    fallbackStatus?: number;
    streamStatus?: number;
    streamHeaders?: Record<string, string>;
    pauseAfterFrames?: number;
    tailPauseMs?: number;
  } = {},
): Promise<{ server: MockServer; record: StreamRecord }> {
  const record: StreamRecord = { scripted: frames, written: '', closed: false };
  const server = await startMockServer(async (request, response) => {
    const streaming = String(request.headers.accept ?? '').includes('text/event-stream');
    if (!streaming) {
      response.writeHead(options.fallbackStatus ?? 200, { 'content-type': 'application/json' });
      response.end(options.jsonBody ?? jsonResponseBody());
      return;
    }
    response.writeHead(options.streamStatus ?? 200, {
      ...(options.streamHeaders ?? SSE_HEADERS),
    });
    // A client that closes early closes the socket; that is how this server
    // learns the early close reached it.
    response.on('close', () => {
      record.closed = true;
    });
    for (const [index, frame] of frames.entries()) {
      if (record.closed) return;
      if (index === options.pauseAfterFrames && options.tailPauseMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.tailPauseMs));
      }
      const text = sseText([frame]);
      const size = options.chunkSize ?? text.length;
      for (let offset = 0; offset < text.length; offset += size) {
        if (record.closed) return;
        record.written += text.slice(offset, offset + size);
        response.write(text.slice(offset, offset + size));
        if (options.gapMs !== undefined && options.gapMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.gapMs));
        } else {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
    if (!record.closed) response.end();
  });
  return { server, record };
}

describe('ZhipuClient anthropic 通道：流式请求形状', () => {
  it('请求体带 stream:true，Accept 与 content-type 请求头到位', async () => {
    const { server } = await startStreamServer(zhipuSearchStreamFrames());
    try {
      await createClient(server).searchAnthropic(QUERY);
      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.url).toBe('/api/anthropic/v1/messages');
      expect(request.headers.accept).toBe('text/event-stream');
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.headers.authorization).toBe('Bearer test-key');
      const body = JSON.parse(request.body) as Record<string, unknown>;
      expect(body).toEqual({
        model: 'glm-4.6',
        max_tokens: 1_024,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: QUERY }],
        stream: true,
      });
    } finally {
      await server.close();
    }
  });

  it('model / maxUses 覆盖仍落入流式请求体', async () => {
    const { server } = await startStreamServer(zhipuSearchStreamFrames());
    try {
      await createClient(server, {
        anthropicModel: 'glm-4.5-air',
        anthropicMaxUses: 4,
      }).searchAnthropic(QUERY);
      const body = JSON.parse(server.requests[0]!.body) as {
        model: string;
        tools: { max_uses: number }[];
        stream: boolean;
      };
      expect(body.model).toBe('glm-4.5-air');
      expect(body.tools[0]!.max_uses).toBe(4);
      expect(body.stream).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：早收', () => {
  it('拿到搜索结果块即断开，不消费后续 text 与 message_stop', async () => {
    // The server pauses right after the search-result block. If the client did
    // not close there, the tail would be sent after the pause and recorded.
    const frames = zhipuSearchStreamFrames();
    const tailStart = zhipuSearchResultFrames().length;
    const { server, record } = await startStreamServer(frames, {
      pauseAfterFrames: tailStart,
      tailPauseMs: 60,
    });
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result).toEqual({
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
      // Only one request: no fallback was needed.
      expect(server.requests).toHaveLength(1);
      // The tail (the answer text and `message_stop`) was never sent at all,
      // which is only possible if the client closed the connection early.
      expect(record.written).not.toContain('message_stop');
      expect(record.written).not.toContain('根据搜索结果');
      expect(await waitFor(() => record.closed)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('跨 TCP 帧切开的数据行仍能拼回完整块（早收照常）', async () => {
    const frames = zhipuSearchStreamFrames();
    const { server } = await startStreamServer(frames, { chunkSize: 7 });
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result.sources.map((source) => source.url)).toEqual([
        'https://www.sohu.com/a/897879632_121123890',
      ]);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('早收停在第一个结果块：maxUses>1 时后续搜索轮次被截断（默认 maxUses=1 不受影响）', async () => {
    // Documents the one behavioural edge of closing at the first result block.
    // The default `max_uses: 1` makes this unreachable in production; the test
    // pins the tradeoff so a future change to the default cannot slip past it.
    const secondRound: SseFrameSpec[] = [
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 3,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_2',
            content: [
              { type: 'web_search_result', url: 'https://example.com/second', title: '第二轮' },
            ],
          },
        }),
      },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 3 }) },
    ];
    const frames = [...zhipuSearchStreamFrames(), ...secondRound];
    const tailStart = zhipuSearchResultFrames().length;
    const { server } = await startStreamServer(frames, {
      pauseAfterFrames: tailStart,
      tailPauseMs: 40,
    });
    try {
      const result = await createClient(server, { anthropicMaxUses: 2 }).searchSeam(QUERY);
      expect(result.sources.map((source) => source.url)).toEqual([
        'https://www.sohu.com/a/897879632_121123890',
      ]);
      expect(result.sources.map((source) => source.url)).not.toContain(
        'https://example.com/second',
      );
    } finally {
      await server.close();
    }
  });

  it('搜索结果块在 content_block_start 就带全内容时也在该帧早收', async () => {
    const frames: SseFrameSpec[] = [
      ...zhipuSearchStreamFrames().slice(0, 6),
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://example.com/early',
                title: '早收命中',
              },
            ],
          },
        }),
      },
      ...textBlock(3, '不该被读到'),
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const { server, record } = await startStreamServer(frames, { gapMs: 5 });
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result.sources).toEqual([{ url: 'https://example.com/early', title: '早收命中' }]);
      expect(record.written).not.toContain('message_stop');
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：流内无结果块', () => {
  it('流自然结束且没有结果块 → 空 sources，不再发第二次请求', async () => {
    const frames: SseFrameSpec[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: 'm1' } }) },
      ...textBlock(0, '没有触发搜索'),
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const { server } = await startStreamServer(frames);
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result).toEqual({ sources: [], truncated: false });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：非流式回退', () => {
  it('响应头不是 event-stream → 回退 JSON 路径，第二次请求不带 stream', async () => {
    const { server } = await startStreamServer(zhipuSearchStreamFrames(), {
      streamHeaders: { 'content-type': 'application/json' },
    });
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result.sources.map((source) => source.url)).toEqual([
        'https://www.sohu.com/a/897879632_121123890',
      ]);
      expect(server.requests).toHaveLength(2);
      const fallback = server.requests[1]!;
      expect(JSON.parse(fallback.body)).toEqual({
        model: 'glm-4.6',
        max_tokens: 1_024,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: QUERY }],
      });
      expect(JSON.parse(fallback.body)).not.toHaveProperty('stream');
    } finally {
      await server.close();
    }
  });

  it('SSE data 行解析失败 → 回退 JSON 路径（第二次请求不带 stream）', async () => {
    const frames: SseFrameSpec[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: { id: 'm1' } }) },
      { event: 'content_block_start', data: '{not json' },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const { server } = await startStreamServer(frames);
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(result.sources).toHaveLength(1);
      expect(server.requests).toHaveLength(2);
      expect(JSON.parse(server.requests[1]!.body)).not.toHaveProperty('stream');
    } finally {
      await server.close();
    }
  });

  it('content_block_start 缺 content_block 的畸形流 → 回退', async () => {
    const frames: SseFrameSpec[] = [
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0 }) },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const { server } = await startStreamServer(frames);
    try {
      await createClient(server).searchSeam(QUERY);
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('流在结果块之前断掉（无 message_stop）→ 回退，不谎报空结果', async () => {
    const frames: SseFrameSpec[] = [
      ...zhipuSearchStreamFrames().slice(0, 3),
    ];
    const { server } = await startStreamServer(frames);
    try {
      const result = await createClient(server).searchSeam(QUERY);
      expect(server.requests).toHaveLength(2);
      // The fallback JSON body is the real result, so sources are non-empty.
      expect(result.sources).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('回退请求共享同一 deadline：timeoutMs 是到早收点的总预算', async () => {
    // The streaming attempt answers instantly with a non-SSE body; the JSON
    // fallback then stalls. The deadline started before the first request, so
    // the operation must still time out at roughly timeoutMs.
    const server = await startMockServer(
      (request, response) => {
        const streaming = String(request.headers.accept ?? '').includes('text/event-stream');
        if (streaming) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(jsonResponseBody());
      },
      { delayMs: 400 },
    );
    try {
      const started = Date.now();
      const error = (await catchError(
        createClient(server, { timeoutMs: 150 }).searchAnthropic(QUERY),
      )) as WebError;
      expect(error).toBeInstanceOf(WebError);
      expect(error.code).toBe('WEB_PROVIDER_ERROR');
      // Both attempts were inside one 150 ms budget, so the wait stayed well
      // below the 800 ms two fresh deadlines would have allowed.
      expect(Date.now() - started).toBeLessThan(700);
    } finally {
      await server.close();
    }
  });
});

describe('ZhipuClient anthropic 通道：失败语义不因流式改变', () => {
  it('流式请求 429 → WEB_PROVIDER_ERROR + 熔断信号，且不触发回退', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      response.end(JSON.stringify({ type: 'error', error: { message: '请求过于频繁' } }));
    });
    try {
      const error = (await catchError(createClient(server).searchAnthropic(QUERY))) as WebError;
      expect(error).toBeInstanceOf(WebError);
      expect(error.code).toBe('WEB_PROVIDER_ERROR');
      expect(error.message).toContain('HTTP 429');
      expect(error.message).toContain('请求过于频繁');
      expect(isZhipuRateLimitSignal(error.cause)).toBe(true);
      expect(error.cause).toEqual({ kind: 'rate-limit', retryAfterMs: 7_000 });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('非 429 失败（401/500）→ WEB_PROVIDER_ERROR，保留上游 message，不回退', async () => {
    for (const status of [401, 500] as const) {
      const server = await startMockServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { message: `上游 ${status}` } }));
      });
      try {
        const error = (await catchError(createClient(server).searchAnthropic(QUERY))) as WebError;
        expect(error.code).toBe('WEB_PROVIDER_ERROR');
        expect(error.message).toContain(`HTTP ${status}`);
        expect(error.message).toContain(`上游 ${status}`);
        expect(isZhipuRateLimitSignal(error.cause)).toBe(false);
        expect(server.requests).toHaveLength(1);
      } finally {
        await server.close();
      }
    }
  });

  it('外层中止 → WEB_ABORTED；内部超时 → WEB_PROVIDER_ERROR（流挂住时）', async () => {
    // A stream that opens, sends one frame and then never finishes.
    const server = await startMockServer(async (request, response) => {
      const streaming = String(request.headers.accept ?? '').includes('text/event-stream');
      response.writeHead(200, streaming ? SSE_HEADERS : { 'content-type': 'application/json' });
      if (streaming) {
        response.write(sseText([zhipuSearchStreamFrames()[0]!]));
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        response.end();
        return;
      }
      response.end(jsonResponseBody());
    });
    try {
      const controller = new AbortController();
      const pending = catchError(
        createClient(server, { timeoutMs: 5_000 }).searchAnthropic(QUERY, controller.signal),
      );
      setTimeout(() => controller.abort(), 25);
      const aborted = (await pending) as WebError;
      expect(aborted.code).toBe('WEB_ABORTED');

      const timedOut = (await catchError(
        createClient(server, { timeoutMs: 80 }).searchAnthropic(QUERY),
      )) as WebError;
      expect(timedOut.code).toBe('WEB_PROVIDER_ERROR');
      expect(timedOut.message).toContain('timed out after 80 ms');
    } finally {
      await server.close();
    }
  });

  it('凭证缺失 → 不发任何请求（含流式请求）', async () => {
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

  it('已中止的 signal → 立即 WEB_ABORTED，不发请求', async () => {
    const server = await startMockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const controller = new AbortController();
      controller.abort();
      const error = (await catchError(
        createClient(server).searchAnthropic(QUERY, controller.signal),
      )) as WebError;
      expect(error.code).toBe('WEB_ABORTED');
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
