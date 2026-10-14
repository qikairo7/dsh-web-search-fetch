/**
 * Contract tests for the Zhipu Anthropic-compatible channel's streaming layer
 * (issue #14): incremental SSE frame decoding (including frames split across
 * TCP chunks) and content-block assembly with the early-close decision. Pure
 * text in, values out — no HTTP, no timers.
 * @module test/zhipu-anthropic-stream
 */
import { describe, expect, it } from 'vitest';
import {
  createZhipuAnthropicStreamAssembler,
  createZhipuSseDecoder,
  isZhipuEventStream,
  type ZhipuAnthropicStreamOutcome,
  type ZhipuSseFrame,
} from '../src/engines/zhipu/anthropic-stream.js';
import {
  isZhipuAnthropicResultBlockType,
  mapZhipuAnthropicResponse,
  ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES,
} from '../src/engines/zhipu/anthropic-wire.js';
import {
  blockDelta,
  blockStart,
  blockStop,
  messageStart,
  messageStop,
  sseFrame,
  sseText,
  textBlock,
  zhipuSearchResultFrames,
  zhipuSearchStreamFrames,
  type SseFrameSpec,
} from './helpers/sse.js';

/** Feed a whole rendered body through decoder + assembler, in one chunk. */
function run(
  specs: readonly SseFrameSpec[],
  chunks: readonly string[] = [sseText(specs)],
): { outcome: ZhipuAnthropicStreamOutcome; frames: ZhipuSseFrame[] } {
  const decoder = createZhipuSseDecoder();
  const assembler = createZhipuAnthropicStreamAssembler();
  const frames: ZhipuSseFrame[] = [];
  let outcome: ZhipuAnthropicStreamOutcome = { kind: 'pending' };
  // A terminal outcome stops the caller: it closes the connection at `result`
  // and stops reading at `end`/`failure`, exactly as the client does.
  feed: for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) {
      frames.push(frame);
      outcome = assembler.push(frame);
      if (outcome.kind !== 'pending') break feed;
    }
  }
  return { outcome, frames };
}

/** Slice a rendered body at `cuts` (code-point offsets) into separate chunks. */
function sliceBody(body: string, cuts: readonly number[]): string[] {
  const points = Array.from(body);
  const bounds = [0, ...cuts, points.length];
  const chunks: string[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    chunks.push(points.slice(bounds[index], bounds[index + 1]).join(''));
  }
  return chunks;
}

