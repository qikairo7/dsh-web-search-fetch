/**
 * Aggregated search orchestration — the search pipeline described in DESIGN.md.
 *
 * One query fans out to every engine that is currently in rotation, the
 * per-engine failures are contained, the survivors are deduplicated and fused
 * by Reciprocal Rank Fusion, optionally reranked, and finally truncated to the
 * seam's `maxResults`. This module owns the algorithm and the provider class;
 * `search-pipeline.ts` owns which concrete engine clients get wired in.
 *
 * Three boundaries are deliberate:
 *
 * - The module is generic over engines: it consumes {@link SearchEngineClient}
 *   (an id plus a seam-shaped `search`, optionally the Zhihu-style `quota`), so
 *   an engine can be added without touching the orchestration, and every branch
 *   of the fan-out, fusion, rerank, and truncation logic is unit-testable
 *   against fakes.
 * - Failure classification is read, never parsed. {@link readSearchFailureSignal}
 *   projects each engine's own vocabulary onto the breaker's closed
 *   `rate-limit` / `quota-exhausted` / `insufficient-credits` set, so the
 *   breaker can never be tripped by engine message text.
 * - Cancellation stays distinguishable from engine failure: an aborted outer
 *   signal leaves as `WEB_ABORTED`, while a per-engine timeout degrades one
 *   lane and leaves the rest untouched.
 * @module search-aggregate
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { runOperation, selectServices, currentControls, serviceEnabled, noteOperation, operationNotes, requestCount, deadlineReached, abortable } from './request-budget.js';
import type { RuntimeControls } from './request-budget.js';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import { anySearchFailureSignal } from './engines/anysearch/index.js';
import { readZhihuCircuitSignal } from './engines/zhihu/index.js';
import { AGGREGATED_PROVIDER_ID } from './limits.js';
import type { BreakerReason, BreakerSignal, CircuitBreaker } from './breaker/index.js';

/** Default per-engine deadline (DESIGN.md: single-engine limit of 10 s). */
export const DEFAULT_SEARCH_MAX_FANOUT_MS = 10_000;

/** Default RRF constant `k` (the standard 60). */
export const DEFAULT_RRF_K = 60;

/** Default size of the candidate pool handed to rerank (DESIGN.md: top 20). */
export const DEFAULT_RERANK_POOL = 20;

/** The breaker signals this pipeline is allowed to forward, verbatim. */
const BREAKER_REASONS: readonly BreakerReason[] = ['rate-limit', 'quota-exhausted', 'insufficient-credits'];

/**
 * One engine's quota reading, narrowed to the only field the breaker acts on.
 * A missing reading is not exhaustion; `remaining <= 0` is.
 */
export interface SearchEngineQuota {
  readonly remaining: number;
}

/**
 * What the orchestration needs from an engine. Deliberately smaller than any
 * concrete engine class: an id for the breaker and the logs, a seam-shaped
 * `search`, and — for engines with a queryable daily allowance — `quota`.
 */
export interface SearchEngineClient {
  /** Stable engine id; also the breaker's key. */
  readonly id: string;
  /** Run one search. Failures are contained by the caller. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  /**
   * Today's allowance for this engine, when the engine can report one. The
   * pipeline probes it at most once per local day and never lets a failed probe
   * block a search.
   */
  quota?(signal?: AbortSignal): Promise<SearchEngineQuota | undefined>;
}

/** What the orchestration needs from the rerank engine (a full permutation, or `null` to degrade). */
export interface RerankHandle {
  readonly enabled?: boolean;
  readonly free?: boolean;
  rerank(
    query: string,
    documents: readonly string[],
    topN: number,
    signal?: AbortSignal,
  ): Promise<number[] | null>;
}

