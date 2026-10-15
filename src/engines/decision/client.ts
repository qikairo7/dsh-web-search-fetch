/**
 * Decision-model transport. Degrade-first: every non-cancellation failure
 * resolves to `null`, letting the automatic preset use its local rules.
 * Requests consult DSH's process-wide proxy route, so region-restricted
 * providers follow the host's outbound policy.
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { ALIBABA_DECISION_URL, DECISION_TIMEOUT_MS, MAX_DECISION_ERROR_CHARS, SILICONFLOW_SYSTEMONE_URL, TYPESAFE_JEV_URL } from './limits.js';
import { buildDecisionRequest, parseDecisionDepth } from './wire.js';
import type { DecisionProvider } from './types.js';

export type DecisionFailureReason = 'credential-missing' | 'credential-error' | 'timeout' | 'http-error' | 'unreadable-body' | 'unusable-results' | 'transport-error';
export interface DecisionClientOptions {
  readonly model: string;
  readonly provider: DecisionProvider;
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly credentialName: string;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly onFailure?: (reason: DecisionFailureReason, detail: string) => void;
}
export interface DecisionOutcome {
  readonly depth: 'fast' | 'balanced' | 'deep';
  readonly model: string;
  readonly confidence: number | undefined;
}
export class DecisionClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: DecisionClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }
  async decide(request: 'search' | 'fetch', text: string, signal?: AbortSignal): Promise<DecisionOutcome | null> {
    let apiKey: string | undefined;
    try { apiKey = await this.options.resolveApiKey(); }
    catch (error) { return this.fail('credential-error', describe(error)); }
    if (!apiKey) return this.fail('credential-missing', `credential "${this.options.credentialName}" is not configured`);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response: Response;
    try {
      const url = new URL(this.endpoint());
      const route = proxyRouteFor(url);
      const init: RequestInit = {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildDecisionRequest(this.options.model, request, text)),
        signal: composed,
      };
      if (route.proxied) (init as { dispatcher?: unknown }).dispatcher = route.dispatcher;
      response = await this.fetchImpl(url, init);
      if (route.proxied) (init as { dispatcher?: unknown }).dispatcher = route.dispatcher;
    } catch (error) {
      if (signal?.aborted) throw new WebError('Decision model aborted', 'WEB_ABORTED', { cause: error });
      return this.fail(deadline.aborted ? 'timeout' : 'transport-error', describe(error));
    }
    let body: string;
    try { body = await response.text(); }
    catch (error) { return this.fail('transport-error', describe(error)); }
    if (!response.ok) return this.fail('http-error', `HTTP ${response.status}${upstreamDetail(body)}`);
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { return this.fail('unreadable-body', 'unreadable JSON body'); }
    const parsed = parseDecisionDepth(payload);
    return parsed ?? this.fail('unusable-results', 'response carried no usable depth answer');
  }
  private endpoint(): string {
    if (this.options.baseURL) return this.options.baseURL;
    if (this.options.provider === 'alibaba') return ALIBABA_DECISION_URL;
    if (this.options.provider === 'typesafe') return TYPESAFE_JEV_URL;
    return SILICONFLOW_SYSTEMONE_URL;
  }
  private fail(reason: DecisionFailureReason, detail: string): null {
    try { this.options.onFailure?.(reason, detail); } catch { /* logging must not fail routing */ }
    return null;
  }
}
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_DECISION_ERROR_CHARS ? message : `${message.slice(0, MAX_DECISION_ERROR_CHARS)}…`;
}
function upstreamDetail(text: string): string {
  try {
    const payload = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = payload.code === undefined ? '' : ` (code ${String(payload.code)})`;
    const message = typeof payload.message === 'string' && payload.message ? `: ${payload.message.slice(0, MAX_DECISION_ERROR_CHARS)}` : '';
    return `${code}${message}`;
  } catch { return ''; }
}
