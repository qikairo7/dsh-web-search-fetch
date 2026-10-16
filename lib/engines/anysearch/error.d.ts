/**
 * Failure vocabulary for the AnySearch engine.
 *
 * Two axes meet here and are deliberately kept apart:
 *
 * - {@link AnySearchFailureKind} is the aggregation axis. `rate-limit` and
 *   `quota-exhausted` are the signals the quota circuit breaker (#7) consumes;
 *   the rest exist so logs and adapters can route without parsing a message.
 * - {@link mapExtractErrorCodeToWebErrorCode} is the seam axis. It reproduces
 *   the reference implementation's six `extract_*` → `WEB_*` mappings verbatim,
 *   because those are the codes `dsh-tool-web` reports to the model.
 *
 * Classification reads the stable machine-readable fields (`http_status`,
 * `error_code`) only. Free-text `message` from upstream never selects a kind:
 * it is untrusted data, and keyword-matching it would make the breaker
 * triggerable by page content.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97 (src/client.ts,
 * src/fetch-provider.ts), MIT. Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch/error
 */
/** Operations this engine can run. */
export type AnySearchOperation = 'search' | 'extract' | 'domains' | 'sub_domains';
/** Whether the request carried a credential or went out anonymously. */
export type AnySearchAuthentication = 'anonymous' | 'credential';
/**
 * Failure classification. `rate-limit` and `quota-exhausted` are the two the
 * circuit breaker acts on; DESIGN.md treats a 429 and an exhausted account
 * quota as the same "stop this engine for today" trigger, but they are
 * reported separately so a caller can choose to retry a throttle and not a
 * spent balance.
 */
export type AnySearchFailureKind = 
/** The caller's signal fired; no result was produced and none should be expected. */
'aborted'
/** The engine-side deadline fired. Distinct from `aborted`: the caller did not ask for this. */
 | 'timeout'
/** Upstream throttled the request (HTTP 429, or an `error_code` naming a rate limit). */
 | 'rate-limit'
/** The account has no quota or credit left (HTTP 402, or an `error_code` naming exhaustion). */
 | 'quota-exhausted'
/** Credential rejected or missing where required. Named `auth-failed` to match Zhihu's vocabulary (#4). */
 | 'auth-failed'
/** Extract refused the URL as malformed (`invalid_extract_url`). */
 | 'invalid-url'
/** Extract refused to fetch the target (`extract_target_blocked`). */
 | 'blocked-url'
/** Extract found the body larger than it will return (`extract_content_too_large`). */
 | 'too-large'
/** Extract cannot represent the content type (`extract_unsupported_content`). */
 | 'unsupported-content'
/** The client itself is misconfigured (unusable base URL, placeholder credential). */
 | 'config'
/** The request never produced an HTTP response (DNS, TLS, socket, redirect refusal). */
 | 'transport'
/** A response arrived but reported a business failure not covered above. */
 | 'upstream';
/**
 * Structured classification handed to the pipeline and the circuit breaker
 * (#7). Every field except `kind` and `operation` is upstream-supplied and
 * therefore optional.
 */
export interface AnySearchFailureSignal {
    readonly kind: AnySearchFailureKind;
    readonly operation: AnySearchOperation;
    /** HTTP status when a response arrived. */
    readonly httpStatus?: number;
    /** Stable upstream business error code, e.g. `extract_target_blocked`. */
    readonly errorCode?: string;
    /** Upstream request id, for correlating with AnySearch support. */
    readonly requestId?: string;
    /** `Retry-After` exactly as received. */
    readonly retryAfter?: string;
    /** `Retry-After` converted to milliseconds; omitted when unparseable. */
    readonly retryAfterMs?: number;
    readonly authentication?: AnySearchAuthentication;
}
/** Inputs the pure classifier reads. All are stable, machine-readable fields. */
export interface AnySearchFailureInput {
    /** HTTP status of an arrived response. */
    readonly httpStatus?: number;
    /** Stable upstream business error code. */
    readonly errorCode?: string;
    /** The caller's signal had already fired. */
    readonly aborted?: boolean;
    /** The engine-side deadline had already fired. */
    readonly timedOut?: boolean;
    /** The request failed before any response arrived. */
    readonly transport?: boolean;
}
/**
 * Map a stable Extract `error_code` onto the seam's `WEB_*` code. Unknown codes
 * (e.g. `extract_proxy_unavailable`) fall back to `WEB_PROVIDER_ERROR`, which
 * is what the reference implementation does.
 */
export declare function mapExtractErrorCodeToWebErrorCode(errorCode: string | undefined): string;
/**
 * Classify one failure from stable fields only. Precedence: caller abort, then
 * the engine deadline, then a known `error_code`, then quota/rate wording in
 * `error_code`, then HTTP status, then "no response arrived", then the
 * catch-all. `error_code` deliberately outranks HTTP status: Extract reports
 * `extract_target_blocked` with 403, which would otherwise read as `auth`.
 */
export declare function classifyAnySearchFailure(input: AnySearchFailureInput): AnySearchFailureKind;
/**
 * Parse `Retry-After` into milliseconds. The header is either delta-seconds or
 * an HTTP-date; anything else yields `undefined` rather than a guess.
 */
export declare function parseRetryAfterMs(value: string | undefined): number | undefined;
/** Constructor options for {@link AnySearchClientError}. */
export interface AnySearchClientErrorOptions {
    /** Defaults to the classifier's verdict for the supplied stable fields. */
    readonly kind?: AnySearchFailureKind;
    readonly operation: AnySearchOperation;
    readonly httpStatus?: number;
    readonly errorCode?: string;
    readonly requestId?: string;
    readonly retryAfter?: string;
    readonly authentication?: AnySearchAuthentication;
    readonly cause?: unknown;
}
/**
 * Every failure this engine raises. The message is safe to log and safe to
 * hand back through the seam: it carries no credential value, and any upstream
 * text inside it is bounded and explicitly labelled untrusted.
 */
export declare class AnySearchClientError extends Error {
    /** Aggregation axis, consumable directly by the quota circuit breaker (#7). */
    readonly kind: AnySearchFailureKind;
    readonly operation: AnySearchOperation;
    readonly httpStatus?: number;
    readonly errorCode?: string;
    readonly requestId?: string;
    readonly retryAfter?: string;
    readonly retryAfterMs?: number;
    readonly authentication?: AnySearchAuthentication;
    /** The same facts as a plain object, for a breaker that only wants data. */
    readonly signal: AnySearchFailureSignal;
    constructor(message: string, options: AnySearchClientErrorOptions);
}
/**
 * Read the classification off an arbitrary caught value, for callers that
 * catch broadly. Returns `undefined` for anything this engine did not raise,
 * so a pipeline can tell "AnySearch throttled us" from "something else broke".
 *
 * Mirrors `readZhihuCircuitSignal` from the Zhihu engine (#4): both engines
 * expose one function with the same shape, so the aggregation pipeline reads
 * every engine's failure the same way.
 */
export declare function anySearchFailureSignal(error: unknown): AnySearchFailureSignal | undefined;
/**
 * Build the message for an arrived-but-failed response. The upstream detail is
 * bounded, JSON-quoted (so an embedded newline cannot forge a log line), and
 * labelled untrusted, because it is attacker-influenced text.
 */
export declare function upstreamFailureMessage(operation: AnySearchOperation, detail: string, facts: readonly string[]): string;
/** Bound and JSON-quote attacker-influenced text for a failure message. */
export declare function boundedUpstreamDetail(detail: string): string;
