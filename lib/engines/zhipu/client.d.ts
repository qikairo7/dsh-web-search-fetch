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
import type { WebSearchResult } from '@deepseek-ai/dsh-web';
import type { ZhipuAnthropicResponse, ZhipuContentSize, ZhipuSearchEngine, ZhipuSearchRequest, ZhipuSearchResponse, ZhipuSearchTransport } from '../../types.js';
import { extractUpstreamErrorDetail } from './transport.js';
export { extractUpstreamErrorDetail };
export interface ZhipuClientOptions {
    /** Resolve the API key once per operation; `undefined` means unconfigured. Never cached. */
    resolveApiKey: () => Promise<string | undefined>;
    /** Credential reference name used in error messages (the value never appears). */
    credentialName: string;
    /**
     * Which transport serves {@link ZhipuClient.searchSeam}; defaults to
     * `anthropic` (the Coding Plan route). Unrecognized values fall back too.
     *
     * A fixed choice. Callers whose transport can change while the client lives
     * — the settings page edits it — pass {@link ZhipuClientOptions.resolveTransport}
     * instead, so each operation reads the current value.
     */
    transport?: ZhipuSearchTransport;
    /**
     * Live transport reader, consulted once per operation and taking precedence
     * over {@link ZhipuClientOptions.transport}.
     *
     * The settings page edits the transport, and a volatile config field is
     * committed into the running reference rather than remounting the plugin. A
     * client that captured the value at construction would therefore keep
     * dispatching to the channel the user just switched away from.
     * @returns the current choice, or `undefined` while unset (the default then applies).
     */
    resolveTransport?: () => ZhipuSearchTransport | undefined;
    /** Search engine tier for the tools-api channel; defaults to `search_pro`. */
    searchEngine?: ZhipuSearchEngine;
    /** Snippet granularity for the tools-api channel; defaults to `medium`. */
    contentSize?: ZhipuContentSize;
    /** tools-api endpoint override (tests point this at a local mock server). */
    baseURL?: string;
    /** Messages base URL override; defaults to the public Anthropic-compatible base. */
    anthropicBaseURL?: string;
    /** GLM model for the Messages route; defaults to `glm-4.6`. */
    anthropicModel?: string;
    /** Generated-token bound for the Messages route; defaults to 1024. */
    anthropicMaxTokens?: number;
    /** Server-tool invocation bound for the Messages route; defaults to 1. */
    anthropicMaxUses?: number;
    /**
     * Per-request deadline; defaults to the documented single-engine budget. On
     * the `anthropic` transport this is the budget to the early-close point
     * (connection included); it is not restarted by the non-streaming fallback.
     */
    timeoutMs?: number;
    /** `fetch` implementation override for focused tests. */
    fetchImpl?: typeof fetch;
}
export declare class ZhipuClient {
    private readonly baseURL;
    private readonly anthropicBaseURL;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private readonly resolveApiKey;
    private readonly credentialName;
    private readonly resolveTransportOption;
    private readonly searchEngine;
    private readonly contentSize;
    private readonly anthropicModel;
    private readonly anthropicMaxTokens;
    private readonly anthropicMaxUses;
    constructor(options: ZhipuClientOptions);
    /** Search engine tier this client is configured with (resolved, never raw). */
    get configuredSearchEngine(): ZhipuSearchEngine;
    /** Snippet granularity this client is configured with (resolved, never raw). */
    get configuredContentSize(): ZhipuContentSize;
    /**
     * Transport {@link searchSeam} dispatches to (resolved, never raw).
     *
     * Read per call rather than cached, so a settings-page edit reaches the next
     * search without restarting the plugin.
     */
    get configuredTransport(): ZhipuSearchTransport;
    /** GLM model this client sends on the Messages route (resolved). */
    get configuredAnthropicModel(): string;
    /** Server-tool invocation bound this client sends on the Messages route (resolved). */
    get configuredAnthropicMaxUses(): number;
    /** Messages base URL this client sends to (resolved). */
    get configuredAnthropicBaseURL(): string;
    /**
     * Run one seam-shaped search through the configured transport and map the
     * response into seam sources — the one-call entry point for the provider
     * layer, which never needs to know which channel served the query.
     */
    searchSeam(query: string, maxResults?: number, signal?: AbortSignal): Promise<WebSearchResult>;
    /**
     * Build the tools-api wire request from this client's configured engine
     * options and run it. {@link search} stays available for callers that
     * already hold a complete wire request.
     */
    searchQuery(query: string, maxResults?: number, signal?: AbortSignal): Promise<ZhipuSearchResponse>;
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
    searchAnthropic(query: string, signal?: AbortSignal): Promise<ZhipuAnthropicResponse>;
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
    private tryStreamAnthropic;
    /** Drain a response body we are not going to use, so the socket can be reused. */
    private discardBody;
    /** One web_search call on the tools API. Throws {@link WebError} on every failure path. */
    search(request: ZhipuSearchRequest, signal?: AbortSignal): Promise<ZhipuSearchResponse>;
    /**
     * The shared transport: credential resolution, deadline composition, one
     * POST, and the status/body classification both channels share. Only the
     * extra headers differ per channel.
     *
     * `reuse` lets the streaming channel hand in the deadline it already started
     * (and the credential it already resolved), so a fallback retry neither
     * doubles the operation's time budget nor resolves the credential twice.
     */
    private post;
    /**
     * Non-2xx: keep the upstream `error.code`/`error.message` in the failure
     * message. A 429 additionally attaches the rate-limit circuit-breaker
     * signal as the error's `cause` (DESIGN.md: Zhipu trips on 429).
     */
    private errorFromResponse;
}
/**
 * Back-compat wrapper (re-exported by the package entry): classify a
 * transport failure with the search operation's wording. New call sites use
 * {@link classifyTransportFailure} directly with their own label.
 */
export declare function translateTransportFailure(error: unknown, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number): WebError;
