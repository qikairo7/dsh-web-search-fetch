import type { BreakerSignal } from '../../breaker/index.js';
export interface EngineHttpOptions {
    id: string;
    baseURL: string;
    resolveApiKey: () => Promise<string | undefined>;
    auth: 'bearer' | 'x-api-key' | 'none';
    accept?: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}
/** Transport shared by the additional HTTP engines; each call resolves its own credential. */
export declare class EngineHttp {
    private readonly options;
    private readonly cache;
    private cooldown?;
    constructor(options: EngineHttpOptions);
    call(path: string, body: unknown, signal?: AbortSignal, query?: URLSearchParams): Promise<Record<string, unknown>>;
    callText(path: string, body: unknown, signal?: AbortSignal, query?: URLSearchParams): Promise<string>;
    /** Opt-in conditional GET for AIHOT; bounded private cache, never a stale fallback. */
    cachedGet(path: string, signal: AbortSignal | undefined, query: URLSearchParams): Promise<Record<string, unknown>>;
    /** JSON and Agent Markdown share conditional caching; the caller validates the representation. */
    cachedText(path: string, signal: AbortSignal | undefined, query: URLSearchParams, defaultTtlSeconds?: number): Promise<string>;
    private request;
}
export declare function record(value: unknown, id: string): Record<string, unknown>;
export declare function rows(value: unknown, id: string): Record<string, unknown>[];
export declare function text(value: unknown): string | undefined;
export declare function additionalBreakerSignal(error: unknown): BreakerSignal | undefined;
