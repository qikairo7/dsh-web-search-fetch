import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { EngineHttp, additionalBreakerSignal } from './http.js';
import { adapt } from './adapters.js';
import { budgetedFetch } from '../../request-budget.js';
export { githubPath } from './adapters.js';
export { additionalBreakerSignal } from './http.js';
export const ADDITIONAL_ENGINE_DEFAULTS = {
    tavily: { apiKeyEnv: 'TAVILY_API_KEY', baseURL: 'https://api.tavily.com' },
    exa: { apiKeyEnv: 'EXA_API_KEY', baseURL: 'https://api.exa.ai' },
    keenable: { apiKeyEnv: 'KEENABLE_API_KEY', baseURL: 'https://api.keenable.ai' },
    crawl4ai: { apiKeyEnv: 'CRAWL4AI_API_KEY', baseURL: 'https://api.crawl4ai.com' },
    github: { apiKeyEnv: 'GITHUB_TOKEN', baseURL: 'https://api.github.com' },
    firecrawl: { apiKeyEnv: 'FIRECRAWL_API_KEY', baseURL: 'https://api.firecrawl.dev' },
    tinyfish: { apiKeyEnv: 'TINYFISH_API_KEY', baseURL: 'https://api.search.tinyfish.ai', fetchBaseURL: 'https://api.fetch.tinyfish.ai' },
    serply: { apiKeyEnv: 'SERPLY_API_KEY', baseURL: 'https://api.serply.io' },
    kimi: { apiKeyEnv: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn' },
    // Bing RSS is anonymous; its resolver is never invoked.
    bing: { apiKeyEnv: '', baseURL: 'https://cn.bing.com' },
    aihot: { apiKeyEnv: '', baseURL: 'https://aihot.news' },
};
export function createAdditionalEngines(config, resolveCredential, options) {
    return Object.entries(config).flatMap(([name, settings]) => {
        if (!Object.hasOwn(ADDITIONAL_ENGINE_DEFAULTS, name))
            throw new Error(`unknown engine: ${name}`);
        if (settings.enabled === false)
            return [];
        const id = name;
        const defaults = ADDITIONAL_ENGINE_DEFAULTS[id];
        const apiKeyEnv = settings.apiKeyEnv ?? defaults.apiKeyEnv;
        const makeHttp = (ref, timeoutMs, baseURL) => new EngineHttp({
            id, baseURL, timeoutMs,
            resolveApiKey: () => resolveCredential(credentialRef(ref)),
            auth: id === 'bing' || id === 'aihot' ? 'none' : ['exa', 'keenable', 'tinyfish', 'serply'].includes(id) ? 'x-api-key' : 'bearer',
            ...(id === 'bing' ? { accept: 'application/rss+xml, application/xml, text/xml' } : {}),
            fetchImpl: budgetedFetch(options.fetchImpl),
        });
        const search = makeHttp(apiKeyEnv, options.searchTimeoutMs, settings.baseURL ?? defaults.baseURL);
        const fetch = makeHttp(apiKeyEnv, options.fetchTimeoutMs, settings.fetchBaseURL ?? (id === 'tinyfish' ? ADDITIONAL_ENGINE_DEFAULTS.tinyfish.fetchBaseURL : settings.baseURL ?? defaults.baseURL));
        return [adapt(id, search, fetch, settings)];
    });
}
export function additionalExtractionLegs(engines, url) {
    return engines.filter(engine => engine.extract !== undefined && (engine.supportsUrl?.(url) ?? true)).map(engine => ({
        engineId: engine.id, extract: engine.extract, signalOf: additionalBreakerSignal,
    }));
}
