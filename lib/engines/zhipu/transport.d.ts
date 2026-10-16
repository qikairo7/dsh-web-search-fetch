/**
 * Transport helpers for Zhipu search: credential resolution, failure
 * classification, and the
 * upstream error-body reader. Request shaping and HTTP-status classification
 * stay in each operation's client, because those genuinely differ.
 * @module engines/zhipu/transport
 */
import { WebError } from '@deepseek-ai/dsh-web';
/** Structured upstream error body `{"error":{"code","message"}}`, narrowed. */
export interface UpstreamErrorBody {
    /** Upstream code stringified (`1701` and `"1701"` compare equal). */
    readonly code?: string;
    /** Upstream message, truncated to a safe bound. */
    readonly message?: string;
}
/**
 * Rate-limit circuit-breaker signal (DESIGN.md 熔断): the provider layer
 * day-scopes an engine off when it observes one on a failure. The repo's
 * first classification of this kind — a minimal closed shape other engine
 * branches can adopt. Failures attach it as the error's `cause`.
 */
export interface ZhipuRateLimitSignal {
    readonly kind: 'rate-limit';
    /** Upstream `Retry-After` hint in milliseconds, when the response carried one. */
    readonly retryAfterMs?: number;
}
/** Narrow a caught `cause` to the rate-limit signal. */
export declare function isZhipuRateLimitSignal(value: unknown): value is ZhipuRateLimitSignal;
/**
 * Parse a `Retry-After` header value — delta-seconds or an HTTP-date — into
 * milliseconds. Anything unreadable yields `undefined` (a missing hint, not
 * a failure).
 */
export declare function parseRetryAfterMs(value: string | null): number | undefined;
/** Build the breaker signal from a 429 response's headers. */
export declare function rateLimitSignalFromHeaders(headers: Headers): ZhipuRateLimitSignal;
/** One resolved credential per operation; `undefined`/empty is a failure. */
export declare function resolveCredential(resolveApiKey: () => Promise<string | undefined>, credentialName: string, label: string): Promise<string>;
/**
 * Classify a transport-level failure into the seam's shared codes: an aborted
 * outer signal is `WEB_ABORTED`; the internal deadline and everything else
 * (DNS/TLS/socket failures) are `WEB_PROVIDER_ERROR`. `label` is the
 * operation name (`Zhipu web search` / `Zhipu reader`), so failure messages
 * stay operation-specific without duplicating this logic.
 */
export declare function classifyTransportFailure(error: unknown, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number, label: string): WebError;
/**
 * Narrow a raw error-body text into {@link UpstreamErrorBody}. Never throws;
 * unreadable or shapeless bodies yield `undefined`. Codes are stringified so
 * the numeric API spellings (`1701`) and quoted ones (`"1701"`) compare equal.
 */
export declare function parseUpstreamErrorBody(text: string): UpstreamErrorBody | undefined;
/**
 * Format a bounded `(code …): message` suffix from a parsed upstream error
 * body (`{"error":{"code","message"}}`). Unreadable bodies yield `''`.
 */
export declare function formatUpstreamErrorDetail(body: UpstreamErrorBody | undefined): string;
/**
 * Extract a bounded `(code …): message` suffix from a raw upstream error body
 * text. Never throws; unreadable bodies yield `''`.
 */
export declare function extractUpstreamErrorDetail(text: string): string;
/**
 * Read a failed response's body text leniently — callers treat an unreadable
 * body as "no detail". Only a read that fails like a transport error throws.
 */
export declare function readFailureBodyText(response: Response, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number, label: string): Promise<string>;
/**
 * Read a 2xx response's JSON envelope. Malformed bodies are provider errors:
 * unparseable → `${label} returned an unreadable JSON body`; non-object →
 * `${label} returned a non-object response body`.
 */
export declare function readJsonEnvelope(response: Response, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number, label: string): Promise<Record<string, unknown>>;