/** The log sink the pipeline writes engine latency, failures, and breaker state to. */
export interface SearchLogSink {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** One engine's ranked output, in that engine's own relevance order. */
export interface EngineRanking {
  readonly engineId: string;
  readonly sources: readonly WebSearchSource[];
}

/** One fused candidate: a normalized URL plus its merge result and RRF score. */
export interface FusedCandidate {
  /** Normalized (deduplication) key, and the URL handed back through the seam. */
  readonly url: string;
  /** `Σ 1 / (k + rank)` over the engines that returned this URL. */
  readonly score: number;
  /** Engine ids that returned this URL, in dispatch order. */
  readonly contributors: readonly string[];
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

/** Construction-time dependencies of {@link AggregatedSearchProvider}. */
export interface AggregatedSearchOptions {
  readonly resolveControls?: () => RuntimeControls;
  readonly ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>;
  /** Engines to fan out to, in dispatch order. */
  readonly engines: readonly SearchEngineClient[];
  readonly resolveEngines?: () => readonly SearchEngineClient[];
  /** The shared breaker; consulted before dispatch and fed every forwarded signal. */
  readonly breaker: CircuitBreaker;
  /** Optional rerank stage; omitted means pure RRF. */
  readonly rerank?: RerankHandle;
  /** Where engine outcome and breaker lines go. Defaults to silence. */
  readonly logger?: SearchLogSink;
  /** Per-engine deadline in milliseconds. Default 10 000. */
  readonly maxFanoutMs?: number;
  /** RRF constant `k`. Default 60. */
  readonly rrfK?: number;
  /** Candidates handed to rerank, best-first. Default 20. */
  readonly rerankPool?: number;
  /** Whether to probe engines that expose `quota()` once per local day. Default `true`. */
  readonly zhihuQuotaCheck?: boolean;
  /** Clock override, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A no-op sink, so the pipeline never has to null-check its logger. */
const SILENT_LOG: SearchLogSink = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * The aggregated search provider registered on `ctx.web`.
 *
 * One `search()` call: probe the daily quota of quota-capable engines (at most
 * once per local day) → skip engines the breaker has taken out of rotation →
 * fan out with a per-engine deadline → deduplicate and RRF-fuse the survivors →
 * rerank the top `rerankPool` (degrading to RRF order) → truncate to
 * `maxResults` and report `truncated`.
 */
export class AggregatedSearchProvider implements WebSearchProvider {
  private readonly controls: () => RuntimeControls;
  private readonly ready?: AggregatedSearchOptions['ready'];
  /** Stable id; the fetch face registers the same id on its own registry. */
  readonly id = AGGREGATED_PROVIDER_ID;

  private readonly engines: readonly SearchEngineClient[];
  private readonly resolveEngines: () => readonly SearchEngineClient[];
  private readonly breaker: CircuitBreaker;
  private readonly rerank: RerankHandle | undefined;
  private readonly logger: SearchLogSink;
  private readonly maxFanoutMs: number;
  private readonly rrfK: number;
  private readonly rerankPool: number;
  private readonly quotaCheckEnabled: boolean;
  private readonly now: () => number;
  /** Local-day key of the last quota sweep; `undefined` until the first search. */
  private quotaCheckedDay: string | undefined;

  constructor(options: AggregatedSearchOptions) {
    this.controls = options.resolveControls ?? (() => ({}));
    this.ready = options.ready;
    this.engines = options.engines;
    this.resolveEngines = options.resolveEngines ?? (() => this.engines);
    this.breaker = options.breaker;
    this.rerank = options.rerank;
    this.logger = options.logger ?? SILENT_LOG;
    this.maxFanoutMs = positive(options.maxFanoutMs, DEFAULT_SEARCH_MAX_FANOUT_MS);
    this.rrfK = positive(options.rrfK, DEFAULT_RRF_K);
    this.rerankPool = positive(options.rerankPool, DEFAULT_RERANK_POOL);
    this.quotaCheckEnabled = options.zhihuQuotaCheck ?? true;
    this.now = options.now ?? Date.now;
  }

  /**
   * Cheap local usability check. Credential presence is decided per call
   * (resolved, never cached), so it cannot be answered here without I/O.
   */
  available(): boolean {
    return true;
  }

  /** Run one aggregated search. */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return runOperation(this.controls(), 'search', signal, composed => this.searchOperation(request, composed));
  }

