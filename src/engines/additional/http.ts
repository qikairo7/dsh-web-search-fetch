import { isTavilyKeylessEndpoint } from '../../keyless.js';
import { WebError } from '@deepseek-ai/dsh-web';
import type { BreakerSignal } from '../../breaker/index.js';
import { parseRetryAfterMs } from '../anysearch/error.js';
import { isFirecrawlKeylessEndpoint } from '../firecrawl/wire.js';

export interface EngineHttpOptions {
  id: string;
  baseURL: string;
  resolveApiKey: () => Promise<string | undefined>;
  auth: 'bearer' | 'x-api-key' | 'none';
  accept?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /**
   * Read the target site's own status from a non-2xx response body, when the
   * engine reports a site-side error as its own gateway failure.
   *
   * Injected rather than branched on `id` here: recognising a vendor's error
   * envelope is response mapping, and the transport stays protocol-agnostic
   * (CONTRIBUTING「服务协议映射与 HTTP 传输分离」). Returning `undefined` keeps
   * the response an engine failure.
   */
  readTargetStatus?: (response: Response) => Promise<number | undefined>;
}

/** Transport shared by the additional HTTP engines; each call resolves its own credential. */
export class EngineHttp {
  private readonly cache = new Map<string, { data: string; etag?: string; expiresAt: number }>();
  private cooldown?: { until: number; error: WebError };
  constructor(private readonly options: EngineHttpOptions) {}

  async call(path: string, body: unknown, signal?: AbortSignal, query?: URLSearchParams): Promise<Record<string, unknown>> {
    return this.request(path, body, signal, query, async response => record(await response.json(), this.options.id));
  }

  async callText(path: string, body: unknown, signal?: AbortSignal, query?: URLSearchParams): Promise<string> {
    return this.request(path, body, signal, query, readText);
  }

  /** Opt-in conditional GET for AIHOT; bounded private cache, never a stale fallback. */
  async cachedGet(path: string, signal: AbortSignal | undefined, query: URLSearchParams): Promise<Record<string, unknown>> {
    return record(JSON.parse(await this.cachedText(path, signal, query)), this.options.id);
  }

