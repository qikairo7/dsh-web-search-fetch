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
import { budgetedFetch, currentControls, serviceEnabled, selectServices, resolveRuntimeRequest, runOperation, noteOperation, deadlineReached } from './request-budget.js';
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
  isUsableCandidate,
  probeVerdict,
} from './fetch-aggregate.js';
import type { FetchCandidate, FetchEngineLeg, FetchPipelineLogger, FetchRouteOptions } from './fetch-aggregate.js';
import { additionalExtractionLegs, type AdditionalEngine } from './engines/additional/index.js';
import { blockedTargetError, guardTargetAddress, type AddressLookup } from './address-guard.js';
import { DEFAULT_MAX_OUTPUT_CHARS } from './fetch-document/organize.js';

/** Transport and response limits, matching `dsh-web-fetch-http`'s own plugin defaults. */
export const DEFAULT_HTTP_FETCH_LIMITS: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
};

/** Deadline of the automatic preset's first-path probe; defaults to the documented 15 s. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

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
  /**
   * Whether a proven private/loopback destination is refused before any engine
   * or adapter sees the URL. Default `true`; `fetch.staticDomains` hosts are
   * exempt because the built-in HTTP fetcher enforces its own policy for them.
   */
  blockPrivateAddresses?: boolean;
  /** DNS resolver override for the address guard; defaults to the system resolver. */
  lookup?: AddressLookup;
  /** Deadline of the automatic preset's first-path probe; defaults to 15 s. */
  probeTimeoutMs?: number;
  /**
   * Whether the `single` preset may fall back to the multi-path organization
   * when its one channel fails or returns a thin body. Default `false`: an
   * explicit single-channel request is answered by exactly one channel.
   */
  singleChannelEscalate?: boolean;
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
    // Address guard first: a private destination must not reach AIHOT path
    // matching, a URL-specific adapter, or any third-party engine. The static
    // HTTP fetcher runs its own public-address policy, so a configured static
    // domain (or the guard switch itself) is the documented exemption.
    if (this.options.blockPrivateAddresses !== false) {
      const verdict = await guardTargetAddress(request.url, {
        exemptHosts: this.options.route?.staticDomains ?? [],
        ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
        signal,
      });
      if (!verdict.allowed) {
        this.options.logger?.warn(
          `[提取] 拒绝把本机或内网目标外发给提取服务：${request.url}${verdict.address === undefined ? '' : `（${verdict.address}）`}`,
        );
        throw blockedTargetError(request.url, verdict.address);
      }
    }
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
    const route = classifyFetchRoute(request.url, this.options.route);
    if (!useUrlEngine && route === 'static') {
      if (!serviceEnabled('http')) throw new WebError('直接 HTTP 抓取已关闭，无法提取此静态 URL；请启用该服务后重试。', 'WEB_PROVIDER_ERROR');
      return this.http.fetch(request, signal);
    }
    // Two-stage fetch: the automatic preset in organize mode spends one request
    // on the recommended single channel and serves that原文 when it already
    // answers the question; only a thin, blocked or off-target probe escalates.
    // A URL-specific adapter owns its own representation, so it is never probed.
    if (!useUrlEngine && (controls.mode ?? 'organize') === 'organize' && controls.preset === 'single') {
      return await this.singleChannelFetch(request, signal);
    }
    if (!useUrlEngine && controls.preset === 'auto' && (controls.mode ?? 'organize') === 'organize') {
      const probe = await this.probeFirst(request, signal);
      if (probe === undefined) return await this.escalate(request, signal);
      if (probe.result !== undefined) return probe.result;
      // The probe already spent one request on this channel; hand its result to
      // the organization instead of asking the same engine twice.
      return await this.escalate(request, signal, probe.seeds, probe.skip);
    }
    return await this.escalate(request, signal);
  }

  /**
   * Resolve the probe's first-path channel: the highest-priority eligible
   * extraction leg, after the same selection (priority, enablement, credential
   * presence) the fan-out uses. `undefined` when nothing is eligible.
   */
  private async probeChannel(requestUrl: string): Promise<{ id: string; extract: (url: string, signal: AbortSignal) => Promise<WebFetchResult> } | undefined> {
    const leg = await this.firstEligibleLeg(requestUrl);
    return leg === undefined ? undefined : { id: leg.engineId, extract: (url, signal) => leg.extract(url, signal) };
  }

  /** The highest-priority eligible extraction leg, using the fan-out's selection. */
  private async firstEligibleLeg(requestUrl: string) {
    const legs = await selectServices(
      [...(this.options.legs ?? []), ...additionalExtractionLegs(this.options.additionalEngines ?? [], requestUrl)]
        .filter(leg => !this.options.breaker?.isBroken(leg.engineId)),
      leg => leg.engineId,
      'fetch',
      this.options.ready,
    );
    return legs[0];
  }

  /**
   * The `single` preset: one channel, served as the page's own text.
   *
   * Unlike the automatic probe, this is the user's explicit choice of breadth,
   * so a thin or off-target body is still returned as-is — the caller asked for
   * exactly one source and gets exactly one request. Two situations are
   * exceptions: a channel error, which propagates unless
   * `singleChannelEscalate` opts into the fan-out, and a cancelled operation,
   * which always propagates.
   */
  private async singleChannelFetch(request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    const channel = await this.probeChannel(request.url);
    if (channel === undefined) throw new WebError('没有可用的提取通道：单通道预设未派发任何请求', 'WEB_PROVIDER_ERROR');
    const timeoutMs = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    const composed = AbortSignal.any([signal, deadline]);
    let result: WebFetchResult;
    try {
      result = await channel.extract(request.url, composed);
    } catch (error) {
      if (signal.aborted) throw error;
      if (this.options.singleChannelEscalate !== true) throw error;
      this.options.logger?.info(`[提取] 单通道 ${channel.id} 失败，按配置转入多路整理`);
      noteOperation(`单通道 ${channel.id} 失败，已按 singleChannelEscalate 转入多路整理。`);
      return await this.escalate(request, signal, [], [channel.id]);
    }
    const verdict = probeVerdict(request.url, result);
    if (!verdict.sufficient && this.options.singleChannelEscalate === true) {
      this.options.logger?.info(`[提取] 单通道 ${channel.id} 正文不足（${verdict.reason ?? 'unknown'}），按配置转入多路整理`);
      noteOperation(`单通道正文不足（${verdict.reason ?? 'unknown'}），已按 singleChannelEscalate 转入多路整理。`);
      const seeds = isUsableCandidate(result) ? [{ engineId: channel.id, result }] : [];
      return await this.escalate(request, signal, seeds, [channel.id]);
    }
    this.options.logger?.info(
      `[提取] 单通道 ${channel.id} 返回原文（状态 ${result.statusCode}，${result.body.content.length} 字符），未加溯源标记`,
    );
    noteOperation(`单通道 ${channel.id} 直接返回原文，未派发其他提取服务。`);
    return result;
  }

  /** The multi-path organization, shared by every escalating preset. */
  private async escalate(request: WebFetchRequest, signal: AbortSignal, seeds: readonly FetchCandidate[] = [], skipEngineIds: readonly string[] = []): Promise<WebFetchResult> {
    const controls = currentControls();
    const escalating = seeds.length > 0 || skipEngineIds.length > 0;
    return await aggregateDynamicFetch({
      settleEarly: controls.preset === 'auto',
      url: request.url,
      legs: await this.selectLegs(request.url, escalating),
      mode: controls.mode ?? 'organize',
      maxOutputChars: controls.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      ...(seeds.length === 0 ? {} : { seeds }),
      ...(skipEngineIds.length === 0 ? {} : { skipEngineIds }),
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

  /**
   * Select the fan-out legs (priority, enablement, credential presence,
   * breaker). `escalating` lifts the `single` preset's one-channel cap, since
   * an escalation is a deliberate move to the multi-path organization.
   */
  private async selectLegs(requestUrl: string, escalating = false): Promise<FetchEngineLeg[]> {
    const controls = currentControls();
    const legs = [...(this.options.legs ?? []), ...additionalExtractionLegs(this.options.additionalEngines ?? [], requestUrl)]
      .filter(leg => !this.options.breaker?.isBroken(leg.engineId));
    const limit = controls.maxFetchServices ?? 11;
    const cap = escalating && controls.preset === 'single' ? limit : undefined;
    return cap === undefined
      ? await selectServices(legs, leg => leg.engineId, 'fetch', this.options.ready)
      : await selectServices(legs, leg => leg.engineId, 'fetch', this.options.ready, cap);
  }

  /**
   * Run the first-path probe: one request, no fan-out.
   *
   * Returns `undefined` when nothing is eligible to probe; otherwise a result
   * that is either ready to serve (`sufficient`) or a description of what the
   * escalation may reuse (`seeds` plus the engines it must not re-request).
   * A probe that throws or times out yields no seeds, so the fan-out covers
   * every channel.
   */
  private async probeFirst(
    request: WebFetchRequest,
    signal: AbortSignal,
  ): Promise<{ result?: WebFetchResult; seeds: FetchCandidate[]; skip: string[] } | undefined> {
    const channel = await this.probeChannel(request.url);
    if (channel === undefined) return undefined;
    const timeoutMs = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    const composed = AbortSignal.any([signal, deadline]);
    let result: WebFetchResult;
    try {
      result = await channel.extract(request.url, composed);
    } catch (error) {
      if (signal.aborted) throw error;
      this.options.logger?.info(`[提取] 首路探测 ${channel.id} 未返回可用于单通道的正文，转入多路整理`);
      noteOperation(`首路探测 ${channel.id} 失败，已转入多路整理。`);
      return { seeds: [], skip: [channel.id] };
    }
    if (deadlineReached()) return { seeds: [], skip: [channel.id] };
    const verdict = probeVerdict(request.url, result);
    if (!verdict.sufficient) {
      this.options.logger?.info(`[提取] 首路探测 ${channel.id} 不足（${verdict.reason ?? 'unknown'}），转入多路整理`);
      noteOperation(`首路探测不足（${verdict.reason ?? 'unknown'}），已转入多路整理。`);
      return { seeds: isUsableCandidate(result) ? [{ engineId: channel.id, result }] : [], skip: [channel.id] };
    }
    this.options.logger?.info(
      `[提取] 首路探测 ${channel.id} 已取得完整正文（状态 ${result.statusCode}，${result.body.content.length} 字符），直接返回原文`,
    );
    noteOperation(`首路 ${channel.id} 已取得完整正文，未派发其他提取服务。`);
    return { result, seeds: [], skip: [] };
  }
}
