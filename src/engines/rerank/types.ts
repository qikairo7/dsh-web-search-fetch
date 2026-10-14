/**
 * Wire-level types for the SiliconFlow rerank engine. Response fields are
 * deliberately `unknown`: the mapping layer narrows them at runtime, so a
 * lying upstream cannot smuggle a non-number into the ordering.
 * @module engines/rerank/types
 */

/**
 * Rerank request body (`/v1/rerank`). `return_documents` is always `false`:
 * the caller already holds the documents and only needs the score per index.
 * Chunking parameters (`max_chunks_per_doc`, `overlap_tokens`) are not sent —
 * this adapter's documents are short `title + snippet` joins, so the model's
 * own defaults are right and explicit chunking would only add latency.
 */
export interface RerankRequest {
  /** Rerank model id, fixed to `BAAI/bge-reranker-v2-m3` in this plugin. */
  readonly model: string;
  /** Query text. */
  readonly query: string;
  /** Candidate documents, in the caller's current (RRF) order. */
  readonly documents: readonly string[];
  /** How many top results the API should return (1 … `documents.length`). */
  readonly top_n: number;
  /** Scores only; the caller keeps its own document list. */
  readonly return_documents: false;
}

/** One `results[]` entry as delivered; every field is narrowed before use. */
export interface RerankResultItem {
  /** Index into the request's `documents` array. */
  readonly index?: unknown;
  /** Relevance score; higher is more relevant. */
  readonly relevance_score?: unknown;
}

/** Rerank response envelope; only `results` is consumed. */
export interface RerankResponse {
  readonly id?: unknown;
  readonly results?: unknown;
  readonly meta?: unknown;
}
