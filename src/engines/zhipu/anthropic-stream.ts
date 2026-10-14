/**
 * Streaming early-close layer for the Zhipu Anthropic-compatible channel
 * (issue #14). Two pure, timer-free pieces:
 *
 * - {@link createZhipuSseDecoder} turns a byte stream into Server-Sent Events
 *   frames. It is incremental on purpose: a `data:` line routinely straddles a
 *   TCP chunk boundary, and a decoder that only understood whole bodies would
 *   drop those frames.
 * - {@link createZhipuAnthropicStreamAssembler} rebuilds the `content[]` block
 *   array from the `message_start` / `content_block_*` / `message_stop` frame
 *   sequence, and reports the moment the search-result block is complete. That
 *   avoids waiting for final answer generation that the seam does not consume.
 *
 * A `failure` outcome means the frames were not a usable Messages stream; the
 * client answers that by re-issuing one non-streaming JSON request. Only
 * frames that make the stream unusable fail — unknown event types (a future
 * `ping`, a `signature_delta`) are ignored, so a new upstream event cannot
 * silently double every search's cost.
 *
 * The assembler reports `result` at the FIRST complete result block. With the
 * channel's default `max_uses: 1` that is the only search of the call. A
 * caller that raises `max_uses` above 1 buys extra search rounds whose blocks
 * this layer closes past; the non-streaming fallback still aggregates them
 * all, so the difference shows up only in that configuration.
 *
 * The result-block types come from `./anthropic-wire.js`, so the early-close
 * decision and the mapping layer can never disagree about which block carries
 * the results.
 * @module engines/zhipu/anthropic-stream
 */
import { isZhipuAnthropicResultBlockType } from './anthropic-wire.js';
import { readRecord } from './wire.js';

/** One Server-Sent Event frame: an optional `event:` name and its `data:` payload. */
export interface ZhipuSseFrame {
  /** `event:` field value, when the frame carried one. */
  readonly event?: string;
  /** `data:` lines joined with `\n` (the SSE spec's own join). */
  readonly data: string;
}

/** Incremental SSE frame decoder. One instance per response body. */
export interface ZhipuSseDecoder {
  /** Feed the next decoded text chunk; returns every frame it completed. */
  push(chunk: string): ZhipuSseFrame[];
  /** End of body: emit a trailing frame that lacked its blank-line terminator. */
  flush(): ZhipuSseFrame[];
}

/**
 * Create an incremental decoder. It holds back a trailing `\r` (which may be
 * the first half of a `\r\n` pair) and any partial line, so frames split
 * across chunks are still delivered whole and exactly once.
 */
export function createZhipuSseDecoder(): ZhipuSseDecoder {
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): ZhipuSseFrame | undefined => {
    // A frame with no `data:` field carries no payload; the spec drops it.
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const frame: ZhipuSseFrame = {
      ...(eventName === undefined ? {} : { event: eventName }),
      data: dataLines.join('\n'),
    };
    eventName = undefined;
    dataLines = [];
    return frame;
  };

  const consumeLine = (line: string): ZhipuSseFrame | undefined => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(':')) return undefined; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    return undefined;
  };

  const push = (chunk: string): ZhipuSseFrame[] => {
    buffer += chunk;
    const frames: ZhipuSseFrame[] = [];
    for (;;) {
      const newline = buffer.search(/[\r\n]/u);
      if (newline === -1) break;
      // `\r` as the last character may still be half of a `\r\n` pair.
      if (buffer[newline] === '\r' && newline === buffer.length - 1) break;
      const line = buffer.slice(0, newline);
      buffer =
        buffer[newline] === '\r' && buffer[newline + 1] === '\n'
          ? buffer.slice(newline + 2)
          : buffer.slice(newline + 1);
      const frame = consumeLine(line);
      if (frame !== undefined) frames.push(frame);
    }
    return frames;
  };

  const flush = (): ZhipuSseFrame[] => {
    const frames: ZhipuSseFrame[] = [];
    if (buffer.length > 0) {
      const line = buffer;
      buffer = '';
      const frame = consumeLine(line);
      if (frame !== undefined) frames.push(frame);
    }
    const frame = dispatch();
    if (frame !== undefined) frames.push(frame);
    return frames;
  };

  return { push, flush };
}

/**
 * Is this `content-type` an SSE stream? Parameters (`; charset=utf-8`) and case
 * are ignored; anything else — including a missing header — is not a stream.
 */
export function isZhipuEventStream(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const [mediaType] = contentType.split(';');
  return mediaType?.trim().toLowerCase() === 'text/event-stream';
}

/**
 * What one frame meant for the caller:
 *
 * - `pending`: keep reading;
 * - `result`: the search-result block is complete — close the connection now;
 * - `end`: `message_stop` (or a clean end of body) — no result block appeared,
 *   so the caller maps the accumulated blocks and gets the empty-result path;
 * - `failure`: the stream is not a usable Messages stream — fall back.
 */
export type ZhipuAnthropicStreamOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'result'; readonly blocks: readonly Record<string, unknown>[] }
  | { readonly kind: 'end'; readonly blocks: readonly Record<string, unknown>[] }
  | { readonly kind: 'failure'; readonly reason: string };

/** Content-block accumulator for one Messages stream. One instance per response. */
export interface ZhipuAnthropicStreamAssembler {
  /** Feed one frame; returns what it meant. */
  push(frame: ZhipuSseFrame): ZhipuAnthropicStreamOutcome;
  /** Blocks accumulated so far, ordered by stream index. */
  snapshot(): readonly Record<string, unknown>[];
}

/** A non-negative integer block index, or `undefined`. */
function readBlockIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Does this block already carry result payload? A block that arrives empty
 * (`content: ''` or `[]`) is not complete yet: early-closing there would return
 * an empty source list while the hits were still in flight.
 */
function hasResultPayload(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** Append `text` to `block[key]`, tolerating a missing or non-string start value. */
function appendText(block: Record<string, unknown>, key: string, text: string): void {
  const current = block[key];
  block[key] = typeof current === 'string' ? current + text : text;
}

/** Create the content-block assembler for one response stream. */
export function createZhipuAnthropicStreamAssembler(): ZhipuAnthropicStreamAssembler {
  const blocks = new Map<number, Record<string, unknown>>();
  const partialJson = new Map<number, string>();

  const ordered = (): Record<string, unknown>[] =>
    [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);

  const failure = (reason: string): ZhipuAnthropicStreamOutcome => ({ kind: 'failure', reason });

  /** Parse accumulated `input_json_delta` text into the block's `input`. */
  const finalizeInput = (index: number, block: Record<string, unknown>): void => {
    const partial = partialJson.get(index);
    if (partial === undefined) return;
    partialJson.delete(index);
    try {
      block.input = JSON.parse(partial);
    } catch {
      // Unparseable partial input is the tool call's problem, not the search's:
      // the result blocks that follow are unaffected, so keep reading.
    }
  };

  const resultIfComplete = (
    block: Record<string, unknown>,
    complete: boolean,
  ): ZhipuAnthropicStreamOutcome =>
    complete && isZhipuAnthropicResultBlockType(block.type)
      ? { kind: 'result', blocks: ordered() }
      : { kind: 'pending' };

  const push = (frame: ZhipuSseFrame): ZhipuAnthropicStreamOutcome => {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return failure('data line is not JSON');
    }
    const record = readRecord(payload);
    if (record === undefined) return failure('data line is not a JSON object');
    const type = record.type;
    if (typeof type !== 'string' || type.length === 0) return failure('event has no type');

    if (type === 'error') return failure('stream carried an upstream error event');
    if (type === 'message_start' || type === 'message_delta' || type === 'ping') {
      return { kind: 'pending' };
    }
    if (type === 'message_stop') return { kind: 'end', blocks: ordered() };

    if (type === 'content_block_start') {
      const index = readBlockIndex(record.index);
      if (index === undefined) return failure('content_block_start has no block index');
      const start = readRecord(record.content_block);
      if (start === undefined) return failure('content_block_start has no content_block');
      const existing = blocks.get(index);
      // Deltas can arrive before their start (upstreams reorder); accumulated
      // text wins over the start's empty placeholder.
      const block: Record<string, unknown> = existing === undefined ? { ...start } : { ...start, ...existing };
      blocks.set(index, block);
      // A block that opens already carrying payload is complete: the upstream
      // has nothing more to send for it. An empty one (`content: ''` / `[]`)
      // is still filling, and early-closing there would report no results.
      return resultIfComplete(block, hasResultPayload(block.content));
    }

    if (type === 'content_block_delta') {
      const index = readBlockIndex(record.index);
      if (index === undefined) return failure('content_block_delta has no block index');
      const delta = readRecord(record.delta);
      if (delta === undefined) return failure('content_block_delta has no delta');
      const block = blocks.get(index) ?? {};
      blocks.set(index, block);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        appendText(block, 'text', delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        appendText(block, 'thinking', delta.thinking);
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
      } else if (delta.type === 'citations_delta') {
        const citation = readRecord(delta.citation);
        if (citation !== undefined) {
          const list = Array.isArray(block.citations) ? block.citations : [];
          list.push(citation);
          block.citations = list;
        }
      }
      return { kind: 'pending' };
    }

    if (type === 'content_block_stop') {
      const index = readBlockIndex(record.index);
      if (index === undefined) return failure('content_block_stop has no block index');
      const block = blocks.get(index) ?? {};
      blocks.set(index, block);
      finalizeInput(index, block);
      // `content_block_stop` is the upstream's word that the block is final,
      // whatever it holds — including a result block that arrived empty.
      return resultIfComplete(block, true);
    }

    // Unknown event types are ignored, never treated as corruption.
    return { kind: 'pending' };
  };

  return { push, snapshot: ordered };
}
