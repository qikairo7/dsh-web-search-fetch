export interface RuntimeControls {
    mode?: 'organize' | 'select';
    preset?: 'auto' | 'custom' | 'free' | 'balanced' | 'deep';
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
export declare function serviceEnabled(id: string, fallback?: boolean): boolean;
export declare function deadlineReached(): boolean;
/** A cancelled lane must settle even if its injected transport ignores the signal. */
export declare function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T>;
/** Per-provider-operation context isolates concurrent queries and their retries. */
export declare function runOperation<T>(controls: RuntimeControls, face: 'search' | 'fetch', caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
/** Attach the operation's request text so the automatic preset can use it. */
export declare function resolveRuntimeRequest(controls: RuntimeControls, request: 'search' | 'fetch', text: string): RuntimeControls;
/** Resolve the automatic preset through the configured decision model. */
export declare function resolveAutomaticDepth(signal?: AbortSignal): Promise<'fast' | 'balanced' | 'deep' | undefined>;
/** Every plugin-owned HTTP attempt acquires a permit before any network write. */
export declare function budgetedFetch(fetcher?: typeof fetch): typeof fetch;
export declare function selectServices<T>(items: readonly T[], id: (item: T) => string, face: 'search' | 'fetch', ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>): Promise<T[]>;
/**
 * Resolve the automatic preset's cap. The rule layer is local and deterministic:
 * search query intent decides between a fast lane and broad fan-out; fetch URL
 * shape and configured limits decide between the recommended trio and a deep
 * run. Users never select the resulting depth manually.
 */
export declare function resolveAutoCap(controls: RuntimeControls, face: 'search' | 'fetch', decisionDepth?: 'fast' | 'balanced' | 'deep'): number;
