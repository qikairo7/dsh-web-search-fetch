import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { CredentialRefSource } from './credential-ref.js';
import type { ZhipuContentSize, ZhipuSearchEngine as ZhipuEngineTier, ZhipuSearchTransport } from './types.js';
import { AggregatedSearchProvider, type SearchEngineClient, type SearchLogSink } from './search-aggregate.js';
export { AGGREGATED_PROVIDER_ID } from './limits.js';
/** Stable engine ids; also the circuit breaker's keys and the log labels. */
export declare const ANYSEARCH_ENGINE_ID = "anysearch";
export declare const ZHIPU_ENGINE_ID = "zhipu";
export declare const ZHIHU_ENGINE_ID = "zhihu";
/** Credential-reference defaults for the engines this pipeline wires. */
export declare const ANYSEARCH_DEFAULT_API_KEY_ENV = "ANYSEARCH_API_KEY";
export declare const ZHIHU_DEFAULT_ACCESS_SECRET_ENV = "ZHIHU_ACCESS_SECRET";
export declare const SILICONFLOW_DEFAULT_API_KEY_ENV = "SILICONFLOW_API_KEY";
/** A credential reference resolved per operation; `undefined` means unconfigured. */
export type ResolveCredential = (ref: CredentialRef) => Promise<string | undefined>;
/** Per-engine construction overrides, mostly for tests pointing at a mock server. */
export interface SearchEngineOverrides {
    /** AnySearch base URL override. */
    readonly anysearchBaseURL?: string;
    /** Zhipu `web_search` endpoint override (the `tools-api` channel). */
    readonly zhipuBaseURL?: string;
    /** Zhipu Anthropic-compatible Messages base URL override (the `anthropic` channel). */
    readonly zhipuAnthropicBaseURL?: string;
    /** Zhihu `global_search` endpoint override. */
    readonly zhihuBaseURL?: string;
    /** Zhihu quota endpoint override. */
    readonly zhihuQuotaURL?: string;
    /** SiliconFlow rerank endpoint override. */
    readonly rerankBaseURL?: string;
    /** `fetch` implementation override, forwarded to every client. */
    readonly fetchImpl?: typeof fetch;
}
/** Everything {@link createAggregatedSearchProvider} needs to build the pipeline. */
export interface AggregatedSearchPipelineOptions {
    readonly resolveControls?: () => import('./request-budget.js').RuntimeControls;
    readonly ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>;
    /** Additional HTTP engines configured by the plugin entry point. */
    readonly additionalEngines?: readonly SearchEngineClient[];
    /** Snapshot live extension settings at the start of each operation. */
    readonly resolveAdditionalEngines?: () => readonly SearchEngineClient[];
    /** Resolves a credential reference to its current value. */
    readonly resolveCredential: ResolveCredential;
    /** Where engine outcomes and breaker transitions are logged. */
    readonly logger?: SearchLogSink;
    /** Zhipu credential reference name; defaults to `ZHIPU_API_KEY`. */
    readonly zhipuApiKeyEnv?: CredentialRefSource;
    /** AnySearch credential reference name; defaults to `ANYSEARCH_API_KEY`. */
    readonly anysearchApiKeyEnv?: CredentialRefSource;
    /** Zhihu credential reference name; defaults to `ZHIHU_ACCESS_SECRET`. */
    readonly zhihuAccessSecretEnv?: CredentialRefSource;
    /** SiliconFlow credential reference name; defaults to `SILICONFLOW_API_KEY`. */
    readonly siliconflowApiKeyEnv?: CredentialRefSource;
    /** Zhipu `search_engine` tier; defaults to the client's own (`search_pro`). */
    readonly zhipuSearchEngine?: ZhipuEngineTier;
    /** Zhipu `content_size`; defaults to the client's own (`medium`). */
    readonly zhipuContentSize?: ZhipuContentSize;
    /** Zhipu search transport; defaults to the client's own (`anthropic`). */
    readonly zhipuTransport?: ZhipuSearchTransport;
    /**
     * Live Zhipu transport reader, taking precedence over
     * {@link AggregatedSearchPipelineOptions.zhipuTransport}.
     *
     * The settings page edits the transport, and a volatile config field is
     * committed into the running reference instead of remounting the plugin. A
     * pipeline built with a fixed value would keep dispatching to the channel the
     * user just switched away from; a reader is consulted per operation.
     */
    readonly resolveZhipuTransport?: () => ZhipuSearchTransport | undefined;
    /** Zhipu GLM model for the `anthropic` transport; defaults to `glm-4.6`. */
    readonly zhipuAnthropicModel?: string;
    /** Zhipu server-tool invocation bound for the `anthropic` transport; defaults to 1. */
    readonly zhipuAnthropicMaxUses?: number;
    /** Per-engine deadline and client transport budget, in milliseconds. */
    readonly maxFanoutMs?: number;
    /** RRF constant `k`; defaults to 60. */
    readonly rrfK?: number;
    /** Candidates handed to rerank; defaults to 20. */
    readonly rerankPool?: number;
    /** Whether the daily Zhihu quota probe runs; defaults to `true`. */
    readonly zhihuQuotaCheck?: boolean;
    /** Disable the rerank stage entirely (RRF order is then final). */
    readonly rerank?: boolean;
    /** Rerank whole-operation deadline in milliseconds; defaults to the documented ~3 s. */
    readonly rerankTimeoutMs?: number;
    /** Clock override, in epoch milliseconds. */
    readonly now?: () => number;
    /** Endpoint and fetch overrides for focused tests. */
    readonly overrides?: SearchEngineOverrides;
}
/**
 * Build the one search provider registered on `ctx.web`: configured engines behind
 * a shared breaker, an optional rerank stage, and the seams' logger.
 */
export declare function createAggregatedSearchProvider(options: AggregatedSearchPipelineOptions): AggregatedSearchProvider;
/** The pipeline's defaults, exported so `index.ts` and tests can name them. */
export declare const SEARCH_PIPELINE_DEFAULTS: {
    readonly maxFanoutMs: 10000;
    readonly rrfK: 60;
    readonly rerankPool: 20;
};
export { AggregatedSearchProvider, normalizeSearchUrl, readSearchFailureSignal, rrfFuse, DEFAULT_RRF_K, DEFAULT_RERANK_POOL, DEFAULT_SEARCH_MAX_FANOUT_MS, } from './search-aggregate.js';
export type { AggregatedSearchOptions, EngineRanking, FusedCandidate, RerankHandle, SearchEngineClient, SearchEngineQuota, SearchLogSink, } from './search-aggregate.js';
