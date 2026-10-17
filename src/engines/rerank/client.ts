/**
 * SiliconFlow rerank engine transport (DESIGN.md's rerank stage).
 *
 * Degrade-first contract, degrade-first: every failure that is not
 * the caller's own cancellation resolves to `null` instead of throwing, so the
 * search pipeline can fall back to plain RRF order and still answer the query.
 * `null` covers a timeout, HTTP failure, throttling (429 / TPM), a non-JSON or
 * unusable body, a missing credential, and empty inputs. The single throwing
 * path is an already-aborted outer signal: cancellation belongs to the caller
 * and must not be re-labelled as a rerank miss.
 * @module engines/rerank/client
 */
import { WebError } from '@deepseek-ai/dsh-web';
import {
  MAX_UPSTREAM_ERROR_CHARS,
  RERANK_TIMEOUT_MS,
  SILICONFLOW_RERANK_URL,
} from './limits.js';
import type { RerankRequest, RerankResponse } from './types.js';
import { buildRerankRequest, orderRerankedIndexes } from './wire.js';

/** Why a rerank call degraded to `null`; reported through `onDegrade` only. */
export type RerankDegradeReason =
  | 'empty-query'
  | 'empty-documents'
  | 'credential-missing'
  | 'credential-error'
  | 'timeout'
  | 'http-error'
  | 'unreadable-body'
  | 'unusable-results'
  | 'transport-error';

export interface RerankClientOptions {
  /** Resolve the API key once per operation; `undefined` means unconfigured. Never cached. */
  resolveApiKey: () => Promise<string | undefined>;
  /** Credential reference name used in the degrade detail (the value never appears). */
  credentialName: string;
  /** Endpoint override (tests point this at a local mock server). */
  baseURL?: string;
  /** Whole-operation deadline; defaults to the documented rerank budget. */
  timeoutMs?: number;
  /** `fetch` implementation override for focused tests. */
  fetchImpl?: typeof fetch;
  /**
   * Optional degrade sink so the pipeline can log the fallback (DESIGN.md:
   * "失败或超时降级回纯 RRF 排序并记日志"). Never allowed to break the call.
   */
  onDegrade?: (reason: RerankDegradeReason, detail: string) => void;
}

export class RerankClient {
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveApiKey: () => Promise<string | undefined>;
  private readonly credentialName: string;
  private readonly onDegrade: ((reason: RerankDegradeReason, detail: string) => void) | undefined;

  constructor(options: RerankClientOptions) {
    this.baseURL = options.baseURL ?? SILICONFLOW_RERANK_URL;
    this.timeoutMs = options.timeoutMs ?? RERANK_TIMEOUT_MS;
    this.resolveApiKey = options.resolveApiKey;
    this.credentialName = options.credentialName;
    this.onDegrade = options.onDegrade;
    // Deferred lookup keeps `globalThis.fetch` patchable in tests.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Rerank `documents` against `query` and return the reordered index sequence
   * (a full permutation of the input positions, best first), or `null` when the
   * engine is unusable and the caller should keep its current order.
   *
   * @throws WebError with code `WEB_ABORTED` when `signal` is already aborted
   * or aborts mid-flight. That is the only throwing path.
   */
  async rerank(
    query: string,
    documents: readonly string[],
    topN: number,
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    if (isAborted(signal)) {
      throw new WebError('Rerank aborted', 'WEB_ABORTED', { cause: signal?.reason });
    }
    if (documents.length === 0) return this.degrade('empty-documents', 'no documents to rerank');
    if (query.trim().length === 0) return this.degrade('empty-query', 'empty query');

    let apiKey: string | undefined;
    try {
      apiKey = await this.resolveApiKey();
    } catch (error) {
      return this.degrade('credential-error', describeError(error));
    }
    if (isAborted(signal)) {
      throw new WebError('Rerank aborted', 'WEB_ABORTED', { cause: signal?.reason });
    }
    if (apiKey === undefined || apiKey.length === 0) {
      return this.degrade('credential-missing', `credential "${this.credentialName}" is not configured`);
    }

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseURL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(buildRerankRequest(query, documents, topN)),
        signal: composed,
      });
    } catch (error) {
      // Cancellation is the caller's own signal, never the internal deadline.
      if (isAborted(signal)) {
        throw new WebError('Rerank aborted', 'WEB_ABORTED', { cause: error });
      }
      if (deadline.aborted) {
        return this.degrade('timeout', `rerank timed out after ${this.timeoutMs} ms`);
      }
      return this.degrade('transport-error', describeError(error));
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAborted(signal)) {
        throw new WebError('Rerank aborted', 'WEB_ABORTED', { cause: error });
      }
      return this.degrade('transport-error', describeError(error));
    }
    if (!response.ok) {
      return this.degrade('http-error', `HTTP ${response.status}${upstreamDetail(text)}`);
    }

    let payload: RerankResponse;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return this.degrade('unreadable-body', 'non-object response body');
      }
      payload = parsed as RerankResponse;
    } catch {
      return this.degrade('unreadable-body', 'unreadable JSON body');
    }

    const order = orderRerankedIndexes(payload, documents.length);
    if (order === undefined) {
      return this.degrade('unusable-results', 'response carried no usable score entry');
    }
    return order;
  }

  /** Record a degrade and return the degrade signal (`null`). */
  private degrade(reason: RerankDegradeReason, detail: string): null {
    try {
      this.onDegrade?.(reason, detail);
    } catch {
      // A logging sink must never turn a degrade into a failure.
    }
    return null;
  }
}

/** True when a caller-supplied signal has already been aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** A bounded, credential-free description of a caught value. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_UPSTREAM_ERROR_CHARS
    ? message
    : `${message.slice(0, MAX_UPSTREAM_ERROR_CHARS)}…`;
}

/**
 * Extract a bounded `(code …): message` suffix from an upstream error body.
 * Never throws; unreadable bodies yield `''`.
 */
function upstreamDetail(text: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return '';
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const codePart = code === '' ? '' : ` (code ${code})`;
  const messagePart = message === '' ? '' : `: ${message.slice(0, MAX_UPSTREAM_ERROR_CHARS)}`;
  return codePart === '' && messagePart === '' ? '' : `${codePart}${messagePart}`;
}
