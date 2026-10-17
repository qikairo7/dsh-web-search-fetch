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
 *   (an id plus a seam-shaped `search`, optionally `quota`), so
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
import { runOperation, selectServices, currentControls, currentDecisionDepth, serviceEnabled, noteOperation, operationNotes, requestCount, deadlineReached, abortable, resolveRuntimeRequest } from './request-budget.js';
import { SettlementWindow } from './settlement-window.js';
import { officialHosts, isOfficial, topicMatches, preferOfficial, contentVariantKey } from './search-quality.js';
import { anySearchFailureSignal } from './engines/anysearch/index.js';
import { AGGREGATED_PROVIDER_ID } from './limits.js';
/** Default per-engine deadline (DESIGN.md: single-engine limit of 10 s). */
export const DEFAULT_SEARCH_MAX_FANOUT_MS = 10_000;
/** Default RRF constant `k` (the standard 60). */
export const DEFAULT_RRF_K = 60;
/** Default size of the candidate pool handed to rerank (DESIGN.md: top 20). */
export const DEFAULT_RERANK_POOL = 20;
/** The breaker signals this pipeline is allowed to forward, verbatim. */
const BREAKER_REASONS = ['rate-limit', 'quota-exhausted', 'insufficient-credits'];
/** A no-op sink, so the pipeline never has to null-check its logger. */
const SILENT_LOG = { info: () => undefined, warn: () => undefined, error: () => undefined };
/**
 * The aggregated search provider registered on `ctx.web`.
 *
 * One `search()` call: probe the daily quota of quota-capable engines (at most
 * once per local day) → skip engines the breaker has taken out of rotation →
 * fan out with a per-engine deadline → deduplicate and RRF-fuse the survivors →
 * rerank the top `rerankPool` (degrading to RRF order) → truncate to
 * `maxResults` and report `truncated`.
 */
