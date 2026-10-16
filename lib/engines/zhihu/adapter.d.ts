import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import { ZhihuClient, type ZhihuClientOptions } from './client.js';
import type { ZhihuQuota } from './types.js';
export declare class ZhihuEngine {
    private readonly client;
    constructor(client: ZhihuClient);
    /** Today's quota for `global_search`; `undefined` when unreadable. */
    quota(signal?: AbortSignal): Promise<ZhihuQuota | undefined>;
    /**
     * Run one search and map it to seam sources. A failure that already carries a
     * seam code is rethrown untouched (so a breaker still sees its
     * `ZhihuCircuitSignal`); anything else is wrapped as a provider error, the
     * same way the Zhipu engine's provider boundary does it.
     */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
/** Build the engine from the same options the client takes. */
export declare function createZhihuEngine(options: ZhihuClientOptions): ZhihuEngine;
