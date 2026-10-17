/**
 * Cooperative constants shared by the providers. Skeleton scope (#1): one
 * engines and one fetch pass-through (built-in HTTP).
 * @module limits
 */
/** Stable id this plugin registers on both seam registries (search and fetch). */
export const AGGREGATED_PROVIDER_ID = 'aggregated';
/** Maximum upstream-controlled error text retained in one failure message. */
export const MAX_UPSTREAM_ERROR_CHARS = 2_000;