export class AggregatedSearchProvider {
    controls;
    ready;
    /** Stable id; the fetch face registers the same id on its own registry. */
    id = AGGREGATED_PROVIDER_ID;
    engines;
    resolveEngines;
    breaker;
    rerank;
    logger;
    maxFanoutMs;
    rrfK;
    rerankPool;
    quotaCheckEnabled;
    now;
    /** Local-day key of the last quota sweep; `undefined` until the first search. */
    quotaCheckedDay;
    constructor(options) {
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
        this.quotaCheckEnabled = options.quotaCheck ?? true;
        this.now = options.now ?? Date.now;
    }
    /**
     * Cheap local usability check. Credential presence is decided per call
     * (resolved, never cached), so it cannot be answered here without I/O.
     */
    available() {
        return true;
    }
    /** Run one aggregated search. */
    async search(request, signal) {
        const controls = resolveRuntimeRequest(this.controls(), 'search', request.query);
        return runOperation(controls, 'search', signal, composed => this.searchOperation(request, composed));
    }
    async searchOperation(request, signal) {
        if (isAborted(signal))
            throw abortedError(signal);
        const allEngines = this.resolveEngines();
        const broken = allEngines.filter(engine => this.breaker.isBroken(engine.id));
        for (const engine of broken)
            this.logger.warn(`[搜索] 服务 ${engine.id} 已熔断，跳过本次派发`);
        const engines = await selectServices(allEngines.filter(engine => !this.breaker.isBroken(engine.id)), engine => engine.id, 'search', this.ready);
        await this.sweepDailyQuota(engines, signal);
        if (isAborted(signal))
            throw abortedError(signal);
        const hosts = officialHosts(request.query);
        const supplementary = /\bsite:/i.test(request.query) ? [] : hosts.flatMap(host => {
            const priority = ['tavily', 'anysearch', 'exa', 'firecrawl', 'bing'];
            const rank = (id) => priority.includes(id) ? priority.indexOf(id) : priority.length;
            const preferred = [...engines].sort((a, b) => rank(a.id) - rank(b.id));
            return preferred.slice(0, hosts.length > 1 ? 1 : 2).map(engine => ({ engine, query: `${request.query} site:${host}` }));
        });
        if (supplementary.length)
            noteOperation(`增加 ${supplementary.length} 次限定官方域名的补充检索，仍受请求预算约束。`);
        const window = new SettlementWindow(signal, currentDecisionDepth() === 'deep');
        const completed = [];
        const accept = (outcome) => {
            completed.push(outcome);
            const successes = completed.filter((item) => item.kind === 'ok');
            const candidates = rrfFuse(successes.map(item => ({ engineId: item.engineId, sources: item.result.sources })), this.rrfK);
            const enough = new Set(successes.filter(item => item.result.sources.length).map(item => item.engineId)).size >= 3
                && candidates.filter(item => topicMatches(request.query, item)).length >= (request.maxResults ?? 8)
                && (!hosts.length || candidates.some(item => isOfficial(item.url, hosts) && topicMatches(request.query, item)));
            window.observe(currentControls().preset === 'auto' && enough);
            return outcome;
        };
        let outcomes;
        try {
            outcomes = await Promise.all([
                ...engines.map(engine => this.dispatch(engine, request, window.signal).then(accept)),
                ...supplementary.map(({ engine, query }) => this.dispatch(engine, { ...request, query }, window.signal).then(accept)),
            ]);
        }
        finally {
            window.finish();
        }
        if (window.endedEarly)
            noteOperation('已有多路相关结果，宽限等待结束后提前取消未完成渠道；可能仍有未返回内容。');
        if (isAborted(signal) && !deadlineReached())
            throw abortedError(signal);
        const rankings = outcomes.flatMap((outcome) => outcome.kind === 'ok' ? [{ engineId: outcome.engineId, sources: outcome.result.sources }] : []);
        if (rankings.length === 0) {
            if (deadlineReached())
                throw new WebError('search deadline exceeded', 'WEB_SEARCH_TIMEOUT');
            throw allEnginesFailedError([...outcomes, ...broken.map(engine => ({ kind: 'skipped', engineId: engine.id }))]);
        }
        const perService = new Map();
        for (const ranking of rankings)
            perService.set(ranking.engineId, [...(perService.get(ranking.engineId) ?? []), ...ranking.sources]);
        const fused = preferOfficial(request.query, rrfFuse([...perService].map(([engineId, sources]) => ({ engineId, sources })), this.rrfK));
        const pool = fused.slice(0, this.rerankPool);
        const reranked = await this.applyRerank(request, pool, signal);
        // Candidates past the rerank pool keep their RRF order behind the reranked
        // ones, so a `maxResults` larger than the pool is still satisfiable instead
        // of silently shorting the caller.
        const ordered = preferOfficial(request.query, [...reranked, ...fused.slice(pool.length)]);
        const maxResults = request.maxResults;
        const selected = maxResults === undefined ? ordered : ordered.slice(0, Math.max(0, maxResults));
        const notes = operationNotes();
        this.logger.info(`[搜索] ${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。`);
        return {
            ...(notes.length ? { content: `搜索处理说明：${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。` } : {}),
            sources: selected.map(toSeamSource),
            truncated: window.endedEarly || deadlineReached() || outcomes.some(outcome => outcome.kind === 'ok' && outcome.result.truncated)
                || (maxResults !== undefined && ordered.length > maxResults),
        };
    }
    /**
     * Probe the daily allowance of every quota-capable engine, at most once per
     * local day. The day is marked as swept before the
     * probes run, so one failed probe cannot make the pipeline retry all day; a
     * probe failure is logged and ignored, never blocking a search.
     */
    async sweepDailyQuota(engines, signal) {
        if (!this.quotaCheckEnabled || !engines.some(engine => engine.quota !== undefined))
            return;
        const day = localDayKey(this.now());
        if (this.quotaCheckedDay === day)
            return;
        this.quotaCheckedDay = day;
        for (const engine of engines) {
            if (engine.quota === undefined)
                continue;
            try {
                const quota = await engine.quota(signal);
                if (quota !== undefined && quota.remaining <= 0) {
                    this.breaker.recordSignal(engine.id, { kind: 'quota-exhausted' });
                    this.logger.warn(`[搜索] 引擎 ${engine.id} 当日额度已耗尽（remaining ${quota.remaining}），本次起停用`);
                }
            }
            catch (error) {
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
    async dispatch(engine, request, signal) {
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
        const laneAborted = new Promise((resolve) => {
            if (composed.aborted) {
                resolve(LANE_ABORTED);
                return;
            }
            composed.addEventListener('abort', () => resolve(LANE_ABORTED), { once: true });
        });
        const settled = engine.search(request, composed).then((result) => ({
            kind: 'ok',
            engineId,
            result,
            elapsedMs: Date.now() - startedAt,
        }), (error) => ({
            kind: 'failed',
            engineId,
            error,
            elapsedMs: Date.now() - startedAt,
        }));
        // The race may abandon `settled`; keep its eventual rejection observed.
        settled.catch(() => undefined);
        let outcome;
        try {
            outcome = await Promise.race([settled, laneAborted]);
        }
        finally {
            clearTimeout(timer);
        }
        // Our own deadline outranks whatever the engine reported while being torn
        // down: the lane did not finish inside its budget, so it is a timeout. A
        // simultaneous caller abort still wins — that is cancellation, and `search`
        // reports it once, as `WEB_ABORTED`, without a lane-fault log line.
        if (outcome === LANE_ABORTED) {
            const elapsedMs = Date.now() - startedAt;
            if (isAborted(signal))
                return { kind: 'failed', engineId, error: signal?.reason, elapsedMs };
            this.logger.warn(`[搜索] 引擎 ${engineId} 超时：延迟 ${elapsedMs}ms（上限 ${this.maxFanoutMs}ms），已丢弃该路`);
            return { kind: 'timeout', engineId, elapsedMs };
        }
        if (outcome.kind === 'ok') {
            this.logger.info(`[搜索] 引擎 ${engineId} 成功：延迟 ${outcome.elapsedMs}ms，命中 ${outcome.result.sources.length} 条`);
            return outcome;
        }
        if (outcome.kind === 'failed') {
            // A caller abort is cancellation, not an engine failure: it is reported
            // once, by search(), and must not be logged as a lane fault.
            if (!isAborted(signal)) {
                this.logger.warn(`[搜索] 引擎 ${engineId} 失败：延迟 ${outcome.elapsedMs}ms，原因 ${describeError(outcome.error)}`);
                const breakerSignal = readSearchFailureSignal(outcome.error);
                if (breakerSignal !== undefined)
                    this.breaker.recordSignal(engineId, breakerSignal);
            }
        }
        return outcome;
    }
    /**
     * Rerank the candidate pool, keeping RRF order on every degrade path. The
     * only failure that propagates is the caller's own cancellation: a rerank
     * miss must never turn into "no search results" (DESIGN.md).
     */
    async applyRerank(request, pool, signal) {
        if (this.rerank === undefined || !serviceEnabled('siliconflow', this.rerank.enabled ?? true) || pool.length === 0 || deadlineReached())
            return pool;
        if (currentControls().preset === 'free' && !this.rerank.free) {
            noteOperation('免费预设未调用自定义重排端点。');
            return pool;
        }
        const documents = pool.map(candidateDocument);
        const topN = request.maxResults ?? pool.length;
        let order;
        try {
            order = await abortable(this.rerank.rerank(request.query, documents, topN, signal), signal);
        }
        catch (error) {
            if (deadlineReached())
                return pool;
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
        const seen = new Set();
        const ordered = [];
        for (const index of order) {
            if (!Number.isInteger(index) || index < 0 || index >= pool.length)
                continue;
            if (seen.has(index))
                continue;
            seen.add(index);
            ordered.push(pool[index]);
        }
        // A permutation may be partial; the candidates it skipped keep RRF order.
        for (let index = 0; index < pool.length; index += 1) {
            if (!seen.has(index))
                ordered.push(pool[index]);
        }
        return ordered;
    }
}
/** Sentinel the lane's abort listener resolves to, so it cannot be confused with a result. */
const LANE_ABORTED = Symbol('search-lane-aborted');
// ---------------------------------------------------------------------------
// URL normalization and RRF fusion
// ---------------------------------------------------------------------------
/**
 * Normalize a result URL into its deduplication key (DESIGN.md): every `utm_*`
 * parameter is dropped, the `#fragment` is dropped, scheme and hostname are
 * lowercased (which `URL` already does), and a root path is normalized so `/`
 * and `''` share one key. Other parameters and non-root trailing slashes stay
 * significant except for the verified MDN and TypeScript aliases below.
 *
 * A URL that does not parse is returned verbatim: deduplication may then miss a
 * merge, but the source is never dropped or rewritten into something the engine
 * did not return.
 */
export function normalizeSearchUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url;
    }
    parsed.hash = '';
    if (parsed.hostname === 'developer.mozilla.org' && parsed.protocol === 'http:')
        parsed.protocol = 'https:';
    if (parsed.hostname === 'www.typescriptlang.org' && parsed.pathname.startsWith('/docs/handbook/') && parsed.pathname.endsWith('.html')) {
        parsed.pathname = parsed.pathname.slice(0, -5);
    }
    const kept = [];
    for (const [key, value] of parsed.searchParams) {
        if (key.toLowerCase().startsWith('utm_'))
            continue;
        if (parsed.hostname === 'developer.mozilla.org' && key === 'retiredLocale')
            continue;
        if (parsed.hostname === 'developer.mozilla.org' && key === 'source' && value.startsWith('post_page'))
            continue;
        kept.push([key, value]);
    }
    parsed.search = '';
    for (const [key, value] of kept)
        parsed.searchParams.append(key, value);
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
export function rrfFuse(rankings, k) {
    const merged = new Map();
    const variants = new Map();
    let sequence = 0;
    for (const ranking of rankings) {
        const seenInEngine = new Set();
        let rank = 0;
        for (const source of ranking.sources) {
            const normalized = normalizeSearchUrl(source.url);
            const identity = contentVariantKey(normalized, source.title, source.snippet);
            const key = variants.get(identity) ?? normalized;
            variants.set(identity, key);
            if (seenInEngine.has(key))
                continue;
            seenInEngine.add(key);
            rank += 1;
            const contribution = 1 / (k + rank);
            const existing = merged.get(key);
            if (existing === undefined) {
                const candidate = {
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
function optionalFields(source) {
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
function mergeFields(current, incoming) {
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
function pickText(current, incoming, choose) {
    if (current === undefined)
        return incoming;
    if (incoming === undefined)
        return current;
    return choose(current, incoming);
}
/** Whichever string is longer (ties keep the current one). */
function longer(left, right) {
    return right.length > left.length ? right : left;
}
/** The rerank document for one candidate: `title + snippet`, falling back to the URL. */
function candidateDocument(candidate) {
    const parts = [candidate.title, candidate.snippet].filter((part) => part !== undefined && part.trim().length > 0);
    return parts.length === 0 ? candidate.url : parts.join(' ');
}
/** Project a fused candidate onto the seam's source shape, inventing nothing. */
function toSeamSource(candidate) {
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
 * engines' classified errors (`AnySearchClientError`), and its
 * `cause`, which is where the Zhipu engine hangs its 429 signal. Only the three
 * documented reasons pass through, spelled exactly as the breaker defines them;
 * every other engine classification (auth, invalid request, transport, …) is
 * deliberately not a breaker event.
 */
export function readSearchFailureSignal(error) {
    return breakerSignalOf(error) ?? breakerSignalOf(causeOf(error));
}
/** Read one value as a breaker signal, without unwrapping anything. */
function breakerSignalOf(value) {
    const anysearch = anySearchFailureSignal(value);
    if (anysearch !== undefined)
        return fromReason(anysearch.kind, anysearch.retryAfterMs);
    // The plain-object spelling: the Zhipu 429 signal (`{kind:'rate-limit',
    // retryAfterMs?}`) and any engine adopting the same closed vocabulary.
    if (value !== null && typeof value === 'object') {
        const record = value;
        return fromReason(record.kind, record.retryAfterMs);
    }
    return undefined;
}
/** Keep only the reasons the breaker defines; carry a Retry-After hint when valid. */
function fromReason(kind, retryAfterMs) {
    if (typeof kind !== 'string')
        return undefined;
    if (!BREAKER_REASONS.includes(kind))
        return undefined;
    const reason = kind;
    if (reason !== 'rate-limit')
        return { kind: reason };
    return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
        ? { kind: reason, retryAfterMs }
        : { kind: reason };
}
/** The `cause` of a caught error, when it carries one. */
function causeOf(error) {
    return error instanceof Error ? error.cause : undefined;
}
// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------
/** An `AbortSignal`'s own cancellation, labelled with the seam's abort code. */
function abortedError(signal) {
    return new WebError('Aggregated web search aborted', 'WEB_ABORTED', { cause: signal?.reason });
}
/** Whether a caller-supplied signal has already fired. */
function isAborted(signal) {
    return signal !== undefined && signal.aborted;
}
/** The failure raised when no engine produced a usable ranking at all. */
function allEnginesFailedError(outcomes) {
    const summary = outcomes.map(describeOutcome).join('; ');
    return new WebError(outcomes.length === 0
        ? 'Aggregated web search failed: no engine is configured'
        : `Aggregated web search failed on every engine: ${summary}`, 'WEB_PROVIDER_ERROR');
}
/** One lane's outcome as a bounded, credential-free summary fragment. */
function describeOutcome(outcome) {
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
function describeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= MAX_LOG_REASON_CHARS ? message : `${message.slice(0, MAX_LOG_REASON_CHARS)}…`;
}
/** Ceiling on upstream-controlled text retained in one log line. */
const MAX_LOG_REASON_CHARS = 200;
/** A finite positive override, or the default. */
function positive(value, fallback) {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** The host-local calendar day of `nowMs`, used to make the quota sweep daily. */
function localDayKey(nowMs) {
    const date = new Date(nowMs);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
