/**
 * Firecrawl v2 scrape HTTP client — the engine transport for the extract
 * pipeline's dynamic-page engine. Every upstream failure throws a
 * {@link FirecrawlError} (a `WebError`) carrying the machine-routable
 * {@link FirecrawlFailure} classification that the circuit breaker (#7) and
 * the fetch pipeline (#9) consume: `breaker` trips the engine's daily/rate
 * fuse, `retryable` marks the fixed status set, `fatal` is everything else.
 * A non-200 *target* is a fetched result, not an error (see DESIGN.md): when
 * Firecrawl returns a document, `metadata.statusCode` passes through.
 * @module engines/firecrawl/client
 */
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { FirecrawlFailure } from './wire.js';
export interface FirecrawlClientOptions {
    /** Resolve per operation; absent keys use anonymous credits on the official endpoint. */
    resolveApiKey: () => Promise<string | undefined>;
    /** Credential reference name used in error messages (the value never appears). */
    credentialName: string;
    /** Endpoint override (tests point this at a local mock server). */
    baseURL?: string;
    /** Per-request deadline; defaults to the documented single-engine budget (45 s). */
    timeoutMs?: number;
    /** `fetch` implementation override for focused tests. */
    fetchImpl?: typeof fetch;
}
/**
 * Upstream failure with its routing classification attached. Thrown for every
 * response Firecrawl itself returned an error for (including a `200`
 * `{success:false}` envelope); transport failures (timeout, network, abort)
 * throw a bare {@link WebError} — there is no upstream response to classify.
 */
export declare class FirecrawlError extends WebError {
    /** Machine-routable class for the breaker (#7) and pipeline (#9). */
    readonly classification: FirecrawlFailure;
    constructor(message: string, code: string, classification: FirecrawlFailure, options?: ErrorOptions);
}
export declare class FirecrawlClient {
    private readonly baseURL;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private readonly resolveApiKey;
    private readonly credentialName;
    constructor(options: FirecrawlClientOptions);
    /** One v2 scrape call. Throws a `WebError` on every failure path. */
    scrape(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
    /** Non-2xx: keep the upstream `code`/`error` detail in the failure message. */
    private errorFromResponse;
}
/**
 * Classify a transport-level failure into the seam's shared codes: an aborted
 * outer signal is `WEB_ABORTED`; the internal deadline and everything else
 * (DNS/TLS/socket failures) are `WEB_PROVIDER_ERROR`. Transport failures carry
 * no {@link FirecrawlFailure} — there was no upstream response to classify.
 */
export declare function translateTransportFailure(error: unknown, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number): WebError;
