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
import { FIRECRAWL_SCRAPE_TIMEOUT_MS, FIRECRAWL_SCRAPE_URL, isFirecrawlKeylessEndpoint, buildFirecrawlScrapeRequest, classifyFirecrawlHttpFailure, extractFirecrawlErrorCode, extractFirecrawlErrorDetail, firecrawlWebErrorCode, mapFirecrawlScrapeResult, parseRetryAfterMs, readFirecrawlScrapeSuccess, } from './wire.js';
/**
 * Upstream failure with its routing classification attached. Thrown for every
 * response Firecrawl itself returned an error for (including a `200`
 * `{success:false}` envelope); transport failures (timeout, network, abort)
 * throw a bare {@link WebError} — there is no upstream response to classify.
 */
export class FirecrawlError extends WebError {
    /** Machine-routable class for the breaker (#7) and pipeline (#9). */
    classification;
    constructor(message, code, classification, options) {
        super(message, code, options);
        this.classification = classification;
    }
}
export class FirecrawlClient {
    baseURL;
    timeoutMs;
    fetchImpl;
    resolveApiKey;
    credentialName;
    constructor(options) {
        this.baseURL = options.baseURL ?? FIRECRAWL_SCRAPE_URL;
        this.timeoutMs = options.timeoutMs ?? FIRECRAWL_SCRAPE_TIMEOUT_MS;
        this.resolveApiKey = options.resolveApiKey;
        this.credentialName = options.credentialName;
        // Deferred lookup keeps `globalThis.fetch` patchable in tests.
        this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    }
    /** One v2 scrape call. Throws a `WebError` on every failure path. */
    async scrape(url, signal) {
        if (signal?.aborted === true) {
            throw new WebError('Firecrawl scrape aborted', 'WEB_ABORTED', { cause: signal.reason });
        }
        const apiKey = (await this.resolveApiKey())?.trim();
        if (!apiKey && !isFirecrawlKeylessEndpoint(this.baseURL)) {
            throw new WebError(`scrape credential "${this.credentialName}" is not configured`, 'WEB_PROVIDER_ERROR');
        }
        const deadline = AbortSignal.timeout(this.timeoutMs);
        const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
        let response;
        try {
            response = await this.fetchImpl(this.baseURL, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify(buildFirecrawlScrapeRequest(url, this.timeoutMs)),
                signal: composed,
            });
        }
        catch (error) {
            throw translateTransportFailure(error, signal, deadline, this.timeoutMs);
        }
        let text;
        try {
            text = await response.text();
        }
        catch (error) {
            throw translateTransportFailure(error, signal, deadline, this.timeoutMs);
        }
        if (!response.ok) {
            throw this.errorFromResponse(response, text);
        }
        const doc = readFirecrawlScrapeSuccess(parseJson(text));
        if (doc === undefined) {
            // A `200` `{success:false}` envelope (or an unreadable body): still an
            // upstream failure — classify by its code so a soft quota/rate-limit
            // signal trips the breaker like the corresponding HTTP status would.
            const code = extractFirecrawlErrorCode(text);
            throw new FirecrawlError(`Firecrawl scrape returned HTTP ${response.status} without a scraped document` +
                extractFirecrawlErrorDetail(text), 'WEB_PROVIDER_ERROR', classifyFirecrawlHttpFailure(response.status, code));
        }
        return mapFirecrawlScrapeResult(url, doc);
    }
    /** Non-2xx: keep the upstream `code`/`error` detail in the failure message. */
    errorFromResponse(response, text) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const code = extractFirecrawlErrorCode(text);
        return new FirecrawlError(`Firecrawl scrape failed with HTTP ${response.status}${extractFirecrawlErrorDetail(text)}`, firecrawlWebErrorCode(response.status), classifyFirecrawlHttpFailure(response.status, code, retryAfterMs));
    }
}
/**
 * Classify a transport-level failure into the seam's shared codes: an aborted
 * outer signal is `WEB_ABORTED`; the internal deadline and everything else
 * (DNS/TLS/socket failures) are `WEB_PROVIDER_ERROR`. Transport failures carry
 * no {@link FirecrawlFailure} — there was no upstream response to classify.
 */
export function translateTransportFailure(error, outer, deadline, timeoutMs) {
    if (outer?.aborted === true) {
        return new WebError('Firecrawl scrape aborted', 'WEB_ABORTED', { cause: error });
    }
    if (deadline.aborted) {
        return new WebError(`Firecrawl scrape timed out after ${timeoutMs} ms`, 'WEB_PROVIDER_ERROR', {
            cause: error,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new WebError(`Firecrawl scrape request failed: ${message}`, 'WEB_PROVIDER_ERROR', { cause: error });
}
/** Parse JSON into an `unknown` view; unreadable text yields `undefined`. */
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
