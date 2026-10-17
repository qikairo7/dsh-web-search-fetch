import type { WebFetchResult, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import type { ResolveCredential } from '../../search-pipeline.js';
import { additionalBreakerSignal } from './http.js';
export { githubPath } from './adapters.js';
export { additionalBreakerSignal } from './http.js';
export declare const ADDITIONAL_ENGINE_DEFAULTS: {
    readonly deepseek: {
        readonly apiKeyEnv: "DEEPSEEK_API_KEY";
        readonly baseURL: "https://api.deepseek.com/v1/tools";
    };
    readonly tavily: {
        readonly apiKeyEnv: "TAVILY_API_KEY";
        readonly baseURL: "https://api.tavily.com";
    };
    readonly exa: {
        readonly apiKeyEnv: "EXA_API_KEY";
        readonly baseURL: "https://api.exa.ai";
    };
    readonly keenable: {
        readonly apiKeyEnv: "KEENABLE_API_KEY";
        readonly baseURL: "https://api.keenable.ai";
    };
    readonly crawl4ai: {
        readonly apiKeyEnv: "CRAWL4AI_API_KEY";
        readonly baseURL: "https://api.crawl4ai.com";
    };
    readonly github: {
        readonly apiKeyEnv: "GITHUB_TOKEN";
        readonly baseURL: "https://api.github.com";
    };
    readonly firecrawl: {
        readonly apiKeyEnv: "FIRECRAWL_API_KEY";
        readonly baseURL: "https://api.firecrawl.dev";
    };
    readonly tinyfish: {
        readonly apiKeyEnv: "TINYFISH_API_KEY";
        readonly baseURL: "https://api.search.tinyfish.ai";
        readonly fetchBaseURL: "https://api.fetch.tinyfish.ai";
    };
    readonly serply: {
        readonly apiKeyEnv: "SERPLY_API_KEY";
        readonly baseURL: "https://api.serply.io";
    };
    readonly kimi: {
        readonly apiKeyEnv: "MOONSHOT_API_KEY";
        readonly baseURL: "https://api.moonshot.cn";
    };
    readonly bing: {
        readonly apiKeyEnv: "";
        readonly baseURL: "https://cn.bing.com";
    };
    readonly aihot: {
        readonly apiKeyEnv: "";
        readonly baseURL: "https://aihot.news";
    };
};
export type AdditionalEngineId = keyof typeof ADDITIONAL_ENGINE_DEFAULTS;
export interface AdditionalEngineConfig {
    enabled?: boolean;
    apiKeyEnv?: string;
    baseURL?: string;
    /** TinyFish uses a separate Fetch API origin; other engines share their search origin. */
    fetchBaseURL?: string;
    /** Kimi REST search tier; one tier per query, not two independent sources. */
    searchMode?: 'basic' | 'pro';
}
export type AdditionalEnginesConfig = Partial<Record<AdditionalEngineId, AdditionalEngineConfig>>;
export interface AdditionalEngine {
    id: AdditionalEngineId;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    extract?(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
    supportsUrl?(url: string): boolean;
    /** Structured vendor API reading precedes generic extraction; undefined means no matching API. */
    readApi?(url: string, signal?: AbortSignal): Promise<WebFetchResult | undefined>;
}
export declare function createAdditionalEngines(config: AdditionalEnginesConfig, resolveCredential: ResolveCredential, options: {
    searchTimeoutMs: number;
    fetchTimeoutMs: number;
    fetchImpl?: typeof fetch;
}): AdditionalEngine[];
export declare function additionalExtractionLegs(engines: readonly AdditionalEngine[], url: string): {
    engineId: "tinyfish" | "bing" | "github" | "aihot" | "firecrawl" | "tavily" | "exa" | "deepseek" | "keenable" | "crawl4ai" | "serply" | "kimi";
    extract: (url: string, signal?: AbortSignal) => Promise<WebFetchResult>;
    signalOf: typeof additionalBreakerSignal;
}[];
