/**
 * Pure wire-level helpers for the rerank engine: request building and the
 * score-ordered index permutation. No HTTP lives here, so every function is
 * directly unit-testable.
 *
 * `readRecord` is shared by wire modules: each
 * engine folder stays self-contained, so the rerank engine does not depend on
 * another engine's module.
 * @module engines/rerank/wire
 */
import type { RerankRequest, RerankResponse } from './types.js';
/** Rerank model id (DESIGN.md). */
export declare const SILICONFLOW_RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
/**
 * Build the wire request. `return_documents` is pinned to `false` and the
 * chunking parameters are omitted (documents are short `title + snippet`
 * joins); `top_n` is clamped into `1 … documents.length`.
 */
export declare function buildRerankRequest(query: string, documents: readonly string[], topN: number): RerankRequest;
/**
 * Clamp `topN` into `1 … documentCount` (floored). A non-finite value falls
 * back to `documentCount`, i.e. "score every candidate".
 */
export declare function clampRerankTopN(topN: number, documentCount: number): number;
/**
 * Turn a rerank response into the reordered index sequence: entries sorted by
 * `relevance_score` descending, followed by every index the upstream did not
 * rank, in their original order. The result is always a full permutation of
 * `0 … documentCount - 1`, so reranking can never lose a candidate.
 *
 * Entries are dropped when they are unreadable, carry a non-integer or
 * out-of-range `index`, carry a non-finite `relevance_score`, or repeat an
 * already-accepted index. When nothing usable remains the function returns
 * `undefined`; the client turns that into the degrade signal (`null`).
 */
export declare function orderRerankedIndexes(payload: RerankResponse | null | undefined, documentCount: number): number[] | undefined;
