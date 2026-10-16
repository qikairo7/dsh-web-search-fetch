/**
 * The aggregated fetch provider — the single fetch face registered with
 * `ctx.web`. Skeleton scope (#1) was a direct pass-through to the built-in
 * safe HTTP fetcher; issue #9 (#9 提取编排管线) lands DESIGN.md's URL-aware
 * conditional orchestration behind this same id:
 *
 * - URL judged **static** (known static extension or a configured static
 *   domain profile) → single pass-through HTTP fetch, zero paid-engine calls.
 * - Everything else (PDF, unknown/missing extensions, anti-bot suspicion) →
 *   {@link aggregateDynamicFetch}: Firecrawl, AnySearch and configured HTTP
 *   extractors run concurrently, with breaker-gated dispatch, per-engine deadlines,
 *   quality-based 择优, and consistency signals in the log.
 *
 * Reuse note: the package's export is a clean class (`HttpFetchProvider`)
 * whose `id` is hard-coded to `http`, so the aggregated face wraps it by
 * composition instead of inheriting a mismatched identity. Composition also
 * keeps the limits, the address resolver, and the extraction engine legs
 * injectable for tests.
 * @module fetch-pipeline
 */
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';
import { runOperation, currentControls, serviceEnabled, selectServices, resolveRuntimeRequest } from './request-budget.js';
import { WebError } from '@deepseek-ai/dsh-web';
import { AGGREGATED_PROVIDER_ID } from './limits.js';
import { aggregateDynamicFetch, anysearchBreakerSignal, classifyFetchRoute, firecrawlBreakerSignal, } from './fetch-aggregate.js';
import { additionalExtractionLegs } from './engines/additional/index.js';
/** Transport and response limits, matching `dsh-web-fetch-http`'s own plugin defaults. */
export const DEFAULT_HTTP_FETCH_LIMITS = {
    maxResponseBytes: 5_000_000,
    maxBodyChars: 100_000,
    timeoutMs: 30_000,
    maxRedirects: 5,
    userAgent: DEFAULT_USER_AGENT,
};
/**
 * Bind the base dynamic-path engine clients into pipeline legs, attaching
 * each engine's breaker-signal reader. Array order is dispatch order and the
 * tie-break order of 择优: Firecrawl, AnySearch (the engine ids
 * match {@link DEFAULT_ENGINE_WEIGHTS}, so the default weights apply).
 */
export function createExtractionLegs(clients) {
    return [
        {
            engineId: 'firecrawl',
            extract: (url, signal) => clients.firecrawl.scrape(url, signal),
            signalOf: firecrawlBreakerSignal,
        },
        {
            engineId: 'anysearch',
            extract: (url, signal) => clients.anysearch.extract({ url }, signal),
            signalOf: anysearchBreakerSignal,
        },
    ];
}
export class AggregatedFetchProvider {
    /** Same id as the search face; the two seam registries are independent. */
    id = AGGREGATED_PROVIDER_ID;
    http;
    options;
    constructor(options = {}) {
        this.options = options;
        this.http = new HttpFetchProvider({ ...DEFAULT_HTTP_FETCH_LIMITS, ...options.limits }, options.resolveAddresses);
    }
    /** The wrapped fetcher needs no credentials; always usable. */
    available() {
        return this.http.available();
    }
    /**
     * Retrieve one URL. Static routes pass straight through to the safe HTTP
     * fetcher; dynamic routes fan out to the extraction engines. Non-2xx target
     * responses are results (never throws) on both routes.
     */
    async fetch(request, signal) {
        const controls = resolveRuntimeRequest(this.options.resolveControls?.() ?? {}, 'fetch', request.url);
        return runOperation(controls, 'fetch', signal, composed => this.fetchOperation(request, composed));
    }
    async fetchOperation(request, signal) {
        const controls = currentControls();
        for (const engine of this.options.additionalEngines ?? []) {
            if (!serviceEnabled(engine.id))
                continue;
            if (controls.fetchServices && !controls.fetchServices.includes(engine.id))
                continue;
            if (engine.readApi && this.options.ready && !await this.options.ready(engine.id, 'fetch'))
                continue;
            const result = await engine.readApi?.(request.url, signal);
            if (result !== undefined)
                return result;
        }
        if (classifyFetchRoute(request.url, this.options.route) === 'static') {
            if (!serviceEnabled('http'))
                throw new WebError('直接 HTTP 抓取已关闭，无法提取此静态 URL；请启用该服务后重试。', 'WEB_PROVIDER_ERROR');
            return this.http.fetch(request, signal);
        }
        return aggregateDynamicFetch({
            url: request.url,
            legs: await selectServices([...(this.options.legs ?? []), ...additionalExtractionLegs(this.options.additionalEngines ?? [], request.url)]
                .filter(leg => !this.options.breaker?.isBroken(leg.engineId)), leg => leg.engineId, 'fetch', this.options.ready),
            mode: controls.mode ?? 'organize',
            maxOutputChars: controls.maxOutputChars ?? 100_000,
            ...(signal === undefined ? {} : { signal }),
            ...(this.options.breaker === undefined ? {} : { breaker: this.options.breaker }),
            ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
            ...(this.options.perEngineTimeoutMs === undefined
                ? {}
                : { perEngineTimeoutMs: this.options.perEngineTimeoutMs }),
            ...(this.options.engineWeights === undefined
                ? {}
                : { engineWeights: this.options.engineWeights }),
        });
    }
}
