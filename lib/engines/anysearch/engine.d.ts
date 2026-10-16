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
import type { WebFetchRequest, WebFetchResult, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import { type AnySearchClientOptions } from './client.js';
import { type AnySearchFailureSignal } from './error.js';
/**
 * Options for {@link AnySearchEngine}. Identical to the client's, minus the
 * resolver's required-ness: with no resolver the engine is unconfigured and
 * reports that per call rather than failing at construction.
 */
export interface AnySearchEngineOptions extends Omit<AnySearchClientOptions, 'resolveApiKey'> {
    /** Resolve the credential per operation; omit for a permanently unconfigured engine. */
    resolveApiKey?: () => Promise<string | undefined>;
}
/**
 * Search and extract through AnySearch. Every failure leaves as a `WebError`
 * (so the seam's error taxonomy stays intact for `dsh-tool-web`), while the
 * structured breaker signal — `kind: 'rate-limit' | 'quota-exhausted' | …` —
 * rides along on `cause` and is reachable via {@link failureSignalOf}.
 */
export declare class AnySearchEngine {
    private readonly client;
    constructor(options?: AnySearchEngineOptions);
    /** Cheap local usability check; never makes a network call. */
    available(): boolean;
    /**
     * Run one search. `maxResults` is forwarded as `max_results` so the upstream
     * applies the bound too; the seam still owns the final truncation, and
     * `truncated` is `false` here because this engine never cuts the list.
     */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    /**
     * Extract one URL. A successful extract normalizes to status 200 with a
     * `text` body: the API returns already-cleaned content, and labelling it
     * `text` stops the harness from converting an HTML document twice.
     */
    extract(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}
/**
 * Translate an engine failure into the seam's `WebError`. An extract failure
 * keeps its specific `WEB_*` code (the reference's six mappings, plus
 * cancellation); everything else is `WEB_PROVIDER_ERROR`, with `WEB_ABORTED`
 * for a caller abort. The original classified error is preserved as `cause`.
 */
export declare function toWebError(error: unknown, operation: 'search' | 'extract'): WebError;
/**
 * Read the circuit-breaker signal off a caught value. Accepts either the
 * engine's own error or the `WebError` the engine wrapped it in, so a pipeline
 * that catches seam errors can still see `rate-limit` / `quota-exhausted`
 * without unwrapping by hand.
 */
export declare function failureSignalOf(error: unknown): AnySearchFailureSignal | undefined;
