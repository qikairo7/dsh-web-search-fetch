export interface RuntimeControls {
    mode?: 'organize' | 'select';
    /**
     * Dispatch breadth. `single` uses one channel and `multi` uses every eligible
     * one; `auto` picks between the two with the local rule (or the decision
     * model when `decisionRouting` is `model`). `balanced` and `deep` stay so a
     * saved configuration keeps working; they behave as capped breadth.
     */
    preset?: 'auto' | 'single' | 'multi' | 'custom' | 'free' | 'balanced' | 'deep';
    /**
     * How the automatic preset decides its breadth. `off` (the default) uses the
     * local query rule and never calls a model; `model` asks the configured
     * decision model first and falls back to the local rule on any failure.
     */
    decisionRouting?: 'off' | 'model';
    /** The request used by the automatic preset; absent for static configuration-only calls. */
    request?: 'search' | 'fetch';
    /** The query (search) or URL (fetch) used by the automatic preset. */
    requestText?: string;
    searchServices?: readonly string[];
    fetchServices?: readonly string[];
    serviceEnabled?: Readonly<Record<string, boolean>>;
    maxSearchServices?: number;
    maxFetchServices?: number;
    maxRequests?: number;
    searchDeadlineMs?: number;
    fetchDeadlineMs?: number;
    maxOutputChars?: number;
    decision?: DecisionRouter;
}
export interface DecisionRouter {
    readonly failureReason?: string;
    decide(request: 'search' | 'fetch', text: string, signal?: AbortSignal): Promise<{
        depth: 'fast' | 'balanced' | 'deep';
        model: string;
        confidence?: number;
    } | null>;
}
export declare function operationNotes(): readonly string[];
export declare function noteOperation(note: string): void;
export declare function requestCount(): number;
export declare function currentControls(): RuntimeControls;
export declare function currentDecisionDepth(): 'fast' | 'balanced' | 'deep' | undefined;
export declare function serviceEnabled(id: string, fallback?: boolean): boolean;
export declare function deadlineReached(): boolean;
/** A cancelled lane must settle even if its injected transport ignores the signal. */
export declare function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T>;
/** Per-provider-operation context isolates concurrent queries and their retries. */
export declare function runOperation<T>(controls: RuntimeControls, face: 'search' | 'fetch', caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
/** Attach the operation's request text so the automatic preset can use it. */
export declare function resolveRuntimeRequest(controls: RuntimeControls, request: 'search' | 'fetch', text: string): RuntimeControls;
/**
 * Resolve the automatic preset through the configured decision model.
 *
 * `decisionRouting` is `off` by default: the local rule is deterministic, free,
 * and never fails. When it is `model`, a decision is requested first; a missing
 * model, a transport failure, or an unusable answer is noted and the caller
 * falls back to the local rule — an unreachable decision model must not turn
 * into "no results".
 */
export declare function resolveAutomaticDepth(signal?: AbortSignal): Promise<'fast' | 'balanced' | 'deep' | undefined>;
/** Every plugin-owned HTTP attempt acquires a permit before any network write. */
export declare function budgetedFetch(fetcher?: typeof fetch): typeof fetch;
/**
 * Select the services one operation dispatches.
 * @param items - candidate services, in dispatch order.
 * @param id - service id accessor.
 * @param face - which capability's scope applies.
 * @param ready - optional credential/availability probe.
 * @param capOverride - explicit breadth, used when a preset escalates beyond
 *   its own cap (for example the single preset's documented fallback).
 */
export declare function selectServices<T>(items: readonly T[], id: (item: T) => string, face: 'search' | 'fetch', ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>, capOverride?: number): Promise<T[]>;
/**
 * Resolve how many services one operation may dispatch.
 *
 * The preset names the breadth directly (`single` = one channel, `multi` =
 * every eligible one), while the automatic preset decides between those two.
 * The local rule is deterministic and free: a query that asks for comparison,
 * research or recency is worth several channels, and everything else starts
 * with one. A decision model is consulted only when `decisionRouting` is
 * `model`, and its `fast`/`balanced`/`deep` answer maps onto the same breadth
 * scale. `balanced` and `deep` are legacy presets kept for saved
 * configurations; they behave as capped and full breadth.
 *
 * The fetch face keeps its URL-shape rule as a second signal: the automatic
 * two-stage probe (see `fetch-pipeline.ts`) already spends one request before
 * any fan-out, so a plain page can still fan out when the probe is not enough.
 */
export declare function resolveAutoCap(controls: RuntimeControls, face: 'search' | 'fetch', decisionDepth?: 'fast' | 'balanced' | 'deep'): number;
/**
 * The local breadth rule: does this query ask for comparison, research or
 * recency — the intents where one channel demonstrably misses material?
 * @param query - the search query as the caller wrote it.
 * @returns whether several channels are warranted.
 */
export declare function multiChannelQuery(query: string): boolean;
/**
 * Whether the current preset dispatches several channels, so a settlement
 * window may end the slow lanes early. The single-channel presets never have
 * more than one lane to settle against.
 */
export declare function multiChannelPreset(controls?: RuntimeControls): boolean;
