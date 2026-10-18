import type { RuntimeControls } from './request-budget.js';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { BreakerSignal, CircuitBreaker } from './breaker/index.js';
/** Default per-engine deadline (DESIGN.md: single-engine limit of 10 s). */
export declare const DEFAULT_SEARCH_MAX_FANOUT_MS = 10000;
/** Default RRF constant `k` (the standard 60). */
export declare const DEFAULT_RRF_K = 60;
/** Default size of the candidate pool handed to rerank (DESIGN.md: top 20). */
export declare const DEFAULT_RERANK_POOL = 20;
/**
 * One engine's quota reading, narrowed to the only field the breaker acts on.
 * A missing reading is not exhaustion; `remaining <= 0` is.
 */
export interface SearchEngineQuota {
    readonly remaining: number;
}
/**
 * What the orchestration needs from an engine. Deliberately smaller than any
 * concrete engine class: an id for the breaker and the logs, a seam-shaped
 * `search`, and — for engines with a queryable daily allowance — `quota`.
 */
export interface SearchEngineClient {
    /** Stable engine id; also the breaker's key. */
    readonly id: string;
    /** Run one search. Failures are contained by the caller. */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    /**
     * Today's allowance for this engine, when the engine can report one. The
     * pipeline probes it at most once per local day and never lets a failed probe
     * block a search.
     */
    quota?(signal?: AbortSignal): Promise<SearchEngineQuota | undefined>;
}
/** What the orchestration needs from the rerank engine (a full permutation, or `null` to degrade). */
export interface RerankHandle {
    readonly enabled?: boolean;
    readonly free?: boolean;
    rerank(query: string, documents: readonly string[], topN: number, signal?: AbortSignal): Promise<number[] | null>;
}
/** The log sink the pipeline writes engine latency, failures, and breaker state to. */
export interface SearchLogSink {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
/** One engine's ranked output, in that engine's own relevance order. */
export interface EngineRanking {
    readonly engineId: string;
    readonly sources: readonly WebSearchSource[];
}
/** One fused candidate: a normalized URL plus its merge result and RRF score. */
export interface FusedCandidate {
    /** Normalized (deduplication) key, and the URL handed back through the seam. */
    readonly url: string;
    /** `Σ 1 / (k + rank)` over the engines that returned this URL. */
    readonly score: number;
    /** Engine ids that returned this URL, in dispatch order. */
    readonly contributors: readonly string[];
    readonly title?: string;
    readonly snippet?: string;
    readonly publishedAt?: string;
}
/** Construction-time dependencies of {@link AggregatedSearchProvider}. */
export interface AggregatedSearchOptions {
    readonly resolveControls?: () => RuntimeControls;
    readonly ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>;
    /** Engines to fan out to, in dispatch order. */
    readonly engines: readonly SearchEngineClient[];
    readonly resolveEngines?: () => readonly SearchEngineClient[];
    /** The shared breaker; consulted before dispatch and fed every forwarded signal. */
    readonly breaker: CircuitBreaker;
    /** Optional rerank stage; omitted means pure RRF. */
    readonly rerank?: RerankHandle;
    /** Where engine outcome and breaker lines go. Defaults to silence. */
    readonly logger?: SearchLogSink;
    /** Per-engine deadline in milliseconds. Default 10 000. */
    readonly maxFanoutMs?: number;
    /** RRF constant `k`. Default 60. */
    readonly rrfK?: number;
    /** Candidates handed to rerank, best-first. Default 20. */
    readonly rerankPool?: number;
    /** Whether to probe engines that expose `quota()` once per local day. Default `true`. */
    readonly quotaCheck?: boolean;
    /** Clock override, in epoch milliseconds. Defaults to `Date.now`. */
    readonly now?: () => number;
}
/**
 * The aggregated search provider registered on `ctx.web`.
 *
 * One `search()` call: probe the daily quota of quota-capable engines (at most
 * once per local day) → skip engines the breaker has taken out of rotation →
 * fan out with a per-engine deadline → deduplicate and RRF-fuse the survivors →
 * rerank the top `rerankPool` (degrading to RRF order) → truncate to
 * `maxResults` and report `truncated`.
 */
export declare class AggregatedSearchProvider implements WebSearchProvider {
    private readonly controls;
    private readonly ready?;
    /** Stable id; the fetch face registers the same id on its own registry. */
    readonly id = "aggregated";
    private readonly engines;
    private readonly resolveEngines;
    private readonly breaker;
    private readonly rerank;
    private readonly logger;
    private readonly maxFanoutMs;
    private readonly rrfK;
    private readonly rerankPool;
    private readonly quotaCheckEnabled;
    private readonly now;
    /** Local-day key of the last quota sweep; `undefined` until the first search. */
    private quotaCheckedDay;
    constructor(options: AggregatedSearchOptions);
    /**
     * Cheap local usability check. Credential presence is decided per call
     * (resolved, never cached), so it cannot be answered here without I/O.
     */
    available(): boolean;
    /** Run one aggregated search. */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    private searchOperation;
    /**
     * Dispatch one round of lanes under a settlement window, collecting every
     * lane's end state so the zero-result note can name all of them.
     * @param lanes - engine plus the query that lane should run.
     * @param window - the round's settlement window; closed here.
     * @param request - the caller's request; each lane gets it with its own query.
     * @param accept - records each settled lane and feeds the settlement window.
     */
    private dispatchRound;
    /**
     * Fuse and relevance-filter the successful lanes' rankings.
     * @param query - the caller's query.
     * @param rankings - successful lanes' outputs, in dispatch order.
     * @returns the candidates worth returning, best first.
     */
    private relevantCandidates;
    /**
     * Issue #20 phase 2: widen a single-channel run exactly once when its only
     * lane answered successfully but produced nothing usable.
     *
     * Only the single-channel breadth escalates — the explicit `single` preset
     * (mirroring the fetch side's `singleChannelEscalate` precedent) and the
     * automatic preset's own single-channel decision. A multi-channel preset
     * already spread the query; widening it would change the breadth the user
     * asked for. A lane that failed, timed out, was cancelled or hit a rate
     * limit never escalates: it already consumed its share of the budget and
     * the remaining channels are likely under the same limit. The escalation
     * itself respects the preset's service list, enablement, credential
     * presence, service cap and the operation's remaining request budget, and
     * it is a single step: no second escalation follows it.
     * @param request - the caller's request.
     * @param outcomes - the first round's lanes, in dispatch order.
     * @param signal - the operation signal.
     * @returns the escalated round's outcomes and window state, or `undefined`
     *   when this run must not (or cannot) escalate.
     */
    private escalateEmptySearch;
    /** Build the per-lane recorder that also feeds the settlement window. */
    private laneAcceptor;
    /**
     * Probe the daily allowance of every quota-capable engine, at most once per
     * local day. The day is marked as swept before the
     * probes run, so one failed probe cannot make the pipeline retry all day; a
     * probe failure is logged and ignored, never blocking a search.
     */
    private sweepDailyQuota;
    /**
     * Run one lane: skip a broken engine, otherwise race the engine against the
     * per-engine deadline. Always resolves to an outcome — containment is the
     * point, so a throwing engine cannot take the fan-out down with it.
     *
     * The deadline is enforced here rather than left to each engine's own
     * transport budget: when it fires, the lane's signal is aborted, so a hung
     * request is actually torn down instead of being left running after its
     * result was already discarded.
     */
    private dispatch;
    /**
     * Rerank the candidate pool, keeping RRF order on every degrade path. The
     * only failure that propagates is the caller's own cancellation: a rerank
     * miss must never turn into "no search results" (DESIGN.md).
     */
    private applyRerank;
}
/**
 * Normalize a result URL into its deduplication key (DESIGN.md): every `utm_*`
 * parameter is dropped, the `#fragment` is dropped, scheme and hostname are
 * lowercased (which `URL` already does), and a root path is normalized so `/`
 * and `''` share one key. Other parameters and non-root trailing slashes stay
 * significant except for the verified MDN and TypeScript aliases below.
 *
 * A URL that does not parse is returned verbatim: deduplication may then miss a
 * merge, but the source is never dropped or rewritten into something the engine
 * did not return.
 */
export declare function normalizeSearchUrl(url: string): string;
/**
 * Reciprocal Rank Fusion over the engines' ranked outputs.
 *
 * `score(d) = Σ_engines 1 / (k + rank(d))`, with `rank` one-based within each
 * engine and every engine counting at most once per key (a repeated key inside
 * one engine's list is counted once, at its best rank). Ties break on first
 * appearance, so the output is deterministic for a given input.
 *
 * Identical keys merge into one candidate. The merge is field-wise and keeps
 * the richest value per field: a longer snippet wins, an already-present title
 * or `publishedAt` wins, and a missing field is filled from whichever copy has
 * it.
 */
export declare function rrfFuse(rankings: readonly EngineRanking[], k: number): FusedCandidate[];
/**
 * Project a caught engine failure onto the breaker's closed signal set, or
 * `undefined` when the failure is not a breaker event.
 *
 * Two sources are read, never parsed: the error itself, when it is one of the
 * engines' classified errors (`AnySearchClientError`), and its
 * `cause`, where an engine may hang a structured signal. Only the three
 * documented reasons pass through, spelled exactly as the breaker defines them;
 * every other engine classification (auth, invalid request, transport, …) is
 * deliberately not a breaker event.
 */
export declare function readSearchFailureSignal(error: unknown): BreakerSignal | undefined;
