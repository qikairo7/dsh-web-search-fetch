import { AsyncLocalStorage } from 'node:async_hooks';
import { WebError } from '@deepseek-ai/dsh-web';

export interface RuntimeControls {
  mode?: 'organize' | 'select';
  /**
   * Dispatch breadth. `single` uses one channel and `multi` uses every eligible
   * one; `auto` picks between the two with the local rule (or the decision
   * model when `decisionRouting` is `model`). `balanced` and `deep` stay so a
   * saved configuration keeps working; they behave as capped breadth.
   */
  preset?: 'auto' | 'single' | 'multi' | 'custom' | 'free' | 'balanced' | 'deep';
  /**
   * How the automatic preset decides its breadth. `off` (the default) uses the
   * local query rule and never calls a model; `model` asks the configured
   * decision model first and falls back to the local rule on any failure.
   */
  decisionRouting?: 'off' | 'model';
  /** The request used by the automatic preset; absent for static configuration-only calls. */
  request?: 'search' | 'fetch';
  /** The query (search) or URL (fetch) used by the automatic preset. */
  requestText?: string;
  searchServices?: readonly string[];
  fetchServices?: readonly string[];
  serviceEnabled?: Readonly<Record<string, boolean>>;
  maxSearchServices?: number;
  maxFetchServices?: number;
  maxRequests?: number;
  searchDeadlineMs?: number;
  fetchDeadlineMs?: number;
  maxOutputChars?: number;
  decision?: DecisionRouter;
}

export interface DecisionRouter {
  readonly failureReason?: string;
  decide(request: 'search' | 'fetch', text: string, signal?: AbortSignal): Promise<{ depth: 'fast' | 'balanced' | 'deep'; model: string; confidence?: number } | null>;
}
interface Operation {
  closed?: boolean;
  controls: RuntimeControls;
  signal: AbortSignal;
  caller?: AbortSignal;
  requests: number;
  maxRequests: number;
  notes: string[];
  decisionDepth?: 'fast' | 'balanced' | 'deep';
}
const operations = new AsyncLocalStorage<Operation>();
export function operationNotes(): readonly string[] { return operations.getStore()?.notes ?? []; }
export function noteOperation(note: string): void { operations.getStore()?.notes.push(note); }
export function requestCount(): number { return operations.getStore()?.requests ?? 0; }
/** Requests this operation may still dispatch; unbounded outside an operation. */
export function remainingRequests(): number {
  const operation = operations.getStore();
  return operation === undefined ? Number.POSITIVE_INFINITY : Math.max(0, operation.maxRequests - operation.requests);
}
export function currentControls(): RuntimeControls { return operations.getStore()?.controls ?? {}; }
export function currentDecisionDepth(): 'fast' | 'balanced' | 'deep' | undefined { return operations.getStore()?.decisionDepth; }
export function serviceEnabled(id: string, fallback = true): boolean { return currentControls().serviceEnabled?.[id] ?? fallback; }
export function deadlineReached(): boolean {
  const operation = operations.getStore();
  return operation?.signal.aborted === true && !operation.caller?.aborted;
}

