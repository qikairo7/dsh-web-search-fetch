/** Why a rerank call degraded to `null`; reported through `onDegrade` only. */
export type RerankDegradeReason = 'empty-query' | 'empty-documents' | 'credential-missing' | 'credential-error' | 'timeout' | 'http-error' | 'unreadable-body' | 'unusable-results' | 'transport-error';
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
export declare class RerankClient {
    private readonly baseURL;
    private readonly timeoutMs;
    private readonly fetchImpl;
    private readonly resolveApiKey;
    private readonly credentialName;
    private readonly onDegrade;
    constructor(options: RerankClientOptions);
    /**
     * Rerank `documents` against `query` and return the reordered index sequence
     * (a full permutation of the input positions, best first), or `null` when the
     * engine is unusable and the caller should keep its current order.
     *
     * @throws WebError with code `WEB_ABORTED` when `signal` is already aborted
     * or aborts mid-flight. That is the only throwing path.
     */
    rerank(query: string, documents: readonly string[], topN: number, signal?: AbortSignal): Promise<number[] | null>;
    /** Record a degrade and return the degrade signal (`null`). */
    private degrade;
}
