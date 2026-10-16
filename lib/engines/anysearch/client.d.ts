import { type AnySearchExtractRequest, type AnySearchExtractResponse, type AnySearchSearchRequest, type AnySearchSearchResponse } from './wire.js';
import type { AnySearchDomainsResponse, AnySearchSubDomainsResponse } from './types.js';
/** Options for {@link AnySearchClient}. Every field has a default except the resolver. */
export interface AnySearchClientOptions {
    /**
     * Resolve the API key for one operation. Called afresh on every operation and
     * never cached. `undefined` or an empty string means "unconfigured": the
     * official search/extract endpoints use anonymous quota; custom endpoints and
     * domain discovery still require a credential.
     */
    resolveApiKey: () => Promise<string | undefined>;
    /** Credential reference name used in error messages. The value never appears. */
    credentialName?: string;
    /** API base URL. Defaults to the public origin; the pathname is preserved. */
    baseURL?: string;
    /** Per-operation transport deadline. Defaults to the documented extract budget. */
    timeoutMs?: number;
    /** `fetch` implementation override, for focused tests. */
    fetchImpl?: typeof fetch;
}
export declare class AnySearchClient {
    private readonly resolveApiKey;
    private readonly credentialName;
    private readonly baseURL;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: AnySearchClientOptions);
    /**
     * Whether the configured base URL can produce public HTTP endpoints. A local
     * check only — it never makes a network call, as the seam requires.
     */
    available(): boolean;
    /**
     * Run one search. `query` is passed through untruncated (the API documents no
     * length cap); `maxResults` becomes `max_results` only when supplied, so an
     * unbounded request leaves the API's own default in place.
     */
    search(request: AnySearchSearchRequest, signal?: AbortSignal): Promise<AnySearchSearchResponse>;
    /** Extract and validate the cleaned content of one public HTTP(S) URL. */
    extract(request: AnySearchExtractRequest, signal?: AbortSignal): Promise<AnySearchExtractResponse>;
    listDomains(signal?: AbortSignal): Promise<AnySearchDomainsResponse>;
    getSubDomains(domains: readonly string[], signal?: AbortSignal): Promise<AnySearchSubDomainsResponse>;
    /** Run the value parser over an envelope, re-classifying a shape failure. */
    private parseData;
    /**
     * One HTTP round trip plus envelope validation. The only place `fetch` is
     * called, so every failure path funnels through the classifiers below.
     */
    private request;
    /**
     * Resolve the credential for one operation. Never cached. An empty or blank
     * value reads as "unconfigured"; a value equal to the credential reference
     * name or to a documented placeholder is refused outright.
     */
    private resolveCredential;
    /**
     * Classify a failure that happened before or around the response body: a
     * caller abort, the engine deadline, or a transport fault. Passing
     * `httpStatus` covers a body that arrived but could not be parsed.
     */
    private transportFailure;
}
