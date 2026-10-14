/**
 * SSE scripting helpers for the Zhipu Anthropic-compatible channel's streaming
 * tests (issue #14). Frames are plain text: a test decides how to slice them
 * across `response.write()` calls, which is how cross-TCP-frame splicing is
 * exercised.
 * @module test/helpers/sse
 */

/** One SSE frame: an optional `event:` name plus one or more `data:` lines. */
export interface SseFrameSpec {
  readonly event?: string;
  readonly data: string;
}

/** Response headers the client requires before it will read a stream. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
};

/** Render one frame, terminated by the blank line that ends it. */
export function sseFrame(spec: SseFrameSpec): string {
  const lines: string[] = [];
  if (spec.event !== undefined) lines.push(`event: ${spec.event}`);
  for (const line of spec.data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/** Render a frame sequence into one response body. */
export function sseText(specs: readonly SseFrameSpec[]): string {
  return specs.map(sseFrame).join('');
}

/** One JSON-payload frame. */
export function sseEvent(event: string, payload: unknown): SseFrameSpec {
  return { event, data: JSON.stringify(payload) };
}

/** `message_start`, as the Messages API opens a stream. */
export function messageStart(id = 'msg_stream_1'): SseFrameSpec {
  return sseEvent('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', content: [] },
  });
}

/** `content_block_start` carrying the block's opening shape. */
export function blockStart(index: number, block: Record<string, unknown>): SseFrameSpec {
  return sseEvent('content_block_start', { type: 'content_block_start', index, content_block: block });
}

/** `content_block_delta` for one block index. */
export function blockDelta(index: number, delta: Record<string, unknown>): SseFrameSpec {
  return sseEvent('content_block_delta', { type: 'content_block_delta', index, delta });
}

/** `content_block_stop`: the block at `index` is complete. */
export function blockStop(index: number): SseFrameSpec {
  return sseEvent('content_block_stop', { type: 'content_block_stop', index });
}

/** `message_stop`: the whole message is complete. */
export function messageStop(): SseFrameSpec {
  return sseEvent('message_stop', { type: 'message_stop' });
}

/** A text block delivered as start → text_delta → stop. */
export function textBlock(index: number, text: string): SseFrameSpec[] {
  return [
    blockStart(index, { type: 'text', text: '' }),
    blockDelta(index, { type: 'text_delta', text }),
    blockStop(index),
  ];
}

/**
 * The Zhipu `tool_result` payload as the real endpoint delivers it: a
 * Python-`repr`-style string holding the search hits. Mirrors
 * `test/fixtures/zhipu-anthropic-response.json`.
 */
export const ZHIPU_REPR_RESULT =
  "[{'text': [{'title': '2025年5月23日财经早资讯', " +
  "'link': 'https://www.sohu.com/a/897879632_121123890', " +
  "'content': '一、1-4月我国对外直接投资575.4亿美元，同比增长7.5%。', " +
  "'date': '2025-05-23', 'refer': 'ref_1'}]}]";

/**
 * The full frame sequence of one real search call: thinking → server tool use
 * → the `tool_result` that carries the hits → the final answer text →
 * `message_stop`. Everything after the `tool_result` stop is what early close
 * is supposed to skip.
 */
export function zhipuSearchStreamFrames(): SseFrameSpec[] {
  return [
    messageStart(),
    blockStart(0, { type: 'thinking', thinking: '' }),
    blockDelta(0, { type: 'thinking_delta', thinking: '用户想查财经新闻。' }),
    blockStop(0),
    blockStart(1, { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }),
    blockDelta(1, { type: 'input_json_delta', partial_json: '{"query": "2025年4月 财经新闻"}' }),
    blockStop(1),
    blockStart(2, { type: 'tool_result', tool_use_id: 'srv_1', content: ZHIPU_REPR_RESULT }),
    blockStop(2),
    ...textBlock(3, '根据搜索结果，1-4月我国对外直接投资同比增长7.5%。'),
    messageStop(),
  ];
}

/** Frames up to and including the search-result block's stop (the early-close point). */
export function zhipuSearchResultFrames(): SseFrameSpec[] {
  const frames = zhipuSearchStreamFrames();
  const stop = frames.findIndex(
    (frame) => frame.data.includes('"content_block_stop"') && frame.data.includes('"index":2'),
  );
  return frames.slice(0, stop + 1);
}

/** Frames the early-close path is expected never to consume. */
export function zhipuSearchTailFrames(): SseFrameSpec[] {
  const frames = zhipuSearchStreamFrames();
  return frames.slice(zhipuSearchResultFrames().length);
}