/** A cancelled lane must settle even if its injected transport ignores the signal. */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new WebError('operation aborted', 'WEB_ABORTED', { cause: signal.reason }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Per-provider-operation context isolates concurrent queries and their retries. */
export async function runOperation<T>(controls: RuntimeControls, face: 'search' | 'fetch', caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(face === 'search' ? controls.searchDeadlineMs ?? 15_000 : controls.fetchDeadlineMs ?? 50_000);
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  const operation: Operation = { controls, signal, caller, requests: 0, maxRequests: controls.maxRequests ?? 32, notes: [] };
  return operations.run(operation, async () => {
    let abort: (() => void) | undefined;
    let timeout: ReturnType<typeof setImmediate> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => {
        const error = new WebError(caller?.aborted ? 'operation aborted' : 'operation deadline exceeded', caller?.aborted ? 'WEB_ABORTED' : face === 'fetch' ? 'WEB_FETCH_TIMEOUT' : 'WEB_SEARCH_TIMEOUT');
        if (caller?.aborted) { reject(error); return; }
        operation.notes.push('操作总限时已到；返回已完成结果，未完成服务已取消。');
        // Allow abort-aware lanes to finish their microtasks and return survivors;
        // unresponsive operation work is still stopped on the next event-loop turn.
        timeout = setImmediate(() => reject(caller?.aborted
          ? new WebError('operation aborted', 'WEB_ABORTED', { cause: caller.reason }) : error));
      };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    try {
      if (signal.aborted) return await stopped;
      const result = await Promise.race([work(signal), stopped]);
      if (caller?.aborted) throw new WebError('operation aborted', 'WEB_ABORTED');
      return result;
    } finally {
      operation.closed = true;
      if (abort) signal.removeEventListener('abort', abort);
      if (timeout) clearImmediate(timeout);
    }
  });
}

/** Attach the operation's request text so the automatic preset can use it. */
export function resolveRuntimeRequest(controls: RuntimeControls, request: 'search' | 'fetch', text: string): RuntimeControls {
  return controls.preset === 'auto' ? { ...controls, request, requestText: text } : controls;
}

/**
 * Resolve the automatic preset through the configured decision model.
 *
 * `decisionRouting` is `off` by default: the local rule is deterministic, free,
 * and never fails. When it is `model`, a decision is requested first; a missing
 * model, a transport failure, or an unusable answer is noted and the caller
 * falls back to the local rule — an unreachable decision model must not turn
 * into "no results".
 */
export async function resolveAutomaticDepth(signal?: AbortSignal): Promise<'fast' | 'balanced' | 'deep' | undefined> {
  const controls = currentControls();
  if (controls.preset !== 'auto' || controls.decisionRouting !== 'model' || controls.decision === undefined) return undefined;
  try {
    const outcome = await controls.decision.decide(controls.request ?? 'search', controls.requestText ?? '', signal ?? operations.getStore()?.signal);
    if (!outcome) {
      noteOperation(`决策模型不可用（${controls.decision.failureReason ?? 'unavailable'}），改用本地规则判断调用范围。`);
      return undefined;
    }
    const operation = operations.getStore();
    if (operation) operation.decisionDepth = outcome.depth;
    noteOperation(`决策模型 ${outcome.model} 判定为 ${outcome.depth}${outcome.confidence === undefined ? '' : `（置信度 ${(outcome.confidence * 100).toFixed(0)}%）`}。`);
    return outcome.depth;
  } catch (error) {
    if (deadlineReached() || operations.getStore()?.caller?.aborted === true) throw error;
    noteOperation(`决策模型请求失败（${describeFailure(error)}），改用本地规则判断调用范围。`);
    return undefined;
  }
}

/** A short, credential-free description of a caught decision failure. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 120 ? message : `${message.slice(0, 120)}…`;
}

/** Every plugin-owned HTTP attempt acquires a permit before any network write. */
export function budgetedFetch(fetcher?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const operation = operations.getStore();
    if (operation) {
      if (operation.closed || operation.signal.aborted) throw new WebError('request cancelled', 'WEB_ABORTED');
      if (operation.requests >= operation.maxRequests) {
        noteOperation('请求预算已用尽；未派发额外请求。');
        throw new WebError('request budget exhausted', 'WEB_PROVIDER_ERROR', { cause: { kind: 'request-budget' } });
      }
      operation.requests++;
      const signals = [operation.signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])];
      return (fetcher ?? globalThis.fetch)(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
    }
    return (fetcher ?? globalThis.fetch)(input, { ...init, redirect: 'error' });
  };
}

/**
 * Select the services one operation dispatches.
 * @param items - candidate services, in dispatch order.
 * @param id - service id accessor.
 * @param face - which capability's scope applies.
 * @param ready - optional credential/availability probe.
 * @param capOverride - explicit breadth, used when a preset escalates beyond
 *   its own cap (for example the single preset's documented fallback).
 */
export async function selectServices<T>(items: readonly T[], id: (item: T) => string, face: 'search' | 'fetch', ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>, capOverride?: number): Promise<T[]> {
  const controls = currentControls();
  const chosen = face === 'search' ? controls.searchServices : controls.fetchServices;
  const free = ['tinyfish', 'bing', 'github', 'aihot'];
  const cap = capOverride ?? resolveAutoCap(controls, face, await resolveAutomaticDepth());
  const ordered = chosen ? [...items].sort((a, b) => chosen.indexOf(id(a)) - chosen.indexOf(id(b))) : [...items];
  const allowed = ordered.filter(item => serviceEnabled(id(item)) && (!chosen || chosen.includes(id(item))) && (controls.preset !== 'free' || free.includes(id(item))));
  const available = await Promise.all(allowed.map(async item => !ready || await ready(id(item), face)));
  const usable = allowed.filter((_, index) => available[index]);
  const selected = usable.slice(0, cap);
  noteOperation(`实际选择 ${selected.length} 路${face === 'search' ? '搜索' : '提取'}服务。`);
  if (usable.length > selected.length) noteOperation(`服务数量上限：仅派发 ${selected.length} 路，未派发 ${usable.length - selected.length} 路。`);
  return selected;
}

