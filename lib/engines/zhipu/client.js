/**
 * Zhipu web_search HTTP client — the engine transport for the skeleton's
 * single-engine search passthrough. Every failure path throws a `WebError`
 * carrying one of the seam's shared codes (`WEB_PROVIDER_ERROR`,
 * `WEB_ABORTED`), so the provider layer adds no translation of its own.
 * Transport helpers live in `./transport.js`.
 *
 * Two transports serve the same seam operation (issue #12):
 *
 * - `anthropic` (the default): `POST {anthropicBaseURL}/messages` with the
 *   Anthropic Messages body and the `web_search_20250305` server tool. This
 *   route bills the GLM Coding Plan quota instead of the per-call tools API.
 * - `tools-api`: `POST {baseURL}` (`/paas/v4/web_search`) with the tools API
 *   body, including the 70-character query cap.
 *
 * Channel selection is invisible to the pipeline: {@link ZhipuClient.searchSeam}
 * dispatches, and both channels fail with the same `WebError` codes and the
 * same 429 breaker signal on `cause`.
 * @module engines/zhipu/client
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { ZHIPU_ANTHROPIC_API_VERSION, ZHIPU_DEFAULT_CONTENT_SIZE, ZHIPU_DEFAULT_SEARCH_ENGINE, ZHIPU_SEARCH_TIMEOUT_MS, ZHIPU_WEB_SEARCH_URL, } from '../../limits.js';
import { buildZhipuAnthropicEndpoint, buildZhipuAnthropicRequest, mapZhipuAnthropicResponse, resolveZhipuAnthropicBaseURL, resolveZhipuAnthropicMaxTokens, resolveZhipuAnthropicMaxUses, resolveZhipuAnthropicModel, resolveZhipuSearchTransport, } from './anthropic-wire.js';
import { createZhipuAnthropicStreamAssembler, createZhipuSseDecoder, isZhipuEventStream, } from './anthropic-stream.js';
import { buildZhipuSearchRequest, mapZhipuSearchResponse, resolveZhipuContentSize, resolveZhipuSearchEngine, } from './wire.js';
import { classifyTransportFailure, extractUpstreamErrorDetail, rateLimitSignalFromHeaders, readFailureBodyText, readJsonEnvelope, resolveCredential, } from './transport.js';
export { extractUpstreamErrorDetail };
/** Operation name used in every failure message of this client. */
const SEARCH_LABEL = 'Zhipu web search';
export class ZhipuClient {
    baseURL;
    anthropicBaseURL;
    timeoutMs;
    fetchImpl;
    resolveApiKey;
    credentialName;
    resolveTransportOption;
    searchEngine;
    contentSize;
    anthropicModel;
    anthropicMaxTokens;
    anthropicMaxUses;
    constructor(options) {
        this.baseURL = options.baseURL ?? ZHIPU_WEB_SEARCH_URL;
        this.anthropicBaseURL = resolveZhipuAnthropicBaseURL(options.anthropicBaseURL);
        this.timeoutMs = options.timeoutMs ?? ZHIPU_SEARCH_TIMEOUT_MS;
        this.resolveApiKey = options.resolveApiKey;
        this.credentialName = options.credentialName;
        // Runtime values are narrowed, not trusted (config strings are untyped).
        // A live reader wins over the fixed value: only it can observe an edit made
        // while this client is alive.
        this.resolveTransportOption =
            options.resolveTransport ??
                (() => options.transport);
        this.searchEngine = resolveZhipuSearchEngine(options.searchEngine ?? ZHIPU_DEFAULT_SEARCH_ENGINE);
        this.contentSize = resolveZhipuContentSize(options.contentSize ?? ZHIPU_DEFAULT_CONTENT_SIZE);
        this.anthropicModel = resolveZhipuAnthropicModel(options.anthropicModel);
        this.anthropicMaxTokens = resolveZhipuAnthropicMaxTokens(options.anthropicMaxTokens);
        this.anthropicMaxUses = resolveZhipuAnthropicMaxUses(options.anthropicMaxUses);
        // Deferred lookup keeps `globalThis.fetch` patchable in tests.
        this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    }
    /** Search engine tier this client is configured with (resolved, never raw). */
    get configuredSearchEngine() {
        return this.searchEngine;
    }
    /** Snippet granularity this client is configured with (resolved, never raw). */
    get configuredContentSize() {
        return this.contentSize;
    }
    /**
     * Transport {@link searchSeam} dispatches to (resolved, never raw).
     *
     * Read per call rather than cached, so a settings-page edit reaches the next
     * search without restarting the plugin.
     */
    get configuredTransport() {
        return resolveZhipuSearchTransport(this.resolveTransportOption());
    }
    /** GLM model this client sends on the Messages route (resolved). */
    get configuredAnthropicModel() {
        return this.anthropicModel;
    }
    /** Server-tool invocation bound this client sends on the Messages route (resolved). */
    get configuredAnthropicMaxUses() {
        return this.anthropicMaxUses;
    }
    /** Messages base URL this client sends to (resolved). */
    get configuredAnthropicBaseURL() {
        return this.anthropicBaseURL;
    }
    /**
     * Run one seam-shaped search through the configured transport and map the
     * response into seam sources — the one-call entry point for the provider
     * layer, which never needs to know which channel served the query.
     */
    async searchSeam(query, maxResults, signal) {
        if (this.configuredTransport === 'tools-api') {
            return mapZhipuSearchResponse(await this.searchQuery(query, maxResults, signal));
        }
        return mapZhipuAnthropicResponse(await this.searchAnthropic(query, signal));
    }
    /**
     * Build the tools-api wire request from this client's configured engine
     * options and run it. {@link search} stays available for callers that
     * already hold a complete wire request.
     */
    async searchQuery(query, maxResults, signal) {
        return await this.search(buildZhipuSearchRequest(query, maxResults, {
            searchEngine: this.searchEngine,
            contentSize: this.contentSize,
        }), signal);
    }
    /**
     * One Messages call on the Anthropic-compatible route, streaming with early
     * close (issue #14). The query goes in verbatim: the tools API's
     * 70-character cap is that channel's own limit and must not silently rewrite
     * what the model is asked to search for.
     *
     * The call asks for `stream: true` and stops reading the moment the
     * search-result block is complete — the endpoint finishes every content
     * block in ~6 s but only sends `message_stop` at ~22 s, and the seam has no
     * consumer for the generated answer. Three conditions lead back to the plain
     * JSON request instead: a response that is not an SSE stream, a stream that
     * fails to parse, and a stream that breaks before `message_stop`. Each
     * re-issues the request once, without `stream`. A stream that does reach
     * `message_stop` with no result block is a complete answer — the model ran
     * no search — and takes the mapping layer's empty path without a retry.
     *
     * `timeoutMs` is the budget to that early-close point, connection included,
     * and is measured from the start of the first attempt: the fallback retry
     * shares the caller's original deadline rather than starting a fresh one.
     */
    async searchAnthropic(query, signal) {
        if (signal?.aborted === true) {
            throw new WebError(`${SEARCH_LABEL} aborted`, 'WEB_ABORTED', { cause: signal.reason });
        }
        const apiKey = await resolveCredential(this.resolveApiKey, this.credentialName, SEARCH_LABEL);
        const endpoint = buildZhipuAnthropicEndpoint(this.anthropicBaseURL);
        const params = {
            model: this.anthropicModel,
            maxTokens: this.anthropicMaxTokens,
            maxUses: this.anthropicMaxUses,
        };
        const deadline = AbortSignal.timeout(this.timeoutMs);
        const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
        const streamed = await this.tryStreamAnthropic(endpoint, buildZhipuAnthropicRequest(query, params), apiKey, signal, deadline, composed);
        if (streamed !== undefined)
            return streamed;
        return (await this.post(endpoint, buildZhipuAnthropicRequest(query, { ...params, stream: false }), signal, { 'anthropic-version': ZHIPU_ANTHROPIC_API_VERSION }, { deadline, composed, apiKey }));
    }
    /**
     * The streaming attempt. Returns the assembled response when the stream
     * carried a search-result block (the early close) or ran to `message_stop`,
     * and `undefined` when the caller should fall back to the non-streaming
     * request. It throws for every failure that is not a fallback (429 and other
     * non-2xx statuses, abort, timeout, credential resolution) so those keep
     * their existing semantics.
     *
     * The body is consumed through the ReadableStream reader because the
     * early-close decision has to be made mid-body: the point of the ticket is
     * to stop reading, which `response.text()` cannot express.
     */
    async tryStreamAnthropic(endpoint, request, apiKey, outer, deadline, composed) {
        let response;
        try {
            response = await this.fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'anthropic-version': ZHIPU_ANTHROPIC_API_VERSION,
                    authorization: `Bearer ${apiKey}`,
                    'content-type': 'application/json',
                    accept: 'text/event-stream',
                },
                body: JSON.stringify(request),
                signal: composed,
            });
        }
        catch (error) {
            throw classifyTransportFailure(error, outer, deadline, this.timeoutMs, SEARCH_LABEL);
        }
        if (!response.ok)
            throw await this.errorFromResponse(response, outer, deadline);
        if (!isZhipuEventStream(response.headers.get('content-type'))) {
            // Not a stream after all; let the caller's plain JSON request answer.
            await this.discardBody(response);
            return undefined;
        }
        const body = response.body;
        if (body === null)
            return undefined;
        const decoder = createZhipuSseDecoder();
        const assembler = createZhipuAnthropicStreamAssembler();
        const reader = body.getReader();
        const textDecoder = new TextDecoder();
        let sawResult = false;
        let sawMessageStop = false;
        try {
            read: for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    for (const frame of decoder.flush()) {
                        const outcome = assembler.push(frame);
                        if (outcome.kind === 'result') {
                            sawResult = true;
                            break read;
                        }
                        if (outcome.kind === 'failure')
                            return undefined;
                        if (outcome.kind === 'end')
                            sawMessageStop = true;
                    }
                    break;
                }
                for (const frame of decoder.push(textDecoder.decode(value, { stream: true }))) {
                    const outcome = assembler.push(frame);
                    if (outcome.kind === 'result') {
                        sawResult = true;
                        break read;
                    }
                    if (outcome.kind === 'failure')
                        return undefined;
                    if (outcome.kind === 'end')
                        sawMessageStop = true;
                }
            }
        }
        catch (error) {
            // A deadline or outer abort during a read keeps its own semantics.
            // Anything else means the stream broke mid-message: we cannot claim the
            // model ran no search, so the caller's JSON request settles it.
            if (outer?.aborted === true || deadline.aborted) {
                throw classifyTransportFailure(error, outer, deadline, this.timeoutMs, SEARCH_LABEL);
            }
            return undefined;
        }
        finally {
            // The early close: `break read` lands here with the connection open, and
            // cancelling the reader is what actually stops the upstream generation.
            await reader.cancel().catch(() => undefined);
        }
        if (sawResult)
            return { content: [...assembler.snapshot()] };
        if (sawMessageStop) {
            // The stream ran to its natural end without a result block: the model
            // ran no search. Handing the accumulated blocks to the existing mapping
            // layer reaches that layer's empty path (`{sources: []}`) without a
            // second request.
            return { content: [...assembler.snapshot()] };
        }
        // Ended without `message_stop` — an incomplete message rather than an
        // answer. A second, non-streaming request settles what really happened;
        // reporting an empty result here would claim a search that never ran.
        return undefined;
    }
    /** Drain a response body we are not going to use, so the socket can be reused. */
    async discardBody(response) {
        try {
            await response.arrayBuffer();
        }
        catch {
            // A body that cannot be drained is not worth failing the operation over;
            // the caller's fallback request is about to open its own connection.
        }
    }
    /** One web_search call on the tools API. Throws {@link WebError} on every failure path. */
    async search(request, signal) {
        return (await this.post(this.baseURL, request, signal));
    }
    /**
     * The shared transport: credential resolution, deadline composition, one
     * POST, and the status/body classification both channels share. Only the
     * extra headers differ per channel.
     *
     * `reuse` lets the streaming channel hand in the deadline it already started
     * (and the credential it already resolved), so a fallback retry neither
     * doubles the operation's time budget nor resolves the credential twice.
     */
    async post(endpoint, body, signal, extraHeaders = {}, reuse) {
        if (signal?.aborted === true) {
            throw new WebError(`${SEARCH_LABEL} aborted`, 'WEB_ABORTED', { cause: signal.reason });
        }
        const apiKey = reuse?.apiKey ?? (await resolveCredential(this.resolveApiKey, this.credentialName, SEARCH_LABEL));
        const deadline = reuse?.deadline ?? AbortSignal.timeout(this.timeoutMs);
        const composed = reuse?.composed ?? (signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
        let response;
        try {
            response = await this.fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    ...extraHeaders,
                    authorization: `Bearer ${apiKey}`,
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: JSON.stringify(body),
                signal: composed,
            });
        }
        catch (error) {
            throw classifyTransportFailure(error, signal, deadline, this.timeoutMs, SEARCH_LABEL);
        }
        if (!response.ok)
            throw await this.errorFromResponse(response, signal, deadline);
        return await readJsonEnvelope(response, signal, deadline, this.timeoutMs, SEARCH_LABEL);
    }
    /**
     * Non-2xx: keep the upstream `error.code`/`error.message` in the failure
     * message. A 429 additionally attaches the rate-limit circuit-breaker
     * signal as the error's `cause` (DESIGN.md: Zhipu trips on 429).
     */
    async errorFromResponse(response, outer, deadline) {
        const text = await readFailureBodyText(response, outer, deadline, this.timeoutMs, SEARCH_LABEL);
        const detail = extractUpstreamErrorDetail(text);
        const message = `Zhipu web search failed with HTTP ${response.status}${detail}`;
        if (response.status === 429) {
            return new WebError(message, 'WEB_PROVIDER_ERROR', {
                cause: rateLimitSignalFromHeaders(response.headers),
            });
        }
        return new WebError(message, 'WEB_PROVIDER_ERROR');
    }
}
/**
 * Back-compat wrapper (re-exported by the package entry): classify a
 * transport failure with the search operation's wording. New call sites use
 * {@link classifyTransportFailure} directly with their own label.
 */
export function translateTransportFailure(error, outer, deadline, timeoutMs) {
    return classifyTransportFailure(error, outer, deadline, timeoutMs, SEARCH_LABEL);
}
