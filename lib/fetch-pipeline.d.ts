import type { RuntimeControls } from './request-budget.js';
import type { HttpFetchLimits, HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web';
import type { CircuitBreaker } from './breaker/index.js';
import type { FetchEngineLeg, FetchPipelineLogger, FetchRouteOptions } from './fetch-aggregate.js';
import { type AdditionalEngine } from './engines/additional/index.js';
import { type AddressLookup } from './address-guard.js';
/** Transport and response limits, matching `dsh-web-fetch-http`'s own plugin defaults. */
export declare const DEFAULT_HTTP_FETCH_LIMITS: HttpFetchLimits;
/** Deadline of the automatic preset's first-path probe; defaults to the documented 15 s. */
export declare const DEFAULT_PROBE_TIMEOUT_MS = 15000;
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
    /**
     * Whether a proven private/loopback destination is refused before any engine
     * or adapter sees the URL. Default `true`; `fetch.staticDomains` hosts are
     * exempt because the built-in HTTP fetcher enforces its own policy for them.
     */
    blockPrivateAddresses?: boolean;
    /** DNS resolver override for the address guard; defaults to the system resolver. */
    lookup?: AddressLookup;
    /** Deadline of the automatic preset's first-path probe; defaults to 15 s. */
    probeTimeoutMs?: number;
    /**
     * Whether the `single` preset may fall back to the multi-path organization
     * when its one channel fails or returns a thin body. Default `false`: an
     * explicit single-channel request is answered by exactly one channel.
     */
    singleChannelEscalate?: boolean;
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
    /**
     * Resolve the probe's first-path channel: the highest-priority eligible
     * extraction leg, after the same selection (priority, enablement, credential
     * presence) the fan-out uses. `undefined` when nothing is eligible.
     */
    private probeChannel;
    /** The highest-priority eligible extraction leg, using the fan-out's selection. */
    private firstEligibleLeg;
    /**
     * The `single` preset: one channel, served as the page's own text.
     *
     * Unlike the automatic probe, this is the user's explicit choice of breadth,
     * so a thin or off-target body is still returned as-is — the caller asked for
     * exactly one source and gets exactly one request. Two situations are
     * exceptions: a channel error, which propagates unless
     * `singleChannelEscalate` opts into the fan-out, and a cancelled operation,
     * which always propagates.
     */
    private singleChannelFetch;
    /** The multi-path organization, shared by every escalating preset. */
    private escalate;
    /**
     * Select the fan-out legs (priority, enablement, credential presence,
     * breaker). `escalating` lifts the `single` preset's one-channel cap, since
     * an escalation is a deliberate move to the multi-path organization.
     */
    private selectLegs;
    /**
     * Serve the probe's own text under the page's output budget.
     *
     * The automatic preset is the plugin's configured mode, so its output obeys
     * `maxOutputChars` like every organized result (user decision, 2026-10-20:
     * auto obeys the budget, `single` keeps the channel's own text). A body that
     * already fits is served verbatim — no footer, no markers — and a longer one
     * goes through {@link organizeDocuments}, which drops complete blocks, says
     * so, and marks `truncated`; that keeps code fences and structured payloads
     * intact instead of cutting mid-block. Structured JSON/XML over budget still
     * throws, as it does on the multi-path route.
     * @param request - the caller's request (for the target URL).
     * @param result - the probe's complete body.
     * @returns the served result, unchanged when it fits the budget.
     */
    private serveProbeUnderBudget;
    /**
     * Run the first-path probe: one request, no fan-out.
     *
     * Returns `undefined` when nothing is eligible to probe; otherwise a result
     * that is either ready to serve (`sufficient`) or a description of what the
     * escalation may reuse (`seeds` plus the engines it must not re-request).
     * A probe that throws or times out yields no seeds, so the fan-out covers
     * every channel.
     */
    private probeFirst;
}
