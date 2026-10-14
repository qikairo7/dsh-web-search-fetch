/**
 * Zhihu `global_search` HTTP client plus the `quota` call the search pipeline's
 * breaker consumes. Every failure path throws a `WebError` carrying one of the
 * seam's shared codes, so the provider layer adds no translation of its own;
 * failures the breaker reacts to also carry a machine-readable
 * {@link ZhihuCircuitSignal} rather than inviting anyone to parse a message.
 * @module engines/zhihu/client
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { MAX_UPSTREAM_ERROR_CHARS } from '../../limits.js';
import { ZHIHU_QUOTA_API_ID } from './limits.js';
import {
  ZHIHU_ENGINE_DEFAULTS,
  resolveZhihuEngineOptions,
  type ResolvedZhihuEngineOptions,
  type ZhihuEngineOptions,
} from './options.js';
import type { ZhihuQuota, ZhihuQuotaResponse, ZhihuSearchRequest, ZhihuSearchResponse } from './types.js';
import {
  buildZhihuSearchRequest,
  mapZhihuQuotaResponse,
  readInt64,
  readNonEmptyString,
  readRecord,
  readZhihuCode,
} from './wire.js';

/** Business `Code` values documented for the Zhihu OpenAPI. */
export const ZHIHU_CODE_INVALID_PARAM = 10001;
export const ZHIHU_CODE_AUTH_FAILED = 20001;
export const ZHIHU_CODE_RATE_LIMITED = 30001;
export const ZHIHU_CODE_INTERNAL_ERROR = 90001;

/**
 * What the search pipeline's breaker acts on. `rate-limit` means "back off and
 * try later"; `auth-failed` means the credential is unusable (`20001` or HTTP
 * 401/403); `quota-exhausted` means today's allowance is gone; `invalid-request`
 * means this query is malformed and retrying it cannot help.
 */
export interface ZhihuCircuitSignal {
  readonly kind: 'rate-limit' | 'auth-failed' | 'quota-exhausted' | 'invalid-request';
}

/** A `WebError` that additionally exposes the breaker signal, when there is one. */
export class ZhihuWebError extends WebError {
  readonly signal: ZhihuCircuitSignal | undefined;

  constructor(message: string, options: ErrorOptions & { signal?: ZhihuCircuitSignal } = {}) {
    super(message, 'WEB_PROVIDER_ERROR', options);
    this.signal = options.signal;
  }
}

/** Read the breaker signal off a caught failure, or `undefined` when there is none. */
export function readZhihuCircuitSignal(error: unknown): ZhihuCircuitSignal | undefined {
  return error instanceof ZhihuWebError ? error.signal : undefined;
}

export interface ZhihuClientOptions extends ZhihuEngineOptions {
  /**
   * Resolve the access secret once per operation; `undefined` means
   * unconfigured. Never cached (per-operation credential resolution).
   */
  resolveAccessSecret: () => Promise<string | undefined>;
  /** Credential reference name used in error messages (the value never appears). */
  credentialName: string;
  /** `fetch` implementation override for focused tests. */
  fetchImpl?: typeof fetch;
  /** Clock override for the timestamp header, in epoch milliseconds. */
  now?: () => number;
}

export class ZhihuClient {
  readonly options: ResolvedZhihuEngineOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAccessSecret: () => Promise<string | undefined>;
  private readonly credentialName: string;
  private readonly now: () => number;

