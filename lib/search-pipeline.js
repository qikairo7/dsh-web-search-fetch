/**
 * The aggregated search pipeline's engine wiring — the half of the search side
 * that knows about concrete engines (DESIGN.md). The orchestration
 * itself (fan-out, dedupe, RRF, rerank, truncation) lives in
 * `search-aggregate.ts` and is engine-agnostic; this module turns credentials
 * and configuration into that module's {@link SearchEngineClient} list and
 * builds the one provider `ctx.web` registers.
 *
 * The base engine is AnySearch; configured HTTP adapters
 * join the same list. Each base engine is adapted here
 * rather than in its own engine folder, because the engines deliberately ship
 * no registration and no seam class (a new engine is a new adapter file, and
 * the adapters belong to whoever composes them). Each client is constructed
 * with a per-operation credential resolver, never a cached value, so a rotated
 * key reaches the next search without a restart.
 *
 * The engine modules expose their failures in their own vocabularies
 * (`AnySearchClientError`);
 * `search-aggregate.ts`'s `readSearchFailureSignal` is the single place that
 * projects them onto the breaker's closed set, so nothing here renames or
 * re-invents a reason.
 * @module search-pipeline
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { budgetedFetch } from './request-budget.js';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
import { liveCredentialRef } from './credential-ref.js';
import { AnySearchEngine } from './engines/anysearch/index.js';
import { RerankClient } from './engines/rerank/client.js';
import { SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
import { AggregatedSearchProvider, DEFAULT_RERANK_POOL, DEFAULT_RRF_K, DEFAULT_SEARCH_MAX_FANOUT_MS, } from './search-aggregate.js';
export { AGGREGATED_PROVIDER_ID } from './limits.js';
/** Stable engine ids; also the circuit breaker's keys and the log labels. */
export const ANYSEARCH_ENGINE_ID = 'anysearch';
/** Credential-reference defaults for the engines this pipeline wires. */
export const ANYSEARCH_DEFAULT_API_KEY_ENV = 'ANYSEARCH_API_KEY';
export const SILICONFLOW_DEFAULT_API_KEY_ENV = 'SILICONFLOW_API_KEY';
/**
 * Build the one search provider registered on `ctx.web`: configured engines behind
 * a shared breaker, an optional rerank stage, and the seams' logger.
 */
export function createAggregatedSearchProvider(options) {
    const logger = options.logger;
    const fetchImpl = budgetedFetch(options.overrides?.fetchImpl);
    const timeoutMs = options.maxFanoutMs ?? DEFAULT_SEARCH_MAX_FANOUT_MS;
    const ref = (name) => credentialRef(name);
    // Live reference-name readers: a volatile settings edit is committed into the
    // running config object without remounting this plugin, so names captured as
    // plain strings here would keep addressing the reference the user just moved
    // away from. `liveCredentialRef` consults the source per operation instead.
    // `credentialName` on each client stays the boot-time snapshot — it only
    // labels diagnostics; resolution always goes through the live reader.
    const anysearchApiKeyEnv = liveCredentialRef(options.anysearchApiKeyEnv, ANYSEARCH_DEFAULT_API_KEY_ENV);
    const siliconflowApiKeyEnv = liveCredentialRef(options.siliconflowApiKeyEnv, SILICONFLOW_DEFAULT_API_KEY_ENV);
    const anysearch = new AnySearchEngine({
        resolveApiKey: () => options.resolveCredential(ref(anysearchApiKeyEnv())),
        credentialName: anysearchApiKeyEnv(),
        // The engine's own deadline fires first and classifies the failure as a
        // timeout; the provider's race stays the hard upper bound.
        timeoutMs,
        ...(options.overrides?.anysearchBaseURL === undefined
            ? {}
            : { baseURL: options.overrides.anysearchBaseURL }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    const rerank = buildRerankHandle({
        enabled: true,
        resolveApiKey: () => options.resolveCredential(ref(siliconflowApiKeyEnv())),
        credentialName: siliconflowApiKeyEnv(),
        ...(options.rerankTimeoutMs === undefined ? {} : { timeoutMs: options.rerankTimeoutMs }),
        ...(options.overrides?.rerankBaseURL === undefined
            ? {}
            : { baseURL: options.overrides.rerankBaseURL }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(logger === undefined ? {} : { logger }),
    });
    const breaker = new CircuitBreaker(logger === undefined
        ? {}
        : // Breaker transitions are the one log line DESIGN §4 calls prominent:
            // they explain why an engine silently stopped contributing.
            { onEvent: (event) => logger.error(formatBreakerEvent(event)) });
    const engines = [
        wrapAnySearch(anysearch),
        ...(options.additionalEngines ?? []),
    ];
    return new AggregatedSearchProvider({
        resolveControls: options.resolveControls,
        ready: options.ready,
        engines,
        ...(options.resolveAdditionalEngines === undefined ? {} : {
            resolveEngines: () => [...engines, ...options.resolveAdditionalEngines()],
        }),
        breaker,
        ...(rerank === undefined ? {} : { rerank: { ...rerank, enabled: options.rerank ?? true } }),
        ...(logger === undefined ? {} : { logger }),
        maxFanoutMs: timeoutMs,
        ...(options.rrfK === undefined ? {} : { rrfK: options.rrfK }),
        ...(options.rerankPool === undefined ? {} : { rerankPool: options.rerankPool }),
        ...(options.now === undefined ? {} : { now: options.now }),
    });
}
/** The pipeline's defaults, exported so `index.ts` and tests can name them. */
export const SEARCH_PIPELINE_DEFAULTS = {
    maxFanoutMs: DEFAULT_SEARCH_MAX_FANOUT_MS,
    rrfK: DEFAULT_RRF_K,
    rerankPool: DEFAULT_RERANK_POOL,
};
// ---------------------------------------------------------------------------
// Engine adapters
// ---------------------------------------------------------------------------
/** AnySearch already exposes the seam shape; only the id needs adding. */
function wrapAnySearch(engine) {
    return {
        id: ANYSEARCH_ENGINE_ID,
        search: (request, signal) => engine.search(request, signal),
    };
}
/**
 * Build the rerank stage, or `undefined` when it is switched off. The client
 * already degrades to `null` on every non-cancellation failure; the pipeline
 * logs that degrade and keeps RRF order, so a rerank outage costs ordering
 * quality and nothing else.
 */
function buildRerankHandle(options) {
    if (!options.enabled)
        return undefined;
    const logger = options.logger;
    const client = new RerankClient({
        resolveApiKey: options.resolveApiKey,
        credentialName: options.credentialName,
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(logger === undefined
            ? {}
            : {
                onDegrade: (reason, detail) => {
                    logger.warn(`[搜索] 重排降级（${reason}）：${detail}`);
                },
            }),
    });
    return { free: options.baseURL === undefined || options.baseURL === SILICONFLOW_RERANK_URL,
        rerank: (query, documents, topN, signal) => client.rerank(query, documents, topN, signal) };
}
// Re-exported so the package entry and tests import the pipeline from one place.
export { AggregatedSearchProvider, normalizeSearchUrl, readSearchFailureSignal, rrfFuse, DEFAULT_RRF_K, DEFAULT_RERANK_POOL, DEFAULT_SEARCH_MAX_FANOUT_MS, } from './search-aggregate.js';
