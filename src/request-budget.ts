import { AsyncLocalStorage } from 'node:async_hooks';
import { WebError } from '@deepseek-ai/dsh-web';

export interface RuntimeControls {
  mode?: 'organize' | 'select';
  preset?: 'custom' | 'free' | 'balanced' | 'deep';
  searchServices?: readonly string[];
  fetchServices?: readonly string[];
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
  const cap = controls.preset === 'balanced' ? Math.min(limit, 3) : limit;
  const ordered = chosen ? [...items].sort((a, b) => chosen.indexOf(id(a)) - chosen.indexOf(id(b))) : [...items];
  const allowed = ordered.filter(item => (!chosen || chosen.includes(id(item))) && (controls.preset !== 'free' || free.includes(id(item))));
  const available = await Promise.all(allowed.map(async item => !ready || await ready(id(item), face)));
  const usable = allowed.filter((_, index) => available[index]);
  const selected = usable.slice(0, cap);
  if (usable.length > selected.length) noteOperation(`服务数量上限：仅派发 ${selected.length} 路，未派发 ${usable.length - selected.length} 路。`);
  return selected;
}
