import { AsyncLocalStorage } from 'node:async_hooks';
import { WebError } from '@deepseek-ai/dsh-web';

export interface RuntimeControls {
  mode?: 'organize' | 'select';
  preset?: 'auto' | 'custom' | 'free' | 'balanced' | 'deep';
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
}
interface Operation {
  closed?: boolean;
  controls: RuntimeControls;
  signal: AbortSignal;
  caller?: AbortSignal;
  requests: number;
  maxRequests: number;
  notes: string[];
}
const operations = new AsyncLocalStorage<Operation>();
export function operationNotes(): readonly string[] { return operations.getStore()?.notes ?? []; }
export function noteOperation(note: string): void { operations.getStore()?.notes.push(note); }
export function requestCount(): number { return operations.getStore()?.requests ?? 0; }
export function currentControls(): RuntimeControls { return operations.getStore()?.controls ?? {}; }
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

export async function selectServices<T>(items: readonly T[], id: (item: T) => string, face: 'search' | 'fetch', ready?: (id: string, face: 'search' | 'fetch') => Promise<boolean>): Promise<T[]> {
  const controls = currentControls();
  const chosen = face === 'search' ? controls.searchServices : controls.fetchServices;
  const free = ['tinyfish', 'bing', 'github', 'aihot'];
  const limit = face === 'search' ? controls.maxSearchServices ?? 16 : controls.maxFetchServices ?? 11;
  const autoCap = resolveAutoCap(controls, face);
  const cap = controls.preset === 'balanced' ? Math.min(limit, 3) : autoCap;
  const ordered = chosen ? [...items].sort((a, b) => chosen.indexOf(id(a)) - chosen.indexOf(id(b))) : [...items];
  const allowed = ordered.filter(item => serviceEnabled(id(item)) && (!chosen || chosen.includes(id(item))) && (controls.preset !== 'free' || free.includes(id(item))));
  const available = await Promise.all(allowed.map(async item => !ready || await ready(id(item), face)));
  const usable = allowed.filter((_, index) => available[index]);
  const selected = usable.slice(0, cap);
  if (usable.length > selected.length) noteOperation(`服务数量上限：仅派发 ${selected.length} 路，未派发 ${usable.length - selected.length} 路。`);
  return selected;
}

/**
 * Resolve the automatic preset's cap. The rule layer is local and deterministic:
 * search query intent decides between a fast lane and broad fan-out; fetch URL
 * shape and configured limits decide between the recommended trio and a deep
 * run. Users never select the resulting depth manually.
 */
export function resolveAutoCap(controls: RuntimeControls, face: 'search' | 'fetch'): number {
  if (controls.preset !== 'auto') {
    const limit = face === 'search' ? controls.maxSearchServices ?? 16 : controls.maxFetchServices ?? 11;
    return limit;
  }
  const limit = face === 'search' ? controls.maxSearchServices ?? 16 : controls.maxFetchServices ?? 11;
  if (face === 'search') {
    const query = controls.requestText ?? '';
    const deep = /对比|比较|综述|review|compare|benchmark|研究|调研|资料|证据|引用|来源|最新|today|latest|news|202\d/i.test(query);
    const cap = deep ? limit : Math.min(limit, 3);
    noteOperation(`自动档判定为${deep ? '广覆盖' : '快速响应'}（${cap} 路）。`);
    return cap;
  }
  const url = controls.requestText ?? '';
  const staticLike = /\.(?:txt|text|xml|json|md|markdown|csv|tsv|rss|atom|yaml|yml|log|ini|toml|ics|vtt|srt)(?:[?#]|$)/i.test(url);
  const documentationLike = /(?:docs?|documentation|developer|github\.com|stackoverflow\.com|wikipedia\.org)/i.test(url);
  const cap = staticLike ? Math.min(limit, 3) : documentationLike ? Math.min(limit, 5) : limit;
  noteOperation(`自动档判定为${staticLike ? '轻量提取' : documentationLike ? '文档提取' : '深度提取'}（${cap} 路）。`);
  return cap;
}
