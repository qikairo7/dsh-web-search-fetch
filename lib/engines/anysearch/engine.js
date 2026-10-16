/**
 * The AnySearch engine's two faces: search and extract. One client, two
 * mappings — the shape the aggregation pipelines (#8, #9) consume.
 *
 * This module owns no registration: it is deliberately importable without
 * touching `src/index.ts` or `cordis.patch.yml`, so landing it cannot collide
 * with the other engine branches. A pipeline constructs one
 * {@link AnySearchEngine} and calls `search()` / `extract()`.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97 (src/provider.ts,
 * src/fetch-provider.ts), MIT. Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch/engine
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { AnySearchClient } from './client.js';
import { AnySearchClientError, anySearchFailureSignal, mapExtractErrorCodeToWebErrorCode, } from './error.js';
import { mapExtractResponse, mapSearchResponse } from './wire.js';
/**
 * Search and extract through AnySearch. Every failure leaves as a `WebError`
 * (so the seam's error taxonomy stays intact for `dsh-tool-web`), while the
 * structured breaker signal — `kind: 'rate-limit' | 'quota-exhausted' | …` —
 * rides along on `cause` and is reachable via {@link failureSignalOf}.
 */
export class AnySearchEngine {
    client;
    constructor(options = {}) {
        this.client = new AnySearchClient({
            ...options,
            resolveApiKey: options.resolveApiKey ?? (async () => undefined),
        });
    }
    /** Cheap local usability check; never makes a network call. */
    available() {
        return this.client.available();
    }
    /**
     * Run one search. `maxResults` is forwarded as `max_results` so the upstream
     * applies the bound too; the seam still owns the final truncation, and
     * `truncated` is `false` here because this engine never cuts the list.
     */
    async search(request, signal) {
        try {
            const payload = await this.client.search({
                query: request.query,
                ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
            }, signal);
            return mapSearchResponse(payload);
        }
        catch (error) {
            throw toWebError(error, 'search');
        }
    }
    /**
     * Extract one URL. A successful extract normalizes to status 200 with a
     * `text` body: the API returns already-cleaned content, and labelling it
     * `text` stops the harness from converting an HTML document twice.
     */
    async extract(request, signal) {
        try {
            return mapExtractResponse(await this.client.extract({ url: request.url }, signal));
        }
        catch (error) {
            throw toWebError(error, 'extract');
        }
    }
}
/**
 * Translate an engine failure into the seam's `WebError`. An extract failure
 * keeps its specific `WEB_*` code (the reference's six mappings, plus
 * cancellation); everything else is `WEB_PROVIDER_ERROR`, with `WEB_ABORTED`
 * for a caller abort. The original classified error is preserved as `cause`.
 */
export function toWebError(error, operation) {
    if (error instanceof WebError)
        return error;
    if (error instanceof AnySearchClientError) {
        return new WebError(error.message, webErrorCodeFor(error, operation), { cause: error });
    }
    return new WebError(error instanceof Error ? error.message : `AnySearch ${operation} failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
}
/**
 * Read the circuit-breaker signal off a caught value. Accepts either the
 * engine's own error or the `WebError` the engine wrapped it in, so a pipeline
 * that catches seam errors can still see `rate-limit` / `quota-exhausted`
 * without unwrapping by hand.
 */
export function failureSignalOf(error) {
    const direct = anySearchFailureSignal(error);
    if (direct !== undefined)
        return direct;
    const cause = error instanceof WebError || error instanceof Error ? error.cause : undefined;
    return anySearchFailureSignal(cause);
}
/** Pick the seam code for one classified engine failure. */
function webErrorCodeFor(error, operation) {
    if (error.kind === 'aborted')
        return 'WEB_ABORTED';
    if (operation !== 'extract')
        return 'WEB_PROVIDER_ERROR';
    // The Extract-specific six, plus `extract_canceled` → WEB_ABORTED, exactly
    // as the reference maps them.
    return mapExtractErrorCodeToWebErrorCode(error.errorCode);
}
