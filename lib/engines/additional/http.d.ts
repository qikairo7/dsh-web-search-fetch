import { WebError } from '@deepseek-ai/dsh-web';
import type { BreakerSignal } from '../../breaker/index.js';
export interface EngineHttpOptions {
    id: string;
    baseURL: string;
    resolveApiKey: () => Promise<string | undefined>;
    auth: 'bearer' | 'x-api-key' | 'none';
    accept?: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    /**
     * Read the target site's own status from a non-2xx response body, when the
     * engine reports a site-side error as its own gateway failure.
     *
     * Injected rather than branched on `id` here: recognising a vendor's error
     * envelope is response mapping, and the transport stays protocol-agnostic
     * (CONTRIBUTING「服务协议映射与 HTTP 传输分离」). Returning `undefined` keeps
     * the response an engine failure.
     */
    readTargetStatus?: (response: Response) => Promise<number | undefined>;
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
/**
 * A non-2xx *target* reported inside an engine's own error envelope.
 *
 * A `WebError`, so the seam's unified `WEB_*` error contract holds and any
 * caller that does not special-case it still routes on a stable code. The
 * target status rides alongside as `targetStatus` so the adapter can turn it
 * into a fetched result.
 */
export declare class TargetStatusError extends WebError {
    readonly engineId: string;
    readonly targetStatus: number;
    constructor(engineId: string, targetStatus: number);
}
/**
 * Crawl4AI's target-status reader.
 *
 * The cloud API answers a site-side 4xx with its own 502 and puts the site's
 * code in `origin_status` (https://api.crawl4ai.com/llms.txt). Lives here, with
 * the engine, so the transport stays free of vendor protocol knowledge.
 */
export declare function readCrawl4aiTargetStatus(response: Response): Promise<number | undefined>;
export declare function record(value: unknown, id: string): Record<string, unknown>;
export declare function rows(value: unknown, id: string): Record<string, unknown>[];
export declare function text(value: unknown): string | undefined;
export declare function additionalBreakerSignal(error: unknown): BreakerSignal | undefined;
