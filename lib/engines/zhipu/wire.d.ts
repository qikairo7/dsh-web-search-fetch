/**
 * Pure wire-level helpers for the Zhipu engine: request building, response
 * narrowing, and small text utilities. No HTTP lives here, so every function
 * is directly unit-testable.
 * @module engines/zhipu/wire
 */
import type { WebSearchResult } from '@deepseek-ai/dsh-web';
import type { ZhipuContentSize, ZhipuSearchEngine, ZhipuSearchRequest, ZhipuSearchResponse } from '../../types.js';
/** Tunables carried by the seam request into the wire request. */
export interface ZhipuSearchParams {
    /** Search engine tier; defaults to `search_pro` when omitted or invalid. */
    readonly searchEngine?: ZhipuSearchEngine;
    /** Snippet granularity; defaults to `medium`. */
    readonly contentSize?: ZhipuContentSize;
}
/**
 * Narrow a runtime value to a supported search_engine tier; anything else
 * falls back to the default (`search_pro`). Config strings are untrusted.
 */
export declare function resolveZhipuSearchEngine(value: unknown): ZhipuSearchEngine;
/** Narrow a runtime value to a supported content_size; anything else → `medium`. */
export declare function resolveZhipuContentSize(value: unknown): ZhipuContentSize;
/**
 * Build the wire request: intent fixed (`false`), engine tier and snippet
 * granularity from `params` (defaults `search_pro` / `medium`), query capped
 * at the API's 70-character limit, `count` aligned to the seam's
 * `maxResults` (omitted when the request carries no bound, leaving the API's
 * own default).
 */
export declare function buildZhipuSearchRequest(query: string, maxResults?: number, params?: ZhipuSearchParams): ZhipuSearchRequest;
/** Clamp `maxResults` into the API's documented 1–50 range. */
export declare function clampZhipuCount(maxResults: number): number;
/** Truncate to at most `max` Unicode code points, never splitting a surrogate pair. */
export declare function truncateToCodePoints(text: string, max: number): string;
/** A trimmed non-empty string, or `undefined` for anything else. */
export declare function readNonEmptyString(value: unknown): string | undefined;
/** A plain (non-null, non-array) object view, or `undefined`. */
export declare function readRecord(value: unknown): Record<string, unknown> | undefined;
/**
 * Map a wire response into seam sources: `link`→`url`, `content`→`snippet`,
 * `publish_date`→`publishedAt` (the date string verbatim — no ISO conversion),
 * `title`→`title`. Entries without a URL are dropped (a seam source always has
 * one); empty or non-string fields are omitted rather than invented.
 * `truncated` is always `false`: the seam owns the `maxResults` bound.
 */
export declare function mapZhipuSearchResponse(payload: ZhipuSearchResponse): WebSearchResult;