describe('createZhipuSseDecoder', () => {
  it('单块多帧：一次 push 解出全部完整帧，data 行为 JSON 文本', () => {
    const decoder = createZhipuSseDecoder();
    const frames = decoder.push(
      sseFrame({ event: 'a', data: '{"type":"a"}' }) + sseFrame({ event: 'b', data: '{"type":"b"}' }),
    );
    expect(frames).toEqual([
      { event: 'a', data: '{"type":"a"}' },
      { event: 'b', data: '{"type":"b"}' },
    ]);
  });

  it('跨 TCP 帧拼接：data 行被切开时缓冲续接，不产生半帧', () => {
    const body = sseFrame({ event: 'content_block_delta', data: '{"type":"x"}' });
    const decoder = createZhipuSseDecoder();
    const chunks = sliceBody(body, [4, 20]);
    const seen = chunks.flatMap((chunk) => decoder.push(chunk));
    expect(chunks.length).toBe(3);
    expect(seen).toEqual([{ event: 'content_block_delta', data: '{"type":"x"}' }]);
  });

  it('CRLF 行尾与注释行（: ping）按 SSE 规范处理', () => {
    const decoder = createZhipuSseDecoder();
    const frames = decoder.push(': ping\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n');
    expect(frames).toEqual([{ event: 'message_stop', data: '{"type":"message_stop"}' }]);
  });

  it('多行 data 以换行连接；无 event 名时只带 data', () => {
    const decoder = createZhipuSseDecoder();
    expect(decoder.push('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }]);
  });

  it('flush 交出没有结尾空行的最后一帧；空缓冲交出空数组', () => {
    const decoder = createZhipuSseDecoder();
    expect(decoder.push('event: message_stop\ndata: {"type":"message_stop"}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ event: 'message_stop', data: '{"type":"message_stop"}' }]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('isZhipuEventStream', () => {
  it('只认 text/event-stream（含 charset 参数），其余一律不算流', () => {
    expect(isZhipuEventStream('text/event-stream')).toBe(true);
    expect(isZhipuEventStream('text/event-stream; charset=utf-8')).toBe(true);
    expect(isZhipuEventStream('TEXT/EVENT-STREAM')).toBe(true);
    expect(isZhipuEventStream('application/json')).toBe(false);
    expect(isZhipuEventStream(null)).toBe(false);
    expect(isZhipuEventStream('')).toBe(false);
  });
});

describe('createZhipuAnthropicStreamAssembler — 早收判定', () => {
  it('真实帧序：tool_result 块停止即出 result，块按 index 排序', () => {
    const { outcome } = run(zhipuSearchStreamFrames());
    expect(outcome.kind).toBe('result');
    const blocks = outcome.kind === 'result' ? outcome.blocks : [];
    expect(blocks.map((block) => block.type)).toEqual([
      'thinking',
      'server_tool_use',
      'tool_result',
    ]);
    expect(blocks[0]!.thinking).toBe('用户想查财经新闻。');
    expect(blocks[1]!.input).toEqual({ query: '2025年4月 财经新闻' });
  });

  it('早收时映射层已能拿到搜索结果（result 块走现有 map 路径）', () => {
    // The client maps the blocks the assembler hands back, so this walks the
    // real body through both layers rather than assuming they agree.
    const { outcome } = run([...zhipuSearchResultFrames()]);
    expect(outcome.kind).toBe('result');
    const blocks = outcome.kind === 'result' ? outcome.blocks : [];
    expect(mapZhipuAnthropicResponse({ content: blocks })).toEqual({
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
  });

  it('结果块在 content_block_start 就带全内容 → 立即 result（不等 stop）', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    assembler.push(messageStart());
    const started = assembler.push(
      blockStart(2, {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A' }],
      }),
    );
    expect(started.kind).toBe('result');
  });

  it('内容为空的 result 块在 start 时不算完整，等到 stop 才收', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    const started = assembler.push(
      blockStart(0, { type: 'tool_result', tool_use_id: 'srv_1', content: '' }),
    );
    expect(started.kind).toBe('pending');
    const stopped = assembler.push(blockStop(0));
    expect(stopped.kind).toBe('result');
    expect(stopped.kind === 'result' ? stopped.blocks : []).toEqual([
      { type: 'tool_result', tool_use_id: 'srv_1', content: '' },
    ]);
  });

  it('索引乱序到达：delta 先于 start 也不丢，输出仍按 index 升序', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    assembler.push(
      frame({ type: 'content_block_delta', index: 5, delta: { type: 'text_delta', text: '先到' } }),
    );
    assembler.push(
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    );
    const ended = assembler.push(frame({ type: 'message_stop' }));
    expect(ended.kind).toBe('end');
    const blocks = ended.kind === 'end' ? ended.blocks : [];
    expect(blocks.map((block) => block.text)).toEqual(['', '先到']);
  });

  it('message_stop → end，并交出此前攒下的全部块（含 text 块）', () => {
    const { outcome } = run([messageStart(), ...textBlock(0, '未触发搜索'), messageStop()]);
    expect(outcome.kind).toBe('end');
    const blocks = outcome.kind === 'end' ? outcome.blocks : [];
    expect(mapZhipuAnthropicResponse({ content: blocks })).toEqual({ sources: [], truncated: false });
  });

  it('text 块的 citations delta 累积到块的 citations（标准布局补摘要路径）', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    for (const payload of [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正文' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: { type: 'web_search_result_location', url: 'https://example.com/a', cited_text: '引用' },
        },
      },
      { type: 'content_block_stop', index: 0 },
    ]) {
      assembler.push(frame(payload));
    }
    const outcome = assembler.push(frame({ type: 'message_stop' }));
    const blocks = outcome.kind === 'end' ? outcome.blocks : [];
    expect(blocks[0]!.text).toBe('正文');
    expect(blocks[0]!.citations).toEqual([
      { type: 'web_search_result_location', url: 'https://example.com/a', cited_text: '引用' },
    ]);
  });
});

describe('createZhipuAnthropicStreamAssembler — 失败判定（触发非流式回退）', () => {
  it('data 行不是 JSON → failure', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    expect(assembler.push({ data: 'not json' }).kind).toBe('failure');
  });

  it('data 是 JSON 但非对象 / 缺 type → failure', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    expect(assembler.push({ data: 'null' }).kind).toBe('failure');
    expect(assembler.push({ data: '{"index":0}' }).kind).toBe('failure');
  });

  it('content_block_start 缺 content_block 或缺 index → failure', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    expect(assembler.push(frame({ type: 'content_block_start', index: 0 })).kind).toBe('failure');
    expect(
      assembler.push(frame({ type: 'content_block_start', content_block: { type: 'text' } })).kind,
    ).toBe('failure');
  });

  it('上游 error 事件 → failure', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    const outcome = assembler.push({
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: '过载' } }),
    });
    expect(outcome.kind).toBe('failure');
  });

  it('未知事件类型与 ping 被忽略，不误判为失败', () => {
    const assembler = createZhipuAnthropicStreamAssembler();
    expect(assembler.push(frame({ type: 'ping' })).kind).toBe('pending');
    expect(assembler.push(frame({ type: 'future_event' })).kind).toBe('pending');
    expect(
      assembler.push(
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } }),
      ).kind,
    ).toBe('pending');
  });
});

describe('isZhipuAnthropicResultBlockType 与映射层同源', () => {
  it('早收认的两种块类型，映射层各自确实消费（含 URL 时产出 source）', () => {
    // Each type arrives in its own payload shape: the standard block carries
    // structured `url` items, Zhipu's carries a repr string with `link`.
    const cases: { type: string; content: unknown }[] = [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://example.com/x', title: 'T' }],
      },
      { type: 'tool_result', content: "[{'title': 'T', 'link': 'https://example.com/x', 'content': 'c'}]" },
    ];
    for (const { type, content } of cases) {
      expect(isZhipuAnthropicResultBlockType(type), type).toBe(true);
      const result = mapZhipuAnthropicResponse({ content: [{ type, content }] });
      expect(result.sources.map((source) => source.url), type).toEqual(['https://example.com/x']);
    }
    expect(isZhipuAnthropicResultBlockType('text')).toBe(false);
    expect(isZhipuAnthropicResultBlockType('thinking')).toBe(false);
    expect(isZhipuAnthropicResultBlockType(undefined)).toBe(false);
  });

  it('该谓词与映射层的常量同源（单一真源，改一处两边同步）', () => {
    expect(ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES).toEqual(['web_search_tool_result', 'tool_result']);
    for (const type of ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES) {
      expect(isZhipuAnthropicResultBlockType(type)).toBe(true);
    }
  });
});

/** Build a frame from a `type`-tagged payload object. */
function frame(payload: Record<string, unknown>): ZhipuSseFrame {
  return { event: String(payload.type), data: JSON.stringify(payload) };
}
