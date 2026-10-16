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
export declare function createZhipuSseDecoder(): ZhipuSseDecoder;
/**
 * Is this `content-type` an SSE stream? Parameters (`; charset=utf-8`) and case
 * are ignored; anything else — including a missing header — is not a stream.
 */
export declare function isZhipuEventStream(contentType: string | null | undefined): boolean;
/**
 * What one frame meant for the caller:
 *
 * - `pending`: keep reading;
 * - `result`: the search-result block is complete — close the connection now;
 * - `end`: `message_stop` (or a clean end of body) — no result block appeared,
 *   so the caller maps the accumulated blocks and gets the empty-result path;
 * - `failure`: the stream is not a usable Messages stream — fall back.
 */
export type ZhipuAnthropicStreamOutcome = {
    readonly kind: 'pending';
} | {
    readonly kind: 'result';
    readonly blocks: readonly Record<string, unknown>[];
} | {
    readonly kind: 'end';
    readonly blocks: readonly Record<string, unknown>[];
} | {
    readonly kind: 'failure';
    readonly reason: string;
};
/** Content-block accumulator for one Messages stream. One instance per response. */
export interface ZhipuAnthropicStreamAssembler {
    /** Feed one frame; returns what it meant. */
    push(frame: ZhipuSseFrame): ZhipuAnthropicStreamOutcome;
    /** Blocks accumulated so far, ordered by stream index. */
    snapshot(): readonly Record<string, unknown>[];
}
/** Create the content-block assembler for one response stream. */
export declare function createZhipuAnthropicStreamAssembler(): ZhipuAnthropicStreamAssembler;
