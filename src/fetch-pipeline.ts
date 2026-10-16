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
import type { RuntimeControls } from './request-budget.js';
import type { HttpFetchLimits, HttpFetchResolver } from '@deepseek-ai/dsh-web-fetch-http';
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
} from '@deepseek-ai/dsh-web';
import { AGGREGATED_PROVIDER_ID } from './limits.js';
import type { CircuitBreaker } from './breaker/index.js';
import {
  aggregateDynamicFetch,
  anysearchBreakerSignal,
  classifyFetchRoute,
  firecrawlBreakerSignal,
} from './fetch-aggregate.js';
import type { FetchEngineLeg, FetchPipelineLogger, FetchRouteOptions } from './fetch-aggregate.js';
import { additionalExtractionLegs, type AdditionalEngine } from './engines/additional/index.js';

/** Transport and response limits, matching `dsh-web-fetch-http`'s own plugin defaults. */
export const DEFAULT_HTTP_FETCH_LIMITS: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
};

/**
 * Structural view of the base dynamic-path engine clients (satisfied by the
 * real `FirecrawlClient` / `AnySearchEngine`, and by
 * fakes in tests). Each method resolves a normalized {@link WebFetchResult}.
 */
export interface ExtractionEngineClients {
  readonly firecrawl: { scrape(url: string, signal?: AbortSignal): Promise<WebFetchResult> };
  readonly anysearch: {
    extract(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
  };
}

/**
 * Bind the base dynamic-path engine clients into pipeline legs, attaching
 * each engine's breaker-signal reader. Array order is dispatch order and the
 * tie-break order of 择优: Firecrawl, AnySearch (the engine ids
 * match {@link DEFAULT_ENGINE_WEIGHTS}, so the default weights apply).
 */
export function createExtractionLegs(clients: ExtractionEngineClients): FetchEngineLeg[] {
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

export interface AggregatedFetchProviderOptions {
  resolveControls?: () => RuntimeControls;
  ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>;
  additionalEngines?: readonly AdditionalEngine[];
  /** Partial limit overrides merged over {@link DEFAULT_HTTP_FETCH_LIMITS}. */
  limits?: Partial<HttpFetchLimits>;
  /** Address resolver override; production uses the package's public-address policy. */
  resolveAddresses?: HttpFetchResolver;
  /** Dynamic-path extraction engines, in dispatch order (selection ties go first-wins). */
  legs?: readonly FetchEngineLeg[];
  /** URL-aware routing knobs; defaults route static extensions to HTTP. */
  route?: FetchRouteOptions;
  /** Quota circuit breaker; broken engines are skipped before dispatch. */
  breaker?: CircuitBreaker;
  /** Pipeline log sink (per-engine failures, skips, 择优 and consistency lines). */
  logger?: FetchPipelineLogger;
  /** Dynamic-path per-engine deadline; defaults to the documented 45 s budget. */
  perEngineTimeoutMs?: number;
  /** Engine-weight overrides for 择优; missing entries fall back to defaults. */
  engineWeights?: Partial<Record<string, number>>;
}

export class AggregatedFetchProvider implements WebFetchProvider {
  /** Same id as the search face; the two seam registries are independent. */
  readonly id = AGGREGATED_PROVIDER_ID;
  private readonly http: HttpFetchProvider;
  private readonly options: AggregatedFetchProviderOptions;

  constructor(options: AggregatedFetchProviderOptions = {}) {
    this.options = options;
    this.http = new HttpFetchProvider(
      { ...DEFAULT_HTTP_FETCH_LIMITS, ...options.limits },
      options.resolveAddresses,
    );
  }

  /** The wrapped fetcher needs no credentials; always usable. */
  available(): boolean {
    return this.http.available();
  }

  /**
   * Retrieve one URL. Static routes pass straight through to the safe HTTP
   * fetcher; dynamic routes fan out to the extraction engines. Non-2xx target
   * responses are results (never throws) on both routes.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const controls = resolveRuntimeRequest(this.options.resolveControls?.() ?? {}, 'fetch', request.url);
    return runOperation(controls, 'fetch', signal, composed => this.fetchOperation(request, composed));
  }

  private async fetchOperation(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    const controls = currentControls();
    for (const engine of this.options.additionalEngines ?? []) {
      if (!serviceEnabled(engine.id)) continue;
      if (controls.fetchServices && !controls.fetchServices.includes(engine.id)) continue;
      if (engine.readApi && this.options.ready && !await this.options.ready(engine.id, 'fetch')) continue;
      const result = await engine.readApi?.(request.url, signal);
      if (result !== undefined) return result;
    }
    // A GitHub blob URL denotes a file page, even when its path ends in .md.
    // Honor an eligible URL-specific adapter, retaining explicit HTTP routing.
    const urlEngine = this.options.additionalEngines?.find(engine => engine.supportsUrl?.(request.url)
      && serviceEnabled(engine.id) && (!controls.fetchServices || controls.fetchServices.includes(engine.id))
      && !this.options.breaker?.isBroken(engine.id));
    const useUrlEngine = urlEngine !== undefined
      && classifyFetchRoute(request.url, { ...this.options.route, staticExtensions: [] }) === 'dynamic'
      && (!this.options.ready || await this.options.ready(urlEngine.id, 'fetch'));
    if (!useUrlEngine && classifyFetchRoute(request.url, this.options.route) === 'static') {
      if (!serviceEnabled('http')) throw new WebError('直接 HTTP 抓取已关闭，无法提取此静态 URL；请启用该服务后重试。', 'WEB_PROVIDER_ERROR');
      return this.http.fetch(request, signal);
    }
    return aggregateDynamicFetch({
      settleEarly: controls.preset === 'auto',
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
