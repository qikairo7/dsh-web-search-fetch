/**
 * Zhihu `global_search` HTTP client plus the `quota` call the search pipeline's
 * breaker consumes. Every failure path throws a `WebError` carrying one of the
 * seam's shared codes, so the provider layer adds no translation of its own;
 * failures the breaker reacts to also carry a machine-readable
 * {@link ZhihuCircuitSignal} rather than inviting anyone to parse a message.
 * @module engines/zhihu/client
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { ZHIHU_ENGINE_DEFAULTS, type ResolvedZhihuEngineOptions, type ZhihuEngineOptions } from './options.js';
import type { ZhihuQuota, ZhihuSearchResponse } from './types.js';
/** Business `Code` values documented for the Zhihu OpenAPI. */
export declare const ZHIHU_CODE_INVALID_PARAM = 10001;
export declare const ZHIHU_CODE_AUTH_FAILED = 20001;
export declare const ZHIHU_CODE_RATE_LIMITED = 30001;
export declare const ZHIHU_CODE_INTERNAL_ERROR = 90001;
/**
 * What the search pipeline's breaker acts on. `rate-limit` means "back off and
 * try later"; `auth-failed` means the credential is unusable (`20001` or HTTP
 * 401/403); `quota-exhausted` means today's allowance is gone; `invalid-request`
 * means this query is malformed and retrying it cannot help.
 */
export interface ZhihuCircuitSignal {
    readonly kind: 'rate-limit' | 'auth-failed' | 'quota-exhausted' | 'invalid-request';
}
/** A `WebError` that additionally exposes the breaker signal, when there is one. */
export declare class ZhihuWebError extends WebError {
    readonly signal: ZhihuCircuitSignal | undefined;
    constructor(message: string, options?: ErrorOptions & {
        signal?: ZhihuCircuitSignal;
    });
}
/** Read the breaker signal off a caught failure, or `undefined` when there is none. */
export declare function readZhihuCircuitSignal(error: unknown): ZhihuCircuitSignal | undefined;
export interface ZhihuClientOptions extends ZhihuEngineOptions {
    /**
     * Resolve the access secret once per operation; `undefined` means
     * unconfigured. Never cached (per-operation credential resolution).
     */
    resolveAccessSecret: () => Promise<string | undefined>;
    /** Credential reference name used in error messages (the value never appears). */
    credentialName: string;
    /** `fetch` implementation override for focused tests. */
    fetchImpl?: typeof fetch;
    /** Clock override for the timestamp header, in epoch milliseconds. */
    now?: () => number;
}
export declare class ZhihuClient {
    readonly options: ResolvedZhihuEngineOptions;
    private readonly fetchImpl;
    private readonly resolveAccessSecret;
    private readonly credentialName;
    private readonly now;
    constructor(options: ZhihuClientOptions);
    /**
     * One `global_search` call. `Count` is derived here rather than by the caller
     * so the engine's configured ceiling is the only one that can apply. Throws
     * {@link ZhihuWebError} on every failure path.
     */
    search(query: string, maxResults?: number, signal?: AbortSignal): Promise<ZhihuSearchResponse>;
    /**
     * Today's quota for `global_search`. `undefined` means the body carried no
     * readable entry — not exhaustion; use `remaining <= 0` for that.
     */
    quota(signal?: AbortSignal): Promise<ZhihuQuota | undefined>;
    /** Append query parameters without disturbing any the configured URL already carries. */
    private urlWith;
    /**
     * One authenticated GET. The access secret is resolved per call and the
     * timestamp header is computed from the current clock per call, so a long
     * session never sends a stale `X-Request-Timestamp`.
     */
    private request;
    /** Non-2xx: 401/403 → auth-failed, 429 → rate-limit; upstream detail is kept. */
    private errorFromHttpStatus;
    /** 2xx: parse the JSON envelope; malformed bodies are provider errors. */
    private readJsonBody;
}
/**
 * Classify a transport-level failure: an aborted outer signal is `WEB_ABORTED`,
 * the internal deadline and everything else (DNS/TLS/socket failures) are
 * provider errors. Cancellation is not the engine's fault, so it carries no
 * breaker signal.
 */
export declare function translateZhihuTransportFailure(error: unknown, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number): WebError;
/**
 * Extract a bounded `(Code …): Message` suffix from an upstream error body.
 * Never throws; unreadable bodies yield `''`.
 */
export declare function extractZhihuErrorDetail(text: string): string;
/** Re-exported so callers can read the effective defaults without another import. */
export { ZHIHU_ENGINE_DEFAULTS };
