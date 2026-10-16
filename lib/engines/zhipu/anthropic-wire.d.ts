/**
 * Pure wire-level helpers for the Zhipu search face's Anthropic-compatible
 * channel (`{base}/messages` + the `web_search_20250305` server tool):
 * request building and the response-format translation layer. No HTTP lives
 * here, so every function is directly unit-testable.
 *
 * The translation layer exists because Zhipu executes the standard server tool
 * but does not return the standard block layout:
 *
 * - standard Anthropic: a `web_search_tool_result` block whose `content` is an
 *   array of `{type:'web_search_result', url, title, page_age?}` items;
 * - Zhipu: a `tool_result` block whose `content` is a STRING holding a
 *   Python-`repr`-style literal, e.g.
 *   `[{'text': [{'title': '…', 'link': 'https://…', 'content': '…', 'refer': 'ref_1'}]}]`.
 *
 * Both layouts (and already-structured arrays) are accepted and normalized into
 * seam sources: `link`/`url` → `url`, `title` → `title`, `content`/`snippet`/
 * `text` → `snippet`, `page_age`/`date` → `publishedAt`, deduped by URL.
 *
 * Source: the repr-scanning approach follows `lib/repr.js` of the MIT-licensed
 * reference implementation PartinGQAQ/dsh-web-search-zhipu (commit on `main`,
 * retrieved 2026-10-13). The code below is an independent TypeScript
 * implementation for this repository's structure; see NOTICE for attribution.
 * @module engines/zhipu/anthropic-wire
 */
import type { WebSearchResult } from '@deepseek-ai/dsh-web';
import type { ZhipuAnthropicRequest, ZhipuAnthropicResponse, ZhipuSearchTransport } from '../../types.js';
/**
 * Narrow a runtime value to a supported search transport; anything else falls
 * back to the default (`anthropic`, the Coding Plan route). Config strings are
 * untrusted, so an unknown spelling must never reach the wire.
 */
export declare function resolveZhipuSearchTransport(value: unknown): ZhipuSearchTransport;
/** Narrow a runtime value to a usable Messages base URL; blank/non-string → the public default. */
export declare function resolveZhipuAnthropicBaseURL(value: unknown): string;
/**
 * Build the Messages endpoint from a base URL: trailing slashes are dropped so
 * `…/v1` and `…/v1/` both yield `…/v1/messages` (a doubled slash would some
 * gateways 404 on).
 */
export declare function buildZhipuAnthropicEndpoint(baseURL: string): string;
/** Tunables carried into the Messages request; every field falls back to its default. */
export interface ZhipuAnthropicParams {
    /** GLM model name; defaults to `glm-4.6`. */
    readonly model?: string;
    /** Generated-token bound; defaults to 1024. */
    readonly maxTokens?: number;
    /** Server-tool invocation bound; defaults to 1. */
    readonly maxUses?: number;
    /**
     * Ask the endpoint for an SSE stream (`stream: true`); defaults to `true`,
     * the channel's normal mode (issue #14). `false` omits the field entirely,
     * which is the non-streaming JSON body the fallback request sends.
     */
    readonly stream?: boolean;
}
/** Narrow a runtime value to a usable model name; blank/non-string → `glm-4.6`. */
export declare function resolveZhipuAnthropicModel(value: unknown): string;
/** Narrow a runtime `maxUses` to a positive integer; anything else → 1. */
export declare function resolveZhipuAnthropicMaxUses(value: unknown): number;
/** Narrow a runtime `maxTokens` to a positive integer; anything else → 1024. */
export declare function resolveZhipuAnthropicMaxTokens(value: unknown): number;
/**
 * Build the Messages request: one user message carrying the query verbatim,
 * one `web_search_20250305` server tool with a bounded `max_uses`, and — by
 * default — `stream: true` for the early-close path (issue #14).
 *
 * The tools API's 70-character query cap deliberately does not apply here —
 * the Messages route owns its own query handling, and truncating would change
 * what the model is asked to search for.
 */
export declare function buildZhipuAnthropicRequest(query: string, params?: ZhipuAnthropicParams): ZhipuAnthropicRequest;
/**
 * The two block types that carry search results, in the order
 * {@link mapZhipuAnthropicResponse} consumes them: standard Anthropic
 * `web_search_tool_result`, then Zhipu's non-standard `tool_result`.
 *
 * Single source of truth on purpose: the streaming early-close layer
 * (`./anthropic-stream.js`) must recognize exactly the blocks this mapping
 * layer consumes. If it closed on a block the mapper ignores, the seam would
 * return an empty source list while the real results were still on the wire.
 */
export declare const ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES: readonly ["web_search_tool_result", "tool_result"];
/** Standard Anthropic result block type (structured `web_search_result` items). */
export declare const ZHIPU_ANTHROPIC_STANDARD_RESULT_BLOCK_TYPE: "web_search_tool_result";
/** Zhipu's non-standard result block type (a Python-`repr` string payload). */
export declare const ZHIPU_ANTHROPIC_ZHIPU_RESULT_BLOCK_TYPE: "tool_result";
/** Is this block type one that carries search results? */
export declare function isZhipuAnthropicResultBlockType(value: unknown): boolean;
/**
 * One raw item pulled out of a result block, before URL dedupe. Exported
 * because it is the return type of the public {@link parseZhipuAnthropicBlockItems}.
 */
export interface ZhipuAnthropicRawItem {
    readonly url: string;
    readonly title?: string;
    readonly snippet?: string;
    readonly publishedAt?: string;
}
/** Internal alias kept short at the use sites below. */
type RawItem = ZhipuAnthropicRawItem;
/**
 * Extract raw items from one result block's `content` field. A string is
 * JSON-parsed first (a JSON-encoded array is a legitimate spelling), then
 * repr-scanned; arrays and objects go straight to the structured walker.
 */
export declare function parseZhipuAnthropicBlockItems(content: unknown): RawItem[];
/**
 * Build the `url → cited_text` map from standard `text` blocks' `citations[]`:
 * the standard layout carries the snippet there rather than on the result item.
 * First occurrence wins.
 */
export declare function collectZhipuAnthropicCitationSnippets(blocks: readonly Record<string, unknown>[]): Map<string, string>;
/**
 * Map a Messages response — standard Anthropic block layout first, then
 * Zhipu's non-standard `tool_result` layout — into seam sources. URLs are
 * deduped (first occurrence wins), entries without a URL are dropped, and
 * `truncated` is always `false`: the seam owns the `maxResults` bound.
 */
export declare function mapZhipuAnthropicResponse(payload: ZhipuAnthropicResponse): WebSearchResult;
export {};
