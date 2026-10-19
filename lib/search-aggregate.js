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
import { runOperation, selectServices, currentControls, currentDecisionDepth, serviceEnabled, noteOperation, operationNotes, requestCount, remainingRequests, deadlineReached, abortable, resolveRuntimeRequest, multiChannelPreset, singleChannelSearch } from './request-budget.js';
import { SettlementWindow } from './settlement-window.js';
import { officialHosts, isOfficial, topicMatches, topicTerms, queryTerms, preferOfficial, contentVariantKey } from './search-quality.js';
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
        // The `single` preset asks for exactly one channel: no official-domain
        // supplementary searches, no rerank. Both are deliberate additions that
        // exist to improve covering breadth, which is precisely what was declined.
        const singleChannel = currentControls().preset === 'single';
        const supplementary = singleChannel || /\bsite:/i.test(request.query) ? [] : hosts.flatMap(host => {
            const priority = ['tavily', 'anysearch', 'exa', 'firecrawl', 'bing'];
            const rank = (id) => priority.includes(id) ? priority.indexOf(id) : priority.length;
            const preferred = [...engines].sort((a, b) => rank(a.id) - rank(b.id));
            return preferred.slice(0, hosts.length > 1 ? 1 : 2).map(engine => ({ engine, query: `${request.query} site:${host}` }));
        });
        if (supplementary.length)
            noteOperation(`增加 ${supplementary.length} 次限定官方域名的补充检索，仍受请求预算约束。`);
        const completed = [];
        const window = new SettlementWindow(signal, currentDecisionDepth() === 'deep');
        let outcomes = await this.dispatchRound([...engines.map(engine => ({ engine, query: request.query })), ...supplementary], window, request, this.laneAcceptor(request, window, completed));
        let endedEarly = window.endedEarly;
        if (endedEarly)
            noteOperation('已有多路相关结果，宽限等待结束后提前取消未完成渠道；可能仍有未返回内容。');
        if (isAborted(signal) && !deadlineReached())
            throw abortedError(signal);
        let rankings = successfulRankings(outcomes);
        if (rankings.length === 0) {
            if (deadlineReached())
                throw new WebError('search deadline exceeded', 'WEB_SEARCH_TIMEOUT');
            throw allEnginesFailedError([...outcomes, ...broken.map(engine => ({ kind: 'skipped', engineId: engine.id }))]);
        }
        // Relevance filter: fusion only ranks, it never judges whether a candidate
        // has anything to do with the query. When the query carries at least two
        // usable terms, a candidate that matches none of them is not an answer —
        // returning it as a source is worse than returning nothing.
        let relevant = this.relevantCandidates(request.query, rankings);
        if (relevant.length === 0) {
            // Issue #20 phase 2: the single-channel path may widen exactly once. One
            // lane is the whole coverage, so "no relevant result" cannot be told apart
            // from "this one channel happened not to know". The escalated lanes join
            // the same fusion, relevance filter and note below; a lane that failed,
            // timed out, was cancelled or was rate-limited does not widen the run (it
            // already spent its share of the budget), and a second escalation never
            // happens.
            const escalation = await this.escalateEmptySearch(request, outcomes, signal);
            if (escalation !== undefined) {
                outcomes = [...outcomes, ...escalation.outcomes];
                endedEarly = endedEarly || escalation.endedEarly;
                rankings = successfulRankings(outcomes);
                relevant = this.relevantCandidates(request.query, rankings);
            }
        }
        // Truncation belongs to the operation, not to the branch that returns it:
        // the empty-result path must report exactly what the normal path would, or
        // "the query has no answer" and "this run was cut short" become
        // indistinguishable (DESIGN.md: a cancelled lane is marked `truncated`).
        // Evaluated at the point of return, so a deadline that expires during
        // rerank is still reported.
        const truncatedNow = (orderedCount) => endedEarly || deadlineReached()
            || outcomes.some(outcome => outcome.kind === 'ok' && outcome.result.truncated)
            || (orderedCount !== undefined && request.maxResults !== undefined && orderedCount > request.maxResults);
        if (relevant.length === 0) {
            // Two zero-result shapes end here: every lane answered with no sources,
            // or candidates existed and the relevance filter dropped all of them. The
            // note names each lane and its end state so "the query has no answer" is
            // distinguishable from "the coverage was short". A lane that failed sits
            // beside a successful one here and is reported with its structured state;
            // when no lane succeeds at all the operation raises WEB_PROVIDER_ERROR
            // above instead, so a total failure never becomes an empty result.
            // The operation's own notes still ride along: the total-deadline note is
            // the only place a caller learns that unfinished lanes were cancelled.
            const note = emptyResultNote(laneReports(outcomes, deadlineReached() ? signal.reason : undefined));
            const notes = operationNotes();
            const content = notes.length === 0
                ? `${note}本插件 HTTP 请求 ${requestCount()} 次。`
                : `${note}搜索处理说明：${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。`;
            this.logger.info(`[搜索] ${content}`);
            return { sources: [], content, truncated: truncatedNow() };
        }
        const pool = relevant.slice(0, this.rerankPool);
        const reranked = singleChannel ? pool : await this.applyRerank(request, pool, signal);
        // Candidates past the rerank pool keep their RRF order behind the reranked
        // ones, so a `maxResults` larger than the pool is still satisfiable instead
        // of silently shorting the caller.
        const ordered = preferOfficial(request.query, [...reranked, ...relevant.slice(pool.length)]);
        const maxResults = request.maxResults;
        const selected = maxResults === undefined ? ordered : ordered.slice(0, Math.max(0, maxResults));
        const notes = operationNotes();
        this.logger.info(`[搜索] ${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。`);
        return {
            ...(notes.length ? { content: `搜索处理说明：${notes.join(' ')} 本插件 HTTP 请求 ${requestCount()} 次。` } : {}),
            sources: selected.map(toSeamSource),
            truncated: truncatedNow(ordered.length),
        };
    }
    /**
     * Dispatch one round of lanes under a settlement window, collecting every
     * lane's end state so the zero-result note can name all of them.
     * @param lanes - engine plus the query that lane should run.
     * @param window - the round's settlement window; closed here.
     * @param request - the caller's request; each lane gets it with its own query.
     * @param accept - records each settled lane and feeds the settlement window.
     */
    async dispatchRound(lanes, window, request, accept) {
        try {
            return await Promise.all(lanes.map(({ engine, query }) => this.dispatch(engine, { ...request, query }, window.signal).then(accept)));
        }
        finally {
            window.finish();
        }
    }
    /**
     * Fuse and relevance-filter the successful lanes' rankings.
     * @param query - the caller's query.
     * @param rankings - successful lanes' outputs, in dispatch order.
     * @returns the candidates worth returning, best first.
     */
    relevantCandidates(query, rankings) {
        const perService = new Map();
        for (const ranking of rankings)
            perService.set(ranking.engineId, [...(perService.get(ranking.engineId) ?? []), ...ranking.sources]);
        const fused = preferOfficial(query, rrfFuse([...perService].map(([engineId, sources]) => ({ engineId, sources })), this.rrfK));
        return relevantOnly(query, fused);
    }
    /**
     * Issue #20 phase 2: widen a single-channel run exactly once when its only
     * lane answered successfully but produced nothing usable.
     *
     * Only the single-channel breadth escalates — the explicit `single` preset
     * (mirroring the fetch side's `singleChannelEscalate` precedent) and the
     * automatic preset's own single-channel decision. A multi-channel preset
     * already spread the query; widening it would change the breadth the user
     * asked for. A lane that failed, timed out, was cancelled or hit a rate
     * limit never escalates: it already consumed its share of the budget and
     * the remaining channels are likely under the same limit. The escalation
     * itself respects the preset's service list, enablement, credential
     * presence, service cap and the operation's remaining request budget, and
     * it is a single step: no second escalation follows it.
     * @param request - the caller's request.
     * @param outcomes - the first round's lanes, in dispatch order.
     * @param signal - the operation signal.
     * @returns the escalated round's outcomes and window state, or `undefined`
     *   when this run must not (or cannot) escalate.
     */
    async escalateEmptySearch(request, outcomes, signal) {
        const controls = currentControls();
        if (!singleChannelSearch(controls))
            return undefined;
        // Only a lane that answered successfully widens the run. A lane that
        // failed, timed out, was cancelled or was rate-limited already consumed its
        // share of the budget, and the remaining channels are likely under the same
        // limit; one failed lane among the same channel's queries blocks it too.
        if (outcomes.some(outcome => outcome.kind !== 'ok'))
            return undefined;
        const services = new Set(outcomes.map(outcome => outcome.engineId));
        if (services.size !== 1)
            return undefined;
        if (deadlineReached() || isAborted(signal))
            return undefined;
        const candidates = this.resolveEngines().filter(engine => !services.has(engine.id) && !this.breaker.isBroken(engine.id));
        if (candidates.length === 0) {
            noteOperation('单通道空结果；没有可补派的其他通道。');
            return undefined;
        }
        const remaining = remainingRequests();
        if (remaining <= 0) {
            noteOperation('单通道空结果；请求预算已用尽，未补派其他通道。');
            return undefined;
        }
        // One lane needs at least one request, so the remaining budget bounds how
        // many lanes can be afforded even before the service cap applies.
        const limit = Math.min(controls.maxSearchServices ?? 13, remaining);
        // The escalation states its own selection below; the generic selection and
        // cap lines would repeat the first round's wording (Issue #23).
        const selected = await selectServices(candidates, engine => engine.id, 'search', this.ready, limit, false);
        if (selected.length === 0) {
            noteOperation('单通道空结果；没有可补派的其他通道。');
            return undefined;
        }
        const engineId = [...services][0];
        const laneCount = outcomes.length;
        this.logger.info(`[搜索] 单通道 ${engineId} 无相关结果，补派 ${selected.length} 路搜索`);
        noteOperation(laneCount === 1
            ? `单路 ${engineId} 空结果，补派选择 ${selected.length} 路搜索。`
            : `单通道 ${engineId} 的 ${laneCount} 次检索均无相关结果，补派选择 ${selected.length} 路搜索。`);
        const window = new SettlementWindow(signal, currentDecisionDepth() === 'deep');
        const completed = [];
        const accept = this.laneAcceptor(request, window, completed);
        const escalated = await this.dispatchRound(selected.map(engine => ({ engine, query: request.query })), window, request, accept);
        if (window.endedEarly)
            noteOperation('补派的多路已取得相关结果，宽限等待结束后提前取消未完成渠道；可能仍有未返回内容。');
        return { outcomes: escalated, endedEarly: window.endedEarly };
    }
    /** Build the per-lane recorder that also feeds the settlement window. */
    laneAcceptor(request, window, completed) {
        const hosts = officialHosts(request.query);
        return (outcome) => {
            completed.push(outcome);
            const successes = completed.filter((item) => item.kind === 'ok');
            const candidates = rrfFuse(successes.map(item => ({ engineId: item.engineId, sources: item.result.sources })), this.rrfK);
            const enough = new Set(successes.filter(item => item.result.sources.length).map(item => item.engineId)).size >= 3
                && candidates.filter(item => topicMatches(request.query, item)).length >= (request.maxResults ?? 8)
                && (!hosts.length || candidates.some(item => isOfficial(item.url, hosts) && topicMatches(request.query, item)));
            window.observe(multiChannelPreset() && enough);
            return outcome;
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
            const identity = contentVariantKey(normalized, source.title);
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
/** The query's usable terms, from the shared vocabulary in {@link topicMatches}. */
function usableQueryTerms(query) {
    return queryTerms(query);
}
/**
 * The segments of a single hyphen/underscore/dot-joined query token.
 *
 * A query that is one token on the wire may still be several words: search
 * engines index `deepseek-harness-guide` as those three words. Splitting it is
 * what lets a one-token query be judged by term intersection at all. Fragments
 * shorter than two characters (`-v-`, `-4-`) carry no topic and are dropped.
 * @param term - one usable query term, already lower-cased.
 * @returns the segments, in query order; one element means "not compound".
 */
function tokenSegments(term) {
    const parts = term.split(/[-_+.]+/).filter(part => part.length >= 2);
    return parts.length >= 2 ? parts : [term];
}
/**
 * Whether a candidate shares a strict majority of a compound token's segments.
 *
 * A majority (not "any one") is what separates a real hyphenated query from a
 * random string of words: `covid-19-vaccine-efficacy` still matches a page
 * that carries three of its four segments, while a nonsense token — where at
 * best one generic fragment like `token` appears anywhere — does not.
 */
function compoundTokenMatches(segments, candidate) {
    const text = `${candidate.title ?? ''} ${candidate.snippet ?? ''} ${candidate.url}`.toLowerCase();
    const matched = segments.filter(segment => text.includes(segment)).length;
    return matched >= Math.floor(segments.length / 2) + 1;
}
/**
 * Drop fused candidates the query has nothing to do with.
 *
 * Two shapes are judged. A query with at least two topic terms is judged by
 * {@link topicMatches}. A one-term query is normally left alone — a single word
 * (`上海天气`) is too thin to judge without over-filtering — but a *compound*
 * token is not one word: it splits into segments, and a candidate sharing only
 * a generic fragment of it (`9931`, `token`) is not an answer. That case is
 * judged by segment majority, which is how `zxqvj-9931-plorptastic-nonsense-token`
 * stops returning eight unrelated pages while `deepseek-harness-guide` still
 * matches its own documentation.
 *
 * Recency qualifiers (`最近`, `最新`) are dropped before the count, so a
 * Chinese query that leads with one is judged on its subject alone; a
 * remaining single subject still has to match, which is what keeps
 * `最近的 AI 芯片新闻` relevant without letting a weather page through.
 * @param query - the caller's query.
 * @param candidates - fused candidates, best first.
 * @returns the candidates worth returning, order preserved.
 */
function relevantOnly(query, candidates) {
    const terms = topicTerms(usableQueryTerms(query));
    if (terms.length >= 2)
        return candidates.filter(candidate => topicMatches(query, candidate));
    if (terms.length === 1) {
        const segments = tokenSegments(terms[0]);
        if (segments.length >= 2)
            return candidates.filter(candidate => compoundTokenMatches(segments, candidate));
        if (usableQueryTerms(query).length >= 2)
            return candidates.filter(candidate => topicMatches(query, candidate));
    }
    return [...candidates];
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
 * `cause`, where an engine may hang a structured signal. Only the three
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
    // The plain-object spelling (`{kind:'rate-limit', retryAfterMs?}`) shared by
    // engines using the closed vocabulary.
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
/** The successful lanes' rankings, in dispatch order. */
function successfulRankings(outcomes) {
    return outcomes.flatMap((outcome) => outcome.kind === 'ok' ? [{ engineId: outcome.engineId, sources: outcome.result.sources }] : []);
}
/**
 * Project the lanes this operation dispatched onto the note's vocabulary.
 *
 * An engine the breaker had already taken out was never dispatched — with no
 * successful lane at all the operation raises `WEB_PROVIDER_ERROR` above — so
 * it is not part of this note; listing it would pad the single-channel note
 * with channels the preset never used.
 * @param outcomes - every lane that took part, in dispatch order.
 * @param deadlineReason - the operation signal's abort reason once its total
 *   deadline fired; a lane torn down by it is reported as cancelled, not as a
 *   request failure.
 */
function laneReports(outcomes, deadlineReason) {
    const reports = new Map();
    for (const outcome of outcomes) {
        const report = {
            engineId: outcome.engineId,
            state: laneState(outcome, deadlineReason),
            returned: outcome.kind === 'ok' ? outcome.result.sources.length : 0,
        };
        const key = `${report.engineId}\u0000${report.state}`;
        const existing = reports.get(key);
        // One engine may be dispatched twice (a supplementary `site:` lane); the
        // note names it once per distinct state, keeping the larger count.
        reports.set(key, existing === undefined
            ? report
            : { ...existing, returned: Math.max(existing.returned, report.returned) });
    }
    return [...reports.values()];
}
/** One outcome's state: the lane's own kind, or the failure's structured kind. */
function laneState(outcome, deadlineReason) {
    switch (outcome.kind) {
        case 'ok': return 'empty';
        case 'timeout': return 'timeout';
        case 'skipped': return 'skipped';
        case 'failed':
            // `dispatch` labels a lane torn down by the operation signal with that
            // signal's own reason, so identity separates it from a lane that failed
            // on its own a moment before the deadline.
            return deadlineReason !== undefined && outcome.error === deadlineReason
                ? 'cancelled'
                : failureState(outcome.error);
    }
}
/**
 * Classify a lane failure from structured fields only — the engine's own
 * classification (`AnySearchClientError.kind`) or a plain `{ kind }` signal on
 * the error or its `cause`. Message text is never read: it is untrusted.
 */
function failureState(error) {
    const kind = structuredFailureKind(error) ?? structuredFailureKind(causeOf(error));
    switch (kind) {
        case 'rate-limit': return 'rate-limit';
        case 'quota-exhausted': return 'quota-exhausted';
        case 'insufficient-credits': return 'insufficient-credits';
        case 'timeout': return 'timeout';
        default: return 'failed';
    }
}
/** Read the `kind` an engine hung on a caught value, when it is a string. */
function structuredFailureKind(value) {
    const anysearch = anySearchFailureSignal(value);
    if (anysearch !== undefined)
        return anysearch.kind;
    if (value !== null && typeof value === 'object') {
        const record = value;
        return typeof record.kind === 'string' ? record.kind : undefined;
    }
    return undefined;
}
/**
 * The zero-result note.
 *
 * A bare "no results" leaves the caller unable to tell a query with no answer
 * from a lane that returned nothing usable. The note therefore names every
 * lane and its end state, so the single-channel preset — whose one lane is the
 * whole coverage — says exactly why nothing came back. It only reads the
 * states the pipeline already recorded; it never dispatches anything.
 * @param lanes - every lane that took part, in dispatch order.
 */
function emptyResultNote(lanes) {
    const lead = '未找到与查询相关的结果';
    if (lanes.length === 0)
        return `${lead}：本次没有派发任何通道。`;
    if (lanes.length === 1)
        return `${lead}：单通道引擎 ${lanes[0].engineId} ${describeLane(lanes[0])}。`;
    return `${lead}：各通道状态：${lanes.map(lane => `${lane.engineId} ${describeLane(lane)}`).join('；')}。`;
}
/** One lane's state as a short, credential-free clause. */
function describeLane(lane) {
    switch (lane.state) {
        case 'empty':
            return lane.returned > 0
                ? `成功返回 ${lane.returned} 条，但均与查询无关`
                : '成功返回但无结果';
        case 'rate-limit': return '被限流（rate-limit），本次未取得结果';
        case 'quota-exhausted': return '当日额度已耗尽（quota-exhausted）';
        case 'insufficient-credits': return '余额不足（insufficient-credits）';
        case 'timeout': return '请求超时，未在限时内返回结果';
        case 'cancelled': return '被操作总限时取消，未取得结果';
        case 'skipped': return '已熔断，本次未派发';
        default: return '请求失败';
    }
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
