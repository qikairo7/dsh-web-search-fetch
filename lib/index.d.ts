/**
 * dsh-web-search-fetch — registers the aggregated web search and fetch
 * providers on DSH's `ctx.web` seam, which the built-in `web_search` /
 * `web_fetch` tools consume.
 *
 * The search face aggregates the base and configured HTTP engines (DESIGN.md)
 * through one breaker, RRF fusion, and optional rerank; the fetch
 * face is URL-aware conditional orchestration (DESIGN.md) — a static route
 * passes through the built-in safe HTTP fetcher, a dynamic route fans out to
 * the base and configured extraction engines (择优, breaker-gated).
 * The plugin adds no model-visible tools (DESIGN.md).
 * @module index
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { Dict } from '@deepseek-ai/cosmokit';
import z from '@deepseek-ai/schemastery';
import { type AdditionalEnginesConfig } from './engines/additional/index.js';
import type { RuntimeControls } from './request-budget.js';
export { createAdditionalEngines, ADDITIONAL_ENGINE_DEFAULTS } from './engines/additional/index.js';
export type { AdditionalEnginesConfig, AdditionalEngineConfig, AdditionalEngineId } from './engines/additional/index.js';
import { WEB_SEARCH_FETCH_SETTINGS_NAMESPACE } from './settings-surface.js';
export { ANYSEARCH_DEFAULT_BASE_URL } from './engines/anysearch/limits.js';
export { AnySearchClient } from './engines/anysearch/client.js';
export { AnySearchClientError } from './engines/anysearch/error.js';
export type { AnySearchDomainCapability, AnySearchDomainsResponse, AnySearchDomainSummary, AnySearchMetadata, AnySearchParamInfo, AnySearchParamValue, AnySearchResult, AnySearchSearchRequest, AnySearchSearchResponse, AnySearchSubDomain, AnySearchSubDomainsResponse, } from './engines/anysearch/types.js';
export { FIRECRAWL_SCRAPE_URL } from './engines/firecrawl/wire.js';
export { RERANK_TIMEOUT_MS, SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
export { AggregatedSearchProvider, ANYSEARCH_DEFAULT_API_KEY_ENV, ANYSEARCH_ENGINE_ID, DEFAULT_RERANK_POOL, DEFAULT_RRF_K, DEFAULT_SEARCH_MAX_FANOUT_MS, SILICONFLOW_DEFAULT_API_KEY_ENV, createAggregatedSearchProvider, normalizeSearchUrl, readSearchFailureSignal, rrfFuse, } from './search-pipeline.js';
export type { AggregatedSearchOptions, AggregatedSearchPipelineOptions, FusedCandidate, RerankHandle, ResolveCredential, SearchEngineClient, SearchEngineOverrides, SearchLogSink, } from './search-pipeline.js';
export { AggregatedFetchProvider, DEFAULT_HTTP_FETCH_LIMITS, DEFAULT_PROBE_TIMEOUT_MS, createExtractionLegs } from './fetch-pipeline.js';
export type { AggregatedFetchProviderOptions, ExtractionEngineClients } from './fetch-pipeline.js';
export { aggregateDynamicFetch, anysearchBreakerSignal, bodyFingerprint, classifyFetchRoute, DEFAULT_ENGINE_WEIGHTS, DEFAULT_FETCH_ENGINE_TIMEOUT_MS, DEFAULT_STATIC_EXTENSIONS, extractBodyTitle, extractUrlSlug, firecrawlBreakerSignal, isUsableCandidate, scoreCandidate, selectBestCandidate, titleSimilarity, } from './fetch-aggregate.js';
export { DecisionClient } from './engines/decision/client.js';
export { DECISION_MODEL_PROVIDER, buildDecisionRequest, parseDecisionDepth } from './engines/decision/wire.js';
export { ALIBABA_DECISION_URL, DECISION_TIMEOUT_MS, SILICONFLOW_SYSTEMONE_URL, TYPESAFE_JEV_URL } from './engines/decision/limits.js';
export type { DecisionDepth, DecisionModelId, DecisionProvider } from './engines/decision/types.js';
export type { FetchCandidate, FetchEngineLeg, FetchPipelineLogger, FetchRoute, FetchRouteOptions, } from './fetch-aggregate.js';
export { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
export type { BreakerSignal, CircuitBreakerOptions } from './breaker/index.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-fetch";
/** Required services: web providers and per-operation credentials. */
export declare const inject: string[];
export { WEB_SEARCH_FETCH_SETTINGS_NAMESPACE };
/** Search-pipeline configuration (DESIGN.md). */
export interface SearchConfig {
    /** Per-engine deadline in milliseconds; defaults to the documented 10 s. */
    maxFanoutMs?: number;
    /** RRF constant `k`; defaults to 60. */
    rrfK?: number;
    /** Candidates handed to rerank; defaults to 20. */
    rerankPool?: number;
    /** Set `false` to skip the rerank stage entirely (pure RRF). */
    rerank?: Volatile<boolean> | boolean;
    /** Rerank whole-operation deadline in milliseconds; defaults to the documented ~3 s. */
    rerankTimeoutMs?: number;
    /** AnySearch credential reference; defaults to `ANYSEARCH_API_KEY`. Volatile. */
    anysearchApiKeyEnv?: Volatile<string>;
    /** SiliconFlow rerank credential reference; defaults to `SILICONFLOW_API_KEY`. Volatile. */
    siliconflowApiKeyEnv?: Volatile<string>;
    /** AnySearch origin (DESIGN.md); defaults to `https://api.anysearch.com`. */
    anysearchBaseURL?: string;
    /** SiliconFlow rerank endpoint (DESIGN.md); defaults to the public endpoint. */
    rerankBaseURL?: string;
    /** Fast decision model behind the automatic preset. */
    decisionModel?: Volatile<'Kev-4b' | 'SemIf' | 'diffusiongemma' | 'decision-model-preview' | 'jev-latest'>;
    /** Decision-model request budget. */
    decisionTimeoutMs?: number;
}
/** Fetch-side configuration: routing knobs, engine endpoints, and 择优 tuning. */
export interface FetchConfig {
    /** `false` bypasses routing: every URL uses the HTTP fetcher. Default `true`. */
    staticRouting?: boolean;
    /** Static-domain profiles whose pages skip the paid engines. */
    staticDomains?: string[];
    /** Static extension table; defaults to the built-in list (`.json`, `.txt`, …). */
    staticExtensions?: string[];
    /** Dynamic-path per-engine deadline in milliseconds. Default 45 s (DESIGN.md). */
    perEngineTimeoutMs?: number;
    /** 择优 weight overrides per engine id; missing entries keep the defaults. */
    engineWeights?: Record<string, number>;
    /** Refuse loopback/private destinations before any third-party engine sees them. Default `true`. */
    blockPrivateAddresses?: Volatile<boolean> | boolean;
    /** Deadline of the automatic preset's first-path probe, in milliseconds. Default 15 s. */
    probeTimeoutMs?: Volatile<number> | number;
    /** Let the `single` preset fall back to multi-path organization. Default `false`. */
    singleChannelEscalate?: Volatile<boolean> | boolean;
    /** Firecrawl credential reference; defaults to `FIRECRAWL_API_KEY`. */
    firecrawlApiKeyEnv?: Volatile<string>;
    /** AnySearch extract credential reference; falls back to the search-face one. */
    anysearchApiKeyEnv?: Volatile<string | undefined>;
    /** Firecrawl v2 scrape endpoint (DESIGN.md); defaults to the public endpoint. */
    firecrawlBaseURL?: string;
    /** AnySearch origin for the extract face (DESIGN.md); defaults to the public origin. */
    anysearchBaseURL?: string;
}
/** Plugin configuration. */
export interface Config {
    controls?: Volatile<RuntimeControls | undefined>;
    /** Additional engines; a configured entry is enabled unless set to false. */
    engines?: Volatile<AdditionalEnginesConfig | undefined>;
    /** Search-pipeline knobs (DESIGN.md). */
    search?: SearchConfig;
    /** Fetch-side knobs, all optional. */
    fetch?: FetchConfig;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    controls: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        serviceEnabled: z<Dict<boolean, string>, Dict<boolean, string>, "defined">;
        mode: z<"select" | "organize", "select" | "organize", "defined">;
        preset: z<"auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "defined">;
        decisionRouting: z<"off" | "model", "off" | "model", "defined">;
        searchServices: z<string[], string[], "defined">;
        fetchServices: z<string[], string[], "defined">;
        maxSearchServices: z<number, number, "defined">;
        maxFetchServices: z<number, number, "defined">;
        maxRequests: z<number, number, "defined">;
        searchDeadlineMs: z<number, number, "defined">;
        fetchDeadlineMs: z<number, number, "defined">;
        maxOutputChars: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        serviceEnabled: z<Dict<boolean, string>, Dict<boolean, string>, "defined">;
        mode: z<"select" | "organize", "select" | "organize", "defined">;
        preset: z<"auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "defined">;
        decisionRouting: z<"off" | "model", "off" | "model", "defined">;
        searchServices: z<string[], string[], "defined">;
        fetchServices: z<string[], string[], "defined">;
        maxSearchServices: z<number, number, "defined">;
        maxFetchServices: z<number, number, "defined">;
        maxRequests: z<number, number, "defined">;
        searchDeadlineMs: z<number, number, "defined">;
        fetchDeadlineMs: z<number, number, "defined">;
        maxOutputChars: z<number, number, "defined">;
    }>>>, "volatile-defined">;
    engines: z<NoInfer<Dict<{
        enabled?: boolean | null | undefined;
        apiKeyEnv?: string | null | undefined;
        baseURL?: string | null | undefined;
        fetchBaseURL?: string | null | undefined;
        searchMode?: "basic" | "pro" | null | undefined;
    } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        apiKeyEnv: z<string, string, "plain">;
        baseURL: z<string, string, "plain">;
        fetchBaseURL: z<string, string, "plain">;
        searchMode: z<"basic" | "pro", "basic" | "pro", "plain">;
    }>>, string>>, "volatile">;
    search: z<Schemastery.ObjectS<NoInfer<{
        maxFanoutMs: z<number, number, "defined">;
        rrfK: z<number, number, "defined">;
        rerankPool: z<number, number, "defined">;
        rerank: z<boolean, boolean, "volatile-defined">;
        rerankTimeoutMs: z<number, number, "defined">;
        anysearchApiKeyEnv: z<string, string, "volatile-defined">;
        siliconflowApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchBaseURL: z<string, string, "defined">;
        rerankBaseURL: z<string, string, "defined">;
        decisionModel: z<"Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "volatile-defined">;
        decisionTimeoutMs: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxFanoutMs: z<number, number, "defined">;
        rrfK: z<number, number, "defined">;
        rerankPool: z<number, number, "defined">;
        rerank: z<boolean, boolean, "volatile-defined">;
        rerankTimeoutMs: z<number, number, "defined">;
        anysearchApiKeyEnv: z<string, string, "volatile-defined">;
        siliconflowApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchBaseURL: z<string, string, "defined">;
        rerankBaseURL: z<string, string, "defined">;
        decisionModel: z<"Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "volatile-defined">;
        decisionTimeoutMs: z<number, number, "defined">;
    }>>, "defined">;
    fetch: z<Schemastery.ObjectS<NoInfer<{
        staticRouting: z<boolean, boolean, "defined">;
        staticDomains: z<string[], string[], "defined">;
        staticExtensions: z<string[], string[], "defined">;
        perEngineTimeoutMs: z<number, number, "defined">;
        blockPrivateAddresses: z<boolean, boolean, "volatile-defined">;
        probeTimeoutMs: z<number, number, "volatile-defined">;
        singleChannelEscalate: z<boolean, boolean, "volatile-defined">;
        engineWeights: z<Dict<number, string>, Dict<number, string>, "defined">;
        firecrawlApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchApiKeyEnv: z<string, string, "volatile">;
        firecrawlBaseURL: z<string, string, "defined">;
        anysearchBaseURL: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        staticRouting: z<boolean, boolean, "defined">;
        staticDomains: z<string[], string[], "defined">;
        staticExtensions: z<string[], string[], "defined">;
        perEngineTimeoutMs: z<number, number, "defined">;
        blockPrivateAddresses: z<boolean, boolean, "volatile-defined">;
        probeTimeoutMs: z<number, number, "volatile-defined">;
        singleChannelEscalate: z<boolean, boolean, "volatile-defined">;
        engineWeights: z<Dict<number, string>, Dict<number, string>, "defined">;
        firecrawlApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchApiKeyEnv: z<string, string, "volatile">;
        firecrawlBaseURL: z<string, string, "defined">;
        anysearchBaseURL: z<string, string, "defined">;
    }>>, "plain">;
}>>, Schemastery.ObjectT<NoInfer<{
    controls: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        serviceEnabled: z<Dict<boolean, string>, Dict<boolean, string>, "defined">;
        mode: z<"select" | "organize", "select" | "organize", "defined">;
        preset: z<"auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "defined">;
        decisionRouting: z<"off" | "model", "off" | "model", "defined">;
        searchServices: z<string[], string[], "defined">;
        fetchServices: z<string[], string[], "defined">;
        maxSearchServices: z<number, number, "defined">;
        maxFetchServices: z<number, number, "defined">;
        maxRequests: z<number, number, "defined">;
        searchDeadlineMs: z<number, number, "defined">;
        fetchDeadlineMs: z<number, number, "defined">;
        maxOutputChars: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        serviceEnabled: z<Dict<boolean, string>, Dict<boolean, string>, "defined">;
        mode: z<"select" | "organize", "select" | "organize", "defined">;
        preset: z<"auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "auto" | "single" | "multi" | "custom" | "free" | "balanced" | "deep", "defined">;
        decisionRouting: z<"off" | "model", "off" | "model", "defined">;
        searchServices: z<string[], string[], "defined">;
        fetchServices: z<string[], string[], "defined">;
        maxSearchServices: z<number, number, "defined">;
        maxFetchServices: z<number, number, "defined">;
        maxRequests: z<number, number, "defined">;
        searchDeadlineMs: z<number, number, "defined">;
        fetchDeadlineMs: z<number, number, "defined">;
        maxOutputChars: z<number, number, "defined">;
    }>>>, "volatile-defined">;
    engines: z<NoInfer<Dict<{
        enabled?: boolean | null | undefined;
        apiKeyEnv?: string | null | undefined;
        baseURL?: string | null | undefined;
        fetchBaseURL?: string | null | undefined;
        searchMode?: "basic" | "pro" | null | undefined;
    } & Dict, string>>, NoInfer<Dict<Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        apiKeyEnv: z<string, string, "plain">;
        baseURL: z<string, string, "plain">;
        fetchBaseURL: z<string, string, "plain">;
        searchMode: z<"basic" | "pro", "basic" | "pro", "plain">;
    }>>, string>>, "volatile">;
    search: z<Schemastery.ObjectS<NoInfer<{
        maxFanoutMs: z<number, number, "defined">;
        rrfK: z<number, number, "defined">;
        rerankPool: z<number, number, "defined">;
        rerank: z<boolean, boolean, "volatile-defined">;
        rerankTimeoutMs: z<number, number, "defined">;
        anysearchApiKeyEnv: z<string, string, "volatile-defined">;
        siliconflowApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchBaseURL: z<string, string, "defined">;
        rerankBaseURL: z<string, string, "defined">;
        decisionModel: z<"Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "volatile-defined">;
        decisionTimeoutMs: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxFanoutMs: z<number, number, "defined">;
        rrfK: z<number, number, "defined">;
        rerankPool: z<number, number, "defined">;
        rerank: z<boolean, boolean, "volatile-defined">;
        rerankTimeoutMs: z<number, number, "defined">;
        anysearchApiKeyEnv: z<string, string, "volatile-defined">;
        siliconflowApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchBaseURL: z<string, string, "defined">;
        rerankBaseURL: z<string, string, "defined">;
        decisionModel: z<"Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "Kev-4b" | "SemIf" | "diffusiongemma" | "decision-model-preview" | "jev-latest", "volatile-defined">;
        decisionTimeoutMs: z<number, number, "defined">;
    }>>, "defined">;
    fetch: z<Schemastery.ObjectS<NoInfer<{
        staticRouting: z<boolean, boolean, "defined">;
        staticDomains: z<string[], string[], "defined">;
        staticExtensions: z<string[], string[], "defined">;
        perEngineTimeoutMs: z<number, number, "defined">;
        blockPrivateAddresses: z<boolean, boolean, "volatile-defined">;
        probeTimeoutMs: z<number, number, "volatile-defined">;
        singleChannelEscalate: z<boolean, boolean, "volatile-defined">;
        engineWeights: z<Dict<number, string>, Dict<number, string>, "defined">;
        firecrawlApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchApiKeyEnv: z<string, string, "volatile">;
        firecrawlBaseURL: z<string, string, "defined">;
        anysearchBaseURL: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        staticRouting: z<boolean, boolean, "defined">;
        staticDomains: z<string[], string[], "defined">;
        staticExtensions: z<string[], string[], "defined">;
        perEngineTimeoutMs: z<number, number, "defined">;
        blockPrivateAddresses: z<boolean, boolean, "volatile-defined">;
        probeTimeoutMs: z<number, number, "volatile-defined">;
        singleChannelEscalate: z<boolean, boolean, "volatile-defined">;
        engineWeights: z<Dict<number, string>, Dict<number, string>, "defined">;
        firecrawlApiKeyEnv: z<string, string, "volatile-defined">;
        anysearchApiKeyEnv: z<string, string, "volatile">;
        firecrawlBaseURL: z<string, string, "defined">;
        anysearchBaseURL: z<string, string, "defined">;
    }>>, "plain">;
}>>, "plain">;
/** Register aggregated providers behind the native tools. */
export declare function apply(ctx: Context, config: Config): void;
