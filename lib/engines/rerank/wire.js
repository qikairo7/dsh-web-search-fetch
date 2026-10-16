/** Rerank model id (DESIGN.md). */
export const SILICONFLOW_RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';
/**
 * Build the wire request. `return_documents` is pinned to `false` and the
 * chunking parameters are omitted (documents are short `title + snippet`
 * joins); `top_n` is clamped into `1 … documents.length`.
 */
export function buildRerankRequest(query, documents, topN) {
    return {
        model: SILICONFLOW_RERANK_MODEL,
        query,
        documents,
        top_n: clampRerankTopN(topN, documents.length),
        return_documents: false,
    };
}
/**
 * Clamp `topN` into `1 … documentCount` (floored). A non-finite value falls
 * back to `documentCount`, i.e. "score every candidate".
 */
export function clampRerankTopN(topN, documentCount) {
    if (!Number.isFinite(topN))
        return documentCount;
    return Math.min(documentCount, Math.max(1, Math.floor(topN)));
}
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
export function orderRerankedIndexes(payload, documentCount) {
    if (!Number.isInteger(documentCount) || documentCount <= 0)
        return undefined;
    const results = readRecord(payload)?.results;
    if (!Array.isArray(results))
        return undefined;
    const scored = [];
    const seen = new Set();
    for (const item of results) {
        const record = readRecord(item);
        if (record === undefined)
            continue;
        const { index, relevance_score: score } = record;
        if (!Number.isInteger(index))
            continue;
        const position = index;
        if (position < 0 || position >= documentCount)
            continue;
        if (typeof score !== 'number' || !Number.isFinite(score))
            continue;
        if (seen.has(position))
            continue;
        seen.add(position);
        scored.push({ index: position, score });
    }
    if (scored.length === 0)
        return undefined;
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    const order = scored.map((entry) => entry.index);
    for (let position = 0; position < documentCount; position += 1) {
        if (!seen.has(position))
            order.push(position);
    }
    return order;
}
/** A plain (non-null, non-array) object view, or `undefined`. */
function readRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