/**
 * Resolve how many services one operation may dispatch.
 *
 * The preset names the breadth directly (`single` = one channel, `multi` =
 * every eligible one), while the automatic preset decides between those two.
 * The local rule is deterministic and free: a query that asks for comparison,
 * research or recency is worth several channels, and everything else starts
 * with one. A decision model is consulted only when `decisionRouting` is
 * `model`, and its `fast`/`balanced`/`deep` answer maps onto the same breadth
 * scale. `balanced` and `deep` are legacy presets kept for saved
 * configurations; they behave as capped and full breadth.
 *
 * The fetch face keeps its URL-shape rule as a second signal: the automatic
 * two-stage probe (see `fetch-pipeline.ts`) already spends one request before
 * any fan-out, so a plain page can still fan out when the probe is not enough.
 */
export function resolveAutoCap(controls: RuntimeControls, face: 'search' | 'fetch', decisionDepth?: 'fast' | 'balanced' | 'deep'): number {
  const limit = face === 'search' ? controls.maxSearchServices ?? 16 : controls.maxFetchServices ?? 11;
  switch (controls.preset) {
    case 'single':
      noteOperation('单通道预设：只派发 1 路服务。');
      return Math.min(limit, 1);
    case 'multi':
      noteOperation(`多通道预设：最多派发 ${limit} 路服务。`);
      return limit;
    case 'balanced':
      return Math.min(limit, 3);
    case 'deep':
      return limit;
    case 'auto':
      break;
    default:
      return limit;
  }
  if (decisionDepth !== undefined) {
    const caps = { fast: Math.min(limit, 1), balanced: Math.min(limit, 3), deep: limit } as const;
    const cap = caps[decisionDepth];
    noteOperation(`自动档按决策结果使用 ${cap} 路上限。`);
    return cap;
  }
  if (face === 'search') {
    const multi = multiChannelQuery(controls.requestText ?? '');
    const cap = multi ? limit : Math.min(limit, 1);
    noteOperation(`自动档按本地规则判定为${multi ? '多通道' : '单通道'}（${cap} 路）。`);
    return cap;
  }
  const url = controls.requestText ?? '';
  const staticLike = /\.(?:txt|text|xml|json|md|markdown|csv|tsv|rss|atom|yaml|yml|log|ini|toml|ics|vtt|srt)(?:[?#]|$)/i.test(url);
  const documentationLike = /(?:docs?|documentation|developer|github\.com|stackoverflow\.com|wikipedia\.org)/i.test(url);
  const cap = staticLike ? Math.min(limit, 3) : documentationLike ? Math.min(limit, 5) : limit;
  noteOperation(`自动档判定为${staticLike ? '轻量提取' : documentationLike ? '文档提取' : '深度提取'}（${cap} 路）。`);
  return cap;
}

/**
 * The local breadth rule: does this query ask for comparison, research or
 * recency — the intents where one channel demonstrably misses material?
 * @param query - the search query as the caller wrote it.
 * @returns whether several channels are warranted.
 */
export function multiChannelQuery(query: string): boolean {
  return /对比|比较|综述|review|compare|benchmark|研究|调研|资料|证据|引用|来源|最新|新闻|今日|今天|近期|最近|近日|本周|本月|快讯|要闻|热点|today|latest|news|202\d/i.test(query);
}

/**
 * Whether this operation's search breadth resolved to a single channel.
 *
 * Mirrors the automatic preset's rule in {@link resolveAutoCap}: an explicit
 * `single` preset is always one channel, the automatic preset is one channel
 * when the decision model answered `fast` or, without a model answer, when the
 * local query rule found no comparison/research/recency intent. Every other
 * preset dispatches several channels by design.
 * @param controls - the operation's controls; defaults to the current operation.
 * @param decisionDepth - the decision model's answer, when it ran.
 * @returns whether only one search channel is dispatched.
 */
export function singleChannelSearch(
  controls: RuntimeControls = currentControls(),
  decisionDepth: 'fast' | 'balanced' | 'deep' | undefined = currentDecisionDepth(),
): boolean {
  if (controls.preset === 'single') return true;
  if (controls.preset !== 'auto') return false;
  if (decisionDepth !== undefined) return decisionDepth === 'fast';
  return !multiChannelQuery(controls.requestText ?? '');
}

/**
 * Whether the current preset dispatches several channels, so a settlement
 * window may end the slow lanes early. The single-channel presets never have
 * more than one lane to settle against.
 */
export function multiChannelPreset(controls: RuntimeControls = currentControls()): boolean {
  return controls.preset !== 'single' && controls.preset !== 'balanced';
}