  /** JSON and Agent Markdown share conditional caching; the caller validates the representation. */
  async cachedText(path: string, signal: AbortSignal | undefined, query: URLSearchParams, defaultTtlSeconds = 60): Promise<string> {
    if (signal?.aborted) throw new WebError(`${this.options.id}: aborted`, 'WEB_ABORTED');
    const key = `${path}?${query}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    return this.request(path, undefined, signal, query, async (response, composed) => {
      const data = response.status === 304 ? cached!.data : await readText(response, composed);
      // Do not cache malformed JSON, which would otherwise conceal recovery until expiry.
      if (!path.startsWith('/api/v1/agent')) record(JSON.parse(data), this.options.id);
      const control = response.headers.get('cache-control') ?? '';
      if (/\bno-store\b/i.test(control)) { this.cache.delete(key); return data; }
      const seconds = /(?:^|[,\s])max-age=(\d+)/i.exec(control)?.[1];
      const ttl = /\bno-cache\b/i.test(control) ? 0 : Math.max(Number(seconds ?? defaultTtlSeconds), defaultTtlSeconds === 600 ? 600 : 0) * 1000;
      const etag = response.headers.get('etag') ?? cached?.etag;
      this.cache.delete(key);
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { data, expiresAt: Date.now() + ttl, ...(etag === undefined ? {} : { etag }) });
      return data;
    }, cached?.etag === undefined ? {} : { 'if-none-match': cached.etag }, cached !== undefined);
  }

  private async request<T>(path: string, body: unknown, signal: AbortSignal | undefined, query: URLSearchParams | undefined, read: (response: Response, signal: AbortSignal) => Promise<T>, extraHeaders: Record<string, string> = {}, allowNotModified = false): Promise<T> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    try {
      if (composed.aborted) throw new WebError(`${this.options.id}: aborted`, 'WEB_ABORTED');
      if (this.cooldown && this.cooldown.until > Date.now()) throw this.cooldown.error;
      const key = this.options.auth === 'none' ? undefined : (await abortable(this.options.resolveApiKey(), composed))?.trim();
      const url = new URL(this.options.baseURL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new WebError(`${this.options.id}: invalid API endpoint`, 'WEB_PROVIDER_ERROR');
      }
      url.pathname = url.pathname.replace(/\/+$/, '') + path;
      url.search = query?.toString() ?? '';
      url.hash = '';
      if (this.options.auth !== 'none' && !key && !(this.options.id === 'firecrawl' && isFirecrawlKeylessEndpoint(url.href)) && !(this.options.id === 'tavily' && isTavilyKeylessEndpoint(url.href))) {
        throw new WebError(`${this.options.id}: credential is not configured`, 'WEB_PROVIDER_ERROR');
      }
      const headers: Record<string, string> = {
        accept: this.options.accept ?? 'application/json', 'content-type': 'application/json',
        'user-agent': 'dsh-web-search-fetch', 'accept-encoding': 'gzip, br',
        ...(!key || this.options.auth === 'none' ? {} : this.options.auth === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }),
        ...(this.options.id === 'tavily' && !key ? { 'x-tavily-access-mode': 'keyless' } : {}),
        ...extraHeaders,
      };
      if (this.options.id === 'github') {
        headers.accept = 'application/vnd.github+json';
        headers['x-github-api-version'] = '2022-11-28';
      }
      const response = await abortable((this.options.fetchImpl ?? globalThis.fetch)(url.href, {
        method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: composed,
      }), composed);
      if (!response.ok && !(allowNotModified && response.status === 304)) {
        // Some engines report a non-2xx *target* as their own gateway error and
        // put the site's status in the body. That status is the fetched
        // resource's state, so it is a result, not an engine failure. The
        // engine supplies the reader; the transport never knows the protocol.
        const targetStatus = await this.options.readTargetStatus?.(response);
        if (targetStatus !== undefined) throw new TargetStatusError(this.options.id, targetStatus);
        await response.body?.cancel().catch(() => undefined);
        const rateLimited = response.status === 429 || (this.options.id === 'aihot' && response.status === 503) || (this.options.id === 'github' && response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
        let cause: BreakerSignal | undefined;
        if (rateLimited) {
          let retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined);
          if (retryAfterMs === undefined && this.options.id === 'github') {
            const reset = Number(response.headers.get('x-ratelimit-reset'));
            if (Number.isFinite(reset) && reset > 0) retryAfterMs = Math.max(0, reset * 1000 - Date.now());
          }
          cause = { kind: 'rate-limit', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
        } else if (response.status === 402) cause = { kind: 'insufficient-credits' };
        const error = new WebError(`${this.options.id}: HTTP ${response.status}`, 'WEB_PROVIDER_ERROR', { cause });
        if (this.options.id === 'aihot' && cause?.kind === 'rate-limit') {
          this.cooldown = { until: Date.now() + (cause.retryAfterMs ?? 60_000), error };
        }
        throw error;
      }
      return await abortable(read(response, composed), composed);
    } catch (error) {
      if (signal?.aborted) throw new WebError(`${this.options.id}: aborted`, 'WEB_ABORTED');
      if (deadline.aborted) throw new WebError(`${this.options.id}: timed out`, 'WEB_PROVIDER_ERROR');
      // Not a transport failure: the adapter turns this into a fetched result.
      if (error instanceof TargetStatusError) throw error;
      if (error instanceof WebError) throw error;
      // Vendor responses and transport errors can echo request headers.
      throw new WebError(`${this.options.id}: unreadable response or transport failure`, 'WEB_PROVIDER_ERROR');
    }
  }
}

/**
 * A non-2xx *target* reported inside an engine's own error envelope.
 *
 * A `WebError`, so the seam's unified `WEB_*` error contract holds and any
 * caller that does not special-case it still routes on a stable code. The
 * target status rides alongside as `targetStatus` so the adapter can turn it
 * into a fetched result.
 */
export class TargetStatusError extends WebError {
  constructor(readonly engineId: string, readonly targetStatus: number) {
    super(`${engineId}: target returned HTTP ${targetStatus}`, 'WEB_PROVIDER_ERROR');
    this.name = 'TargetStatusError';
  }
}

/** Bounded read of an error body; a vendor envelope is small, and the cap keeps it that way. */
const MAX_ERROR_BODY_BYTES = 64_000;

/**
 * Read a non-2xx response body as text under a byte cap.
 *
 * The shared `readText` needs the operation signal and enforces the 1 MB
 * response limit; error envelopes are small, so this reads under a tighter cap
 * and never lets an oversized or unreadable body turn into a different error.
 */
async function readBoundedErrorText(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > MAX_ERROR_BODY_BYTES) return undefined;
      text += decoder.decode(part.value, { stream: true });
    }
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Crawl4AI's target-status reader.
 *
 * The cloud API answers a site-side 4xx with its own 502 and puts the site's
 * code in `origin_status` (https://api.crawl4ai.com/llms.txt). Lives here, with
 * the engine, so the transport stays free of vendor protocol knowledge.
 */
export async function readCrawl4aiTargetStatus(response: Response): Promise<number | undefined> {
  const text = await readBoundedErrorText(response);
  if (text === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(text);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const status = (payload as Record<string, unknown>).origin_status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  } catch {
    return undefined;
  }
}

/** RSS and Markdown responses are bounded before parsing or returning content. */
async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = '';
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) return content + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > 1_000_000) throw new WebError('response exceeds text limit', 'WEB_FETCH_TOO_LARGE');
      content += decoder.decode(part.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Work may already be running; consume its later rejection before returning cancellation.
    void work.catch(() => undefined);
    throw new WebError('operation aborted', 'WEB_ABORTED');
  }
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new WebError('operation aborted', 'WEB_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function record(value: unknown, id: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebError(`${id}: invalid response object`, 'WEB_PROVIDER_ERROR');
  }
  return value as Record<string, unknown>;
}

export function rows(value: unknown, id: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new WebError(`${id}: invalid result list`, 'WEB_PROVIDER_ERROR');
  return value.map(item => record(item, id));
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function additionalBreakerSignal(error: unknown): BreakerSignal | undefined {
  if (!(error instanceof WebError)) return undefined;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object' || !('kind' in cause)) return undefined;
  if (cause.kind === 'rate-limit' || cause.kind === 'insufficient-credits' || cause.kind === 'quota-exhausted') return cause as BreakerSignal;
  return undefined;
}
