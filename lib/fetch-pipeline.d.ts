import type { RuntimeControls } from './request-budget.js';
import type { HttpFetchLimits, HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web';
import type { CircuitBreaker } from './breaker/index.js';
import type { FetchEngineLeg, FetchPipelineLogger, FetchRouteOptions } from './fetch-aggregate.js';
import { type AdditionalEngine } from './engines/additional/index.js';
/** Transport and response limits, matching `dsh-web-fetch-http`'s own plugin defaults. */
export declare const DEFAULT_HTTP_FETCH_LIMITS: HttpFetchLimits;
/**
 * Structural view of the base dynamic-path engine clients (satisfied by the
 * real `FirecrawlClient` / `AnySearchEngine`, and by
 * fakes in tests). Each method resolves a normalized {@link WebFetchResult}.
 */
export interface ExtractionEngineClients {
    readonly firecrawl: {
        scrape(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
    };
    readonly anysearch: {
        extract(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
    };
}
/**
 * Bind the base dynamic-path engine clients into pipeline legs, attaching
 * each engine's breaker-signal reader. Array order is dispatch order and the
 * tie-break order of 择优: Firecrawl, AnySearch (the engine ids
 * match {@link DEFAULT_ENGINE_WEIGHTS}, so the default weights apply).
 */
export declare function createExtractionLegs(clients: ExtractionEngineClients): FetchEngineLeg[];
export interface AggregatedFetchProviderOptions {
    resolveControls?: () => RuntimeControls;
    ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>;
    additionalEngines?: readonly AdditionalEngine[];
    /** Partial limit overrides merged over {@link DEFAULT_HTTP_FETCH_LIMITS}. */
    limits?: Partial<HttpFetchLimits>;
    /** Address resolver override; production uses the package's public-address policy. */
    resolveAddresses?: HttpFetchResolver;
    /** Dynamic-path extraction engines, in dispatch order (selection ties go first-wins). */
    legs?: readonly FetchEngineLeg[];
    /** URL-aware routing knobs; defaults route static extensions to HTTP. */
    route?: FetchRouteOptions;
    /** Quota circuit breaker; broken engines are skipped before dispatch. */
    breaker?: CircuitBreaker;
    /** Pipeline log sink (per-engine failures, skips, 择优 and consistency lines). */
    logger?: FetchPipelineLogger;
    /** Dynamic-path per-engine deadline; defaults to the documented 45 s budget. */
    perEngineTimeoutMs?: number;
    /** Engine-weight overrides for 择优; missing entries fall back to defaults. */
    engineWeights?: Partial<Record<string, number>>;
}
export declare class AggregatedFetchProvider implements WebFetchProvider {
    /** Same id as the search face; the two seam registries are independent. */
    readonly id = "aggregated";
    private readonly http;
    private readonly options;
    constructor(options?: AggregatedFetchProviderOptions);
    /** The wrapped fetcher needs no credentials; always usable. */
    available(): boolean;
    /**
     * Retrieve one URL. Static routes pass straight through to the safe HTTP
     * fetcher; dynamic routes fan out to the extraction engines. Non-2xx target
     * responses are results (never throws) on both routes.
     */
    fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
    private fetchOperation;
}