  private async searchOperation(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult> {
    if (isAborted(signal)) throw abortedError(signal);
    const allEngines = this.resolveEngines();
    const broken = allEngines.filter(engine => this.breaker.isBroken(engine.id));
    for (const engine of broken) this.logger.warn(`[搜索] 服务 ${engine.id} 已熔断，跳过本次派发`);
    const engines = await selectServices(allEngines.filter(engine => !this.breaker.isBroken(engine.id)), engine => engine.id, 'search', this.ready);
    await this.sweepDailyQuota(engines, signal);
    if (isAborted(signal)) throw abortedError(signal);

    const outcomes = await Promise.all(
      engines.map((engine) => this.dispatch(engine, request, signal)),
    );
    if (isAborted(signal) && !deadlineReached()) throw abortedError(signal);

    const rankings = outcomes.flatMap((outcome) =>
      outcome.kind === 'ok' ? [{ engineId: outcome.engineId, sources: outcome.result.sources }] : [],
    );
    if (rankings.length === 0) {
      if (deadlineReached()) throw new WebError('search deadline exceeded', 'WEB_SEARCH_TIMEOUT');
      throw allEnginesFailedError([...outcomes, ...broken.map(engine => ({ kind: 'skipped' as const, engineId: engine.id }))]);
    }

    const fused = rrfFuse(rankings, this.rrfK);
    const pool = fused.slice(0, this.rerankPool);
    const reranked = await this.applyRerank(request, pool, signal);
    // Candidates past the rerank pool keep their RRF order behind the reranked
    // ones, so a `maxResults` larger than the pool is still satisfiable instead
    // of silently shorting the caller.
    const ordered = [...reranked, ...fused.slice(pool.length)];

    const maxResults = request.maxResults;
    const selected = maxResults === undefined ? ordered : ordered.slice(0, Math.max(0, maxResults));
    const notes = operationNotes();
    this.logger.info(`[搜索] ${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。`);
    return {
      ...(notes.length ? { content: `搜索处理说明：${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。` } : {}),
      sources: selected.map(toSeamSource),
      truncated: deadlineReached() || outcomes.some(outcome => outcome.kind === 'ok' && outcome.result.truncated)
        || (maxResults !== undefined && ordered.length > maxResults),
    };
  }

  /**
   * Probe the daily allowance of every quota-capable engine, at most once per
   * local day (DESIGN.md: 知乎额度日检). The day is marked as swept before the
   * probes run, so one failed probe cannot make the pipeline retry all day; a
   * probe failure is logged and ignored, never blocking a search.
   */
  private async sweepDailyQuota(engines: readonly SearchEngineClient[], signal?: AbortSignal): Promise<void> {
    if (!this.quotaCheckEnabled || !engines.some(engine => engine.quota !== undefined)) return;
    const day = localDayKey(this.now());
    if (this.quotaCheckedDay === day) return;
    this.quotaCheckedDay = day;

    for (const engine of engines) {
      if (engine.quota === undefined) continue;
      try {
        const quota = await engine.quota(signal);
        if (quota !== undefined && quota.remaining <= 0) {
          this.breaker.recordSignal(engine.id, { kind: 'quota-exhausted' });
          this.logger.warn(`[搜索] 引擎 ${engine.id} 当日额度已耗尽（remaining ${quota.remaining}），本次起停用`);
        }
      } catch (error) {
        this.logger.warn(`[搜索] 引擎 ${engine.id} 额度查询失败，忽略并继续：${describeError(error)}`);
      }
    }
  }

  /**
   * Run one lane: skip a broken engine, otherwise race the engine against the
   * per-engine deadline. Always resolves to an outcome — containment is the
   * point, so a throwing engine cannot take the fan-out down with it.
   *
   * The deadline is enforced here rather than left to each engine's own
   * transport budget: when it fires, the lane's signal is aborted, so a hung
   * request is actually torn down instead of being left running after its
   * result was already discarded.
   */
  private async dispatch(
    engine: SearchEngineClient,
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<EngineOutcome> {
    const engineId = engine.id;
    if (this.breaker.isBroken(engineId)) {
      this.logger.warn(`[搜索] 引擎 ${engineId} 已熔断，跳过本次派发`);
      return { kind: 'skipped', engineId };
    }

    const startedAt = Date.now();
    const lane = new AbortController();
    const composed = signal === undefined ? lane.signal : AbortSignal.any([signal, lane.signal]);
    const timer = setTimeout(() => {
      lane.abort(new Error(`per-engine deadline of ${this.maxFanoutMs} ms exceeded`));
    }, this.maxFanoutMs);

    // The engine promise is raced against the lane's signal: an engine that
    // honours `signal` settles by rejecting, and one that ignores it is still
    // dropped at the deadline (or on a caller abort) instead of stalling the
    // whole fan-out.
    const laneAborted = new Promise<typeof LANE_ABORTED>((resolve) => {
      if (composed.aborted) {
        resolve(LANE_ABORTED);
        return;
      }
      composed.addEventListener('abort', () => resolve(LANE_ABORTED), { once: true });
    });
    const settled: Promise<EngineOutcome> = engine.search(request, composed).then(
      (result): EngineOutcome => ({
        kind: 'ok',
        engineId,
        result,
        elapsedMs: Date.now() - startedAt,
      }),
      (error: unknown): EngineOutcome => ({
        kind: 'failed',
        engineId,
        error,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    // The race may abandon `settled`; keep its eventual rejection observed.
    settled.catch(() => undefined);

    let outcome: EngineOutcome | typeof LANE_ABORTED;
    try {
      outcome = await Promise.race([settled, laneAborted]);
    } finally {
      clearTimeout(timer);
    }

    // Our own deadline outranks whatever the engine reported while being torn
    // down: the lane did not finish inside its budget, so it is a timeout. A
    // simultaneous caller abort still wins — that is cancellation, and `search`
    // reports it once, as `WEB_ABORTED`, without a lane-fault log line.
    if (outcome === LANE_ABORTED) {
      const elapsedMs = Date.now() - startedAt;
      if (isAborted(signal)) return { kind: 'failed', engineId, error: signal?.reason, elapsedMs };
      this.logger.warn(
        `[搜索] 引擎 ${engineId} 超时：延迟 ${elapsedMs}ms（上限 ${this.maxFanoutMs}ms），已丢弃该路`,
      );
      return { kind: 'timeout', engineId, elapsedMs };
    }
    if (outcome.kind === 'ok') {
      this.logger.info(
        `[搜索] 引擎 ${engineId} 成功：延迟 ${outcome.elapsedMs}ms，命中 ${outcome.result.sources.length} 条`,
      );
      return outcome;
    }
    if (outcome.kind === 'failed') {
      // A caller abort is cancellation, not an engine failure: it is reported
      // once, by search(), and must not be logged as a lane fault.
      if (!isAborted(signal)) {
        this.logger.warn(
          `[搜索] 引擎 ${engineId} 失败：延迟 ${outcome.elapsedMs}ms，原因 ${describeError(outcome.error)}`,
        );
        const breakerSignal = readSearchFailureSignal(outcome.error);
        if (breakerSignal !== undefined) this.breaker.recordSignal(engineId, breakerSignal);
      }
    }
    return outcome;
  }

  /**
   * Rerank the candidate pool, keeping RRF order on every degrade path. The
   * only failure that propagates is the caller's own cancellation: a rerank
   * miss must never turn into "no search results" (DESIGN.md).
   */
  private async applyRerank(
    request: WebSearchRequest,
    pool: readonly FusedCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly FusedCandidate[]> {
    if (this.rerank === undefined || !serviceEnabled('siliconflow', this.rerank.enabled ?? true) || pool.length === 0 || deadlineReached()) return pool;
    if (currentControls().preset === 'free' && !this.rerank.free) { noteOperation('免费预设未调用自定义重排端点。'); return pool; }
    const documents = pool.map(candidateDocument);
    const topN = request.maxResults ?? pool.length;

    let order: number[] | null;
    try {
      order = await abortable(this.rerank.rerank(request.query, documents, topN, signal), signal);
    } catch (error) {
      if (deadlineReached()) return pool;
      if (isAborted(signal) || (error instanceof WebError && error.code === 'WEB_ABORTED')) {
        throw error;
      }
      this.logger.warn(`[搜索] 重排异常，降级回纯 RRF 序：${describeError(error)}`);
      return pool;
    }

    if (order === null) {
      this.logger.warn('[搜索] 重排降级回纯 RRF 序：重排引擎不可用或超时');
      return pool;
    }

    const seen = new Set<number>();
    const ordered: FusedCandidate[] = [];
    for (const index of order) {
      if (!Number.isInteger(index) || index < 0 || index >= pool.length) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      ordered.push(pool[index]!);
    }
    // A permutation may be partial; the candidates it skipped keep RRF order.
    for (let index = 0; index < pool.length; index += 1) {
      if (!seen.has(index)) ordered.push(pool[index]!);
    }
    return ordered;
  }
}

/** A per-lane result that never throws; the caller decides what a lane's failure means. */
type EngineOutcome =
  | { readonly kind: 'ok'; readonly engineId: string; readonly result: WebSearchResult; readonly elapsedMs: number }
  | { readonly kind: 'failed'; readonly engineId: string; readonly error: unknown; readonly elapsedMs: number }
  | { readonly kind: 'timeout'; readonly engineId: string; readonly elapsedMs: number }
  | { readonly kind: 'skipped'; readonly engineId: string };

/** Sentinel the lane's abort listener resolves to, so it cannot be confused with a result. */
const LANE_ABORTED = Symbol('search-lane-aborted');

// ---------------------------------------------------------------------------
// URL normalization and RRF fusion
// ---------------------------------------------------------------------------

/**
 * Normalize a result URL into its deduplication key (DESIGN.md): every `utm_*`
 * parameter is dropped, the `#fragment` is dropped, scheme and hostname are
 * lowercased (which `URL` already does), and a root path is normalized so `/`
 * and `''` share one key. Every other query parameter is kept, in place, and
 * participates in equality; a non-root trailing slash is also kept, because
 * `/path/` and `/path` are different resources.
 *
 * A URL that does not parse is returned verbatim: deduplication may then miss a
 * merge, but the source is never dropped or rewritten into something the engine
 * did not return.
 */
export function normalizeSearchUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hash = '';
  const kept: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase().startsWith('utm_')) continue;
    kept.push([key, value]);
  }
  parsed.search = '';
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  return parsed.toString();
}

/**
 * Reciprocal Rank Fusion over the engines' ranked outputs.
 *
 * `score(d) = Σ_engines 1 / (k + rank(d))`, with `rank` one-based within each
 * engine and every engine counting at most once per key (a repeated key inside
 * one engine's list is counted once, at its best rank). Ties break on first
 * appearance, so the output is deterministic for a given input.
 *
 * Identical keys merge into one candidate. The merge is field-wise and keeps
 * the richest value per field: a longer snippet wins, an already-present title
 * or `publishedAt` wins, and a missing field is filled from whichever copy has
 * it.
 */
export function rrfFuse(rankings: readonly EngineRanking[], k: number): FusedCandidate[] {
  const merged = new Map<string, { candidate: FusedCandidate; sequence: number }>();
  let sequence = 0;

  for (const ranking of rankings) {
    const seenInEngine = new Set<string>();
    let rank = 0;
    for (const source of ranking.sources) {
      const key = normalizeSearchUrl(source.url);
      if (seenInEngine.has(key)) continue;
      seenInEngine.add(key);
      rank += 1;
      const contribution = 1 / (k + rank);

      const existing = merged.get(key);
      if (existing === undefined) {
        const candidate: FusedCandidate = {
          url: key,
          score: contribution,
          contributors: [ranking.engineId],
          ...optionalFields(source),
        };
        merged.set(key, { candidate, sequence: sequence++ });
        continue;
      }
      const current = existing.candidate;
      merged.set(key, {
        sequence: existing.sequence,
        candidate: {
          url: current.url,
          score: current.score + contribution,
          contributors: current.contributors.includes(ranking.engineId)
            ? current.contributors
            : [...current.contributors, ranking.engineId],
          ...mergeFields(current, source),
        },
      });
    }
  }

  return [...merged.values()]
    .sort((left, right) => right.candidate.score - left.candidate.score || left.sequence - right.sequence)
    .map((entry) => entry.candidate);
}

/** The optional source fields, omitting the ones the engine did not return. */
function optionalFields(source: WebSearchSource): Partial<WebSearchSource> {
  return {
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
    ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  };
}

/**
 * Merge one later copy of the same key into the candidate already held: the
 * longer snippet wins, and any field the candidate still lacks is filled in.
 */
function mergeFields(current: FusedCandidate, incoming: WebSearchSource): Partial<WebSearchSource> {
  const title = pickText(current.title, incoming.title, (left, right) => left);
  const snippet = pickText(current.snippet, incoming.snippet, longer);
  const publishedAt = pickText(current.publishedAt, incoming.publishedAt, (left) => left);
  return {
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

/** Pick the better of two optional strings with `choose`, or the one that exists. */
function pickText(
  current: string | undefined,
  incoming: string | undefined,
  choose: (left: string, right: string) => string,
): string | undefined {
  if (current === undefined) return incoming;
  if (incoming === undefined) return current;
  return choose(current, incoming);
}

/** Whichever string is longer (ties keep the current one). */
function longer(left: string, right: string): string {
  return right.length > left.length ? right : left;
}

/** The rerank document for one candidate: `title + snippet`, falling back to the URL. */
function candidateDocument(candidate: FusedCandidate): string {
  const parts = [candidate.title, candidate.snippet].filter(
    (part): part is string => part !== undefined && part.trim().length > 0,
  );
  return parts.length === 0 ? candidate.url : parts.join(' ');
}

/** Project a fused candidate onto the seam's source shape, inventing nothing. */
function toSeamSource(candidate: FusedCandidate): WebSearchSource {
  return {
    url: candidate.url,
    ...(candidate.title === undefined ? {} : { title: candidate.title }),
    ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
    ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Project a caught engine failure onto the breaker's closed signal set, or
 * `undefined` when the failure is not a breaker event.
 *
 * Two sources are read, never parsed: the error itself, when it is one of the
 * engines' classified errors (`AnySearchClientError`, `ZhihuWebError`), and its
 * `cause`, which is where the Zhipu engine hangs its 429 signal. Only the three
 * documented reasons pass through, spelled exactly as the breaker defines them;
 * every other engine classification (auth, invalid request, transport, …) is
 * deliberately not a breaker event.
 */
export function readSearchFailureSignal(error: unknown): BreakerSignal | undefined {
  return breakerSignalOf(error) ?? breakerSignalOf(causeOf(error));
}

/** Read one value as a breaker signal, without unwrapping anything. */
function breakerSignalOf(value: unknown): BreakerSignal | undefined {
  const anysearch = anySearchFailureSignal(value);
  if (anysearch !== undefined) return fromReason(anysearch.kind, anysearch.retryAfterMs);

  const zhihu = readZhihuCircuitSignal(value);
  if (zhihu !== undefined) return fromReason(zhihu.kind, undefined);

  // The plain-object spelling: the Zhipu 429 signal (`{kind:'rate-limit',
  // retryAfterMs?}`) and any engine adopting the same closed vocabulary.
  if (value !== null && typeof value === 'object') {
    const record = value as { kind?: unknown; retryAfterMs?: unknown };
    return fromReason(record.kind, record.retryAfterMs);
  }
  return undefined;
}

/** Keep only the reasons the breaker defines; carry a Retry-After hint when valid. */
function fromReason(kind: unknown, retryAfterMs: unknown): BreakerSignal | undefined {
  if (typeof kind !== 'string') return undefined;
  if (!BREAKER_REASONS.includes(kind as BreakerReason)) return undefined;
  const reason = kind as BreakerReason;
  if (reason !== 'rate-limit') return { kind: reason };
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    ? { kind: reason, retryAfterMs }
    : { kind: reason };
}

/** The `cause` of a caught error, when it carries one. */
function causeOf(error: unknown): unknown {
  return error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** An `AbortSignal`'s own cancellation, labelled with the seam's abort code. */
function abortedError(signal: AbortSignal | undefined): WebError {
  return new WebError('Aggregated web search aborted', 'WEB_ABORTED', { cause: signal?.reason });
}

/** Whether a caller-supplied signal has already fired. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** The failure raised when no engine produced a usable ranking at all. */
function allEnginesFailedError(outcomes: readonly EngineOutcome[]): WebError {
  const summary = outcomes.map(describeOutcome).join('; ');
  return new WebError(
    outcomes.length === 0
      ? 'Aggregated web search failed: no engine is configured'
      : `Aggregated web search failed on every engine: ${summary}`,
    'WEB_PROVIDER_ERROR',
  );
}

/** One lane's outcome as a bounded, credential-free summary fragment. */
function describeOutcome(outcome: EngineOutcome): string {
  switch (outcome.kind) {
    case 'skipped':
      return `${outcome.engineId} (已熔断，跳过)`;
    case 'timeout':
      return `${outcome.engineId} (超时 ${outcome.elapsedMs}ms)`;
    case 'failed':
      return `${outcome.engineId} (${describeError(outcome.error)})`;
    default:
      return `${outcome.engineId} (ok)`;
  }
}

/** A bounded, credential-free description of a caught value. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_LOG_REASON_CHARS ? message : `${message.slice(0, MAX_LOG_REASON_CHARS)}…`;
}

/** Ceiling on upstream-controlled text retained in one log line. */
const MAX_LOG_REASON_CHARS = 200;

/** A finite positive override, or the default. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The host-local calendar day of `nowMs`, used to make the quota sweep daily. */
function localDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