  constructor(options: ZhihuClientOptions) {
    this.options = resolveZhihuEngineOptions(options);
    this.resolveAccessSecret = options.resolveAccessSecret;
    this.credentialName = options.credentialName;
    this.now = options.now ?? (() => Date.now());
    // Deferred lookup keeps `globalThis.fetch` patchable in tests.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * One `global_search` call. `Count` is derived here rather than by the caller
   * so the engine's configured ceiling is the only one that can apply. Throws
   * {@link ZhihuWebError} on every failure path.
   */
  async search(query: string, maxResults?: number, signal?: AbortSignal): Promise<ZhihuSearchResponse> {
    const request = buildZhihuSearchRequest(query, maxResults, this.options.countMax);
    const url = this.urlWith(this.options.baseURL, queryParamsOf(request));
    const payload = await this.request(url, 'global_search', signal);
    return payload as ZhihuSearchResponse;
  }

  /**
   * Today's quota for `global_search`. `undefined` means the body carried no
   * readable entry — not exhaustion; use `remaining <= 0` for that.
   */
  async quota(signal?: AbortSignal): Promise<ZhihuQuota | undefined> {
    const url = this.urlWith(this.options.quotaURL, [['APIIDs', ZHIHU_QUOTA_API_ID]]);
    const payload = await this.request(url, 'quota', signal);
    return mapZhihuQuotaResponse(payload as ZhihuQuotaResponse, ZHIHU_QUOTA_API_ID);
  }

  /** Append query parameters without disturbing any the configured URL already carries. */
  private urlWith(base: string, params: ReadonlyArray<readonly [string, string]>): string {
    const url = new URL(base);
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * One authenticated GET. The access secret is resolved per call and the
   * timestamp header is computed from the current clock per call, so a long
   * session never sends a stale `X-Request-Timestamp`.
   */
  private async request(
    url: string,
    operation: 'global_search' | 'quota',
    signal?: AbortSignal,
  ): Promise<ZhihuEnvelope> {
    if (signal?.aborted === true) {
      throw new WebError(`Zhihu ${operation} aborted`, 'WEB_ABORTED', { cause: signal.reason });
    }
    const accessSecret = await this.resolveAccessSecret();
    if (accessSecret === undefined || accessSecret.length === 0) {
      throw new ZhihuWebError(`web search credential "${this.credentialName}" is not configured`);
    }
    const timestamp = Math.floor(this.now() / 1000).toString();
    const deadline = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessSecret}`,
          'x-request-timestamp': timestamp,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: composed,
      });
    } catch (error) {
      throw translateZhihuTransportFailure(error, signal, deadline, this.options.timeoutMs);
    }
    if (!response.ok) throw await this.errorFromHttpStatus(response, operation, signal, deadline);
    const payload = await this.readJsonBody(response, operation, signal, deadline);
    assertZhihuSuccess(payload, operation);
    return payload;
  }

  /** Non-2xx: 401/403 → auth-failed, 429 → rate-limit; upstream detail is kept. */
  private async errorFromHttpStatus(
    response: Response,
    operation: 'global_search' | 'quota',
    outer: AbortSignal | undefined,
    deadline: AbortSignal,
  ): Promise<WebError> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return translateZhihuTransportFailure(error, outer, deadline, this.options.timeoutMs);
    }
    const detail = extractZhihuErrorDetail(text);
    const signal =
      response.status === 401 || response.status === 403
        ? ({ kind: 'auth-failed' } as const)
        : response.status === 429
          ? ({ kind: 'rate-limit' } as const)
          : undefined;
    return new ZhihuWebError(
      `Zhihu ${operation} failed with HTTP ${response.status}${detail}`,
      { signal },
    );
  }

  /** 2xx: parse the JSON envelope; malformed bodies are provider errors. */
  private async readJsonBody(
    response: Response,
    operation: 'global_search' | 'quota',
    outer: AbortSignal | undefined,
    deadline: AbortSignal,
  ): Promise<ZhihuEnvelope> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw translateZhihuTransportFailure(error, outer, deadline, this.options.timeoutMs);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new ZhihuWebError(`Zhihu ${operation} returned an unreadable JSON body`, { cause: error });
    }
    const record = readRecord(payload);
    if (record === undefined) {
      throw new ZhihuWebError(`Zhihu ${operation} returned a non-object response body`);
    }
    return record as ZhihuEnvelope;
  }
}

/** The envelope shape shared by both endpoints; only `Code`/`Message` are read here. */
type ZhihuEnvelope = Record<string, unknown>;

/** Query parameters of a built request, in a stable order. */
function queryParamsOf(request: ZhihuSearchRequest): Array<readonly [string, string]> {
  const params: Array<readonly [string, string]> = [['Query', request.Query]];
  if (request.Count !== undefined) params.push(['Count', String(request.Count)]);
  return params;
}

/**
 * Turn a non-zero business `Code` into a classified failure. A body without a
 * readable `Code` is malformed rather than a business error, so it is reported
 * as such instead of being guessed at.
 */
function assertZhihuSuccess(payload: ZhihuEnvelope, operation: 'global_search' | 'quota'): void {
  const code = readZhihuCode(payload);
  if (code === undefined) {
    throw new ZhihuWebError(`Zhihu ${operation} response has no readable Code`);
  }
  if (code === 0) return;
  const message = readNonEmptyString(payload.Message);
  const detail = message === undefined ? '' : `: ${truncate(message, MAX_UPSTREAM_ERROR_CHARS)}`;
  throw new ZhihuWebError(`Zhihu ${operation} failed with Code ${code}${detail}`, {
    signal: circuitSignalForCode(code),
  });
}

/** Documented business codes → breaker signal; undocumented codes get no signal. */
function circuitSignalForCode(code: number): ZhihuCircuitSignal | undefined {
  switch (code) {
    case ZHIHU_CODE_INVALID_PARAM:
      return { kind: 'invalid-request' };
    case ZHIHU_CODE_AUTH_FAILED:
      return { kind: 'auth-failed' };
    case ZHIHU_CODE_RATE_LIMITED:
      return { kind: 'rate-limit' };
    default:
      return undefined;
  }
}

/**
 * Classify a transport-level failure: an aborted outer signal is `WEB_ABORTED`,
 * the internal deadline and everything else (DNS/TLS/socket failures) are
 * provider errors. Cancellation is not the engine's fault, so it carries no
 * breaker signal.
 */
export function translateZhihuTransportFailure(
  error: unknown,
  outer: AbortSignal | undefined,
  deadline: AbortSignal,
  timeoutMs: number,
): WebError {
  if (outer?.aborted === true) {
    return new WebError('Zhihu request aborted', 'WEB_ABORTED', { cause: error });
  }
  if (deadline.aborted) {
    return new ZhihuWebError(`Zhihu request timed out after ${timeoutMs} ms`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ZhihuWebError(`Zhihu request failed: ${message}`, { cause: error });
}

/**
 * Extract a bounded `(Code …): Message` suffix from an upstream error body.
 * Never throws; unreadable bodies yield `''`.
 */
export function extractZhihuErrorDetail(text: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return '';
  }
  const record = readRecord(payload);
  if (record === undefined) return '';
  const code = readInt64(record.Code);
  const message = readNonEmptyString(record.Message);
  const codePart = code === undefined ? '' : ` (Code ${code})`;
  const messagePart = message === undefined ? '' : `: ${truncate(message, MAX_UPSTREAM_ERROR_CHARS)}`;
  return codePart === '' && messagePart === '' ? '' : `${codePart}${messagePart}`;
}

/** Truncate to at most `max` Unicode code points, never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** Re-exported so callers can read the effective defaults without another import. */
export { ZHIHU_ENGINE_DEFAULTS };
