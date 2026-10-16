/**
 * Decision-model transport. Non-cancellation failures resolve to `null`;
 * automatic routing rejects the operation before dispatching services.
 * Requests consult DSH's process-wide proxy route, so region-restricted
 * providers follow the host's outbound policy.
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy';
import { fetch as undiciFetch } from 'undici';
import { abortable } from '../../request-budget.js';
import { ALIBABA_DECISION_URL, DECISION_TIMEOUT_MS, MAX_DECISION_ERROR_CHARS, SILICONFLOW_SYSTEMONE_URL, TYPESAFE_JEV_URL } from './limits.js';
import { buildDecisionRequest, parseDecisionDepth } from './wire.js';
export class DecisionClient {
    options;
    failureReason;
    timeoutMs;
    fetchImpl;
    constructor(options) {
        this.options = options;
        this.timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
        this.fetchImpl = options.fetchImpl ?? decisionFetch;
    }
    async decide(request, text, signal) {
        const deadline = AbortSignal.timeout(this.timeoutMs);
        const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let apiKey;
        try {
            apiKey = await abortable(this.options.resolveApiKey(), composed);
        }
        catch (error) {
            if (signal?.aborted)
                throw new WebError('Decision model aborted', 'WEB_ABORTED', { cause: error });
            return this.fail(deadline.aborted ? 'timeout' : 'credential-error', 'credential resolution failed');
        }
        if (!apiKey)
            return this.fail('credential-missing', `credential "${this.options.credentialName}" is not configured`);
        let response;
        try {
            const url = new URL(this.endpoint());
            const route = proxyRouteFor(url);
            const init = {
                method: 'POST',
                headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(buildDecisionRequest(this.options.model, request, text)),
                signal: composed,
            };
            if (route.proxied)
                init.dispatcher = route.dispatcher;
            response = await abortable(this.fetchImpl(url, init), composed);
        }
        catch (error) {
            if (signal?.aborted)
                throw new WebError('Decision model aborted', 'WEB_ABORTED', { cause: error });
            return this.fail(deadline.aborted ? 'timeout' : 'transport-error', describe(error));
        }
        let body;
        try {
            body = await abortable(response.text(), composed);
        }
        catch (error) {
            if (signal?.aborted)
                throw new WebError('Decision model aborted', 'WEB_ABORTED', { cause: error });
            return this.fail(deadline.aborted ? 'timeout' : 'transport-error', 'response body unavailable');
        }
        if (!response.ok)
            return this.fail('http-error', `HTTP ${response.status}${upstreamDetail(body)}`);
        let payload;
        try {
            payload = JSON.parse(body);
        }
        catch {
            return this.fail('unreadable-body', 'unreadable JSON body');
        }
        const parsed = parseDecisionDepth(payload);
        return parsed ?? this.fail('unusable-results', 'response carried no usable depth answer');
    }
    endpoint() {
        if (this.options.baseURL)
            return this.options.baseURL;
        if (this.options.provider === 'alibaba')
            return ALIBABA_DECISION_URL;
        if (this.options.provider === 'typesafe')
            return TYPESAFE_JEV_URL;
        return SILICONFLOW_SYSTEMONE_URL;
    }
    fail(reason, detail) {
        this.failureReason = reason;
        try {
            this.options.onFailure?.(reason, detail);
        }
        catch { /* logging must not fail routing */ }
        return null;
    }
}
// Keep fetch and the host's dispatcher on the same Undici major version.
export const decisionFetch = undiciFetch;
function describe(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length <= MAX_DECISION_ERROR_CHARS ? message : `${message.slice(0, MAX_DECISION_ERROR_CHARS)}…`;
}
function upstreamDetail(text) {
    try {
        const payload = JSON.parse(text);
        const code = payload.code === undefined ? '' : ` (code ${String(payload.code)})`;
        const message = typeof payload.message === 'string' && payload.message ? `: ${payload.message.slice(0, MAX_DECISION_ERROR_CHARS)}` : '';
        return `${code}${message}`;
    }
    catch {
        return '';
    }
}
