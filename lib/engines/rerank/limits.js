/**
 * Rerank-engine constants. Kept inside the engine folder (not the shared
 * `src/limits.ts`) so the module owns its own surface and lands without
 * touching files other tickets are editing.
 * @module engines/rerank/limits
 */
/** SiliconFlow rerank endpoint (DESIGN.md). */
export const SILICONFLOW_RERANK_URL = 'https://api.siliconflow.cn/v1/rerank';
/** Default credential reference name for the rerank engine (DESIGN.md). */
export const SILICONFLOW_DEFAULT_API_KEY_ENV = 'SILICONFLOW_API_KEY';
/**
 * Whole-operation deadline (DESIGN.md: the rerank stage gets ~3 s). On expiry
 * the call degrades to `null` and the caller falls back to plain RRF order.
 */
export const RERANK_TIMEOUT_MS = 3_000;
/** Maximum upstream-controlled error text retained in a degrade detail. */
export const MAX_UPSTREAM_ERROR_CHARS = 200;
