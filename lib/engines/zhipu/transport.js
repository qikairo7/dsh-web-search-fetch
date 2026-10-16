/**
 * Transport helpers for Zhipu search: credential resolution, failure
 * classification, and the
 * upstream error-body reader. Request shaping and HTTP-status classification
 * stay in each operation's client, because those genuinely differ.
 * @module engines/zhipu/transport
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { MAX_UPSTREAM_ERROR_CHARS } from '../../limits.js';
import { readNonEmptyString, readRecord, truncateToCodePoints } from './wire.js';
/** Narrow a caught `cause` to the rate-limit signal. */
export function isZhipuRateLimitSignal(value) {
    return (typeof value === 'object' && value !== null && value.kind === 'rate-limit');
}
/**
 * Parse a `Retry-After` header value — delta-seconds or an HTTP-date — into
 * milliseconds. Anything unreadable yields `undefined` (a missing hint, not
 * a failure).
 */
export function parseRetryAfterMs(value) {
    if (value === null)
        return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return undefined;
    if (/^\d+$/.test(trimmed))
        return Number(trimmed) * 1_000;
    const date = Date.parse(trimmed);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
/** Build the breaker signal from a 429 response's headers. */
export function rateLimitSignalFromHeaders(headers) {
    const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));
    return retryAfterMs === undefined ? { kind: 'rate-limit' } : { kind: 'rate-limit', retryAfterMs };
}
/** One resolved credential per operation; `undefined`/empty is a failure. */
export async function resolveCredential(resolveApiKey, credentialName, label) {
    const apiKey = await resolveApiKey();
    if (apiKey === undefined || apiKey.length === 0) {
        throw new WebError(`${label} credential "${credentialName}" is not configured`, 'WEB_PROVIDER_ERROR');
    }
    return apiKey;
}
/**
 * Classify a transport-level failure into the seam's shared codes: an aborted
 * outer signal is `WEB_ABORTED`; the internal deadline and everything else
 * (DNS/TLS/socket failures) are `WEB_PROVIDER_ERROR`. `label` is the
 * operation name (`Zhipu web search` / `Zhipu reader`), so failure messages
 * stay operation-specific without duplicating this logic.
 */
export function classifyTransportFailure(error, outer, deadline, timeoutMs, label) {
    if (outer?.aborted === true) {
        return new WebError(`${label} aborted`, 'WEB_ABORTED', { cause: error });
    }
    if (deadline.aborted) {
        return new WebError(`${label} timed out after ${timeoutMs} ms`, 'WEB_PROVIDER_ERROR', {
            cause: error,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new WebError(`${label} request failed: ${message}`, 'WEB_PROVIDER_ERROR', { cause: error });
}
/**
 * Narrow a raw error-body text into {@link UpstreamErrorBody}. Never throws;
 * unreadable or shapeless bodies yield `undefined`. Codes are stringified so
 * the numeric API spellings (`1701`) and quoted ones (`"1701"`) compare equal.
 */
export function parseUpstreamErrorBody(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const record = readRecord(readRecord(payload)?.error);
    if (record === undefined)
        return undefined;
    const rawCode = record.code;
    const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
        ? String(rawCode)
        : readNonEmptyString(rawCode);
    const rawMessage = readNonEmptyString(record.message);
    const message = rawMessage === undefined ? undefined : truncateToCodePoints(rawMessage, MAX_UPSTREAM_ERROR_CHARS);
    return code === undefined && message === undefined ? undefined : { code, message };
}
/**
 * Format a bounded `(code …): message` suffix from a parsed upstream error
 * body (`{"error":{"code","message"}}`). Unreadable bodies yield `''`.
 */
export function formatUpstreamErrorDetail(body) {
    if (body === undefined)
        return '';
    const codePart = body.code === undefined ? '' : ` (code ${body.code})`;
    const messagePart = body.message === undefined ? '' : `: ${body.message}`;
    return codePart === '' && messagePart === '' ? '' : `${codePart}${messagePart}`;
}
/**
 * Extract a bounded `(code …): message` suffix from a raw upstream error body
 * text. Never throws; unreadable bodies yield `''`.
 */
export function extractUpstreamErrorDetail(text) {
    return formatUpstreamErrorDetail(parseUpstreamErrorBody(text));
}
/**
 * Read a failed response's body text leniently — callers treat an unreadable
 * body as "no detail". Only a read that fails like a transport error throws.
 */
export async function readFailureBodyText(response, outer, deadline, timeoutMs, label) {
    try {
        return await response.text();
    }
    catch (error) {
        throw classifyTransportFailure(error, outer, deadline, timeoutMs, label);
    }
}
/**
 * Read a 2xx response's JSON envelope. Malformed bodies are provider errors:
 * unparseable → `${label} returned an unreadable JSON body`; non-object →
 * `${label} returned a non-object response body`.
 */
export async function readJsonEnvelope(response, outer, deadline, timeoutMs, label) {
    let text;
    try {
        text = await response.text();
    }
    catch (error) {
        throw classifyTransportFailure(error, outer, deadline, timeoutMs, label);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch (error) {
        throw new WebError(`${label} returned an unreadable JSON body`, 'WEB_PROVIDER_ERROR', {
            cause: error,
        });
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new WebError(`${label} returned a non-object response body`, 'WEB_PROVIDER_ERROR');
    }
    return payload;
}
