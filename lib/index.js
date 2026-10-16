import { isAnySearchKeylessEndpoint, isTavilyKeylessEndpoint } from './keyless.js';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { ZHIPU_ANTHROPIC_BASE_URL, ZHIPU_ANTHROPIC_DEFAULT_MODEL, ZHIPU_ANTHROPIC_MAX_USES, ZHIPU_DEFAULT_API_KEY_ENV, ZHIPU_DEFAULT_SEARCH_TRANSPORT, ZHIPU_WEB_SEARCH_URL, } from './limits.js';
import { ZhipuClient, translateTransportFailure, extractUpstreamErrorDetail } from './engines/zhipu/client.js';
import { ANYSEARCH_DEFAULT_API_KEY_ENV, DEFAULT_RERANK_POOL, DEFAULT_RRF_K, DEFAULT_SEARCH_MAX_FANOUT_MS, SILICONFLOW_DEFAULT_API_KEY_ENV, ZHIHU_DEFAULT_ACCESS_SECRET_ENV, createAggregatedSearchProvider, } from './search-pipeline.js';
import { AggregatedFetchProvider, createExtractionLegs } from './fetch-pipeline.js';
import { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
import { FirecrawlClient } from './engines/firecrawl/client.js';
import { FIRECRAWL_DEFAULT_API_KEY_ENV, FIRECRAWL_SCRAPE_URL, isFirecrawlKeylessEndpoint } from './engines/firecrawl/wire.js';
import { AnySearchEngine } from './engines/anysearch/engine.js';
import { ANYSEARCH_DEFAULT_BASE_URL } from './engines/anysearch/limits.js';
import { RERANK_TIMEOUT_MS, SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
import { ZHIHU_GLOBAL_SEARCH_URL, ZHIHU_QUOTA_URL } from './engines/zhihu/limits.js';
import { DEFAULT_FETCH_ENGINE_TIMEOUT_MS, DEFAULT_STATIC_EXTENSIONS } from './fetch-aggregate.js';
import { createAdditionalEngines } from './engines/additional/index.js';
import { budgetedFetch, currentControls, noteOperation } from './request-budget.js';
import { DecisionClient, decisionFetch } from './engines/decision/client.js';
import { DECISION_MODEL_PROVIDER } from './engines/decision/wire.js';
export { createAdditionalEngines, ADDITIONAL_ENGINE_DEFAULTS } from './engines/additional/index.js';
import { WEB_SEARCH_FETCH_SETTINGS_NAMESPACE, projectEditableSettings, resolveCredentialRef, readVolatile, } from './settings-surface.js';
export { AGGREGATED_PROVIDER_ID, ZHIPU_DEFAULT_API_KEY_ENV, ZHIPU_SEARCH_QUERY_MAX_CHARS, ZHIPU_WEB_SEARCH_URL, } from './limits.js';
export { ANYSEARCH_DEFAULT_BASE_URL } from './engines/anysearch/limits.js';
export { AnySearchClient } from './engines/anysearch/client.js';
export { AnySearchClientError } from './engines/anysearch/error.js';
export { FIRECRAWL_SCRAPE_URL } from './engines/firecrawl/wire.js';
export { RERANK_TIMEOUT_MS, SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
export { ZHIHU_GLOBAL_SEARCH_URL, ZHIHU_QUOTA_URL } from './engines/zhihu/limits.js';
export { ZhipuClient, translateTransportFailure, extractUpstreamErrorDetail } from './engines/zhipu/client.js';
export { buildZhipuSearchRequest, clampZhipuCount, mapZhipuSearchResponse, truncateToCodePoints, } from './engines/zhipu/wire.js';
export { buildZhipuAnthropicEndpoint, buildZhipuAnthropicRequest, isZhipuAnthropicResultBlockType, mapZhipuAnthropicResponse, resolveZhipuAnthropicBaseURL, resolveZhipuAnthropicMaxTokens, resolveZhipuAnthropicMaxUses, resolveZhipuAnthropicModel, resolveZhipuSearchTransport, ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES, } from './engines/zhipu/anthropic-wire.js';
export { createZhipuAnthropicStreamAssembler, createZhipuSseDecoder, isZhipuEventStream, } from './engines/zhipu/anthropic-stream.js';
export { AggregatedSearchProvider, ANYSEARCH_DEFAULT_API_KEY_ENV, ANYSEARCH_ENGINE_ID, DEFAULT_RERANK_POOL, DEFAULT_RRF_K, DEFAULT_SEARCH_MAX_FANOUT_MS, SILICONFLOW_DEFAULT_API_KEY_ENV, ZHIHU_DEFAULT_ACCESS_SECRET_ENV, ZHIHU_ENGINE_ID, ZHIPU_ENGINE_ID, createAggregatedSearchProvider, normalizeSearchUrl, readSearchFailureSignal, rrfFuse, } from './search-pipeline.js';
export { AggregatedFetchProvider, DEFAULT_HTTP_FETCH_LIMITS, createExtractionLegs } from './fetch-pipeline.js';
export { aggregateDynamicFetch, anysearchBreakerSignal, bodyFingerprint, classifyFetchRoute, DEFAULT_ENGINE_WEIGHTS, DEFAULT_FETCH_ENGINE_TIMEOUT_MS, DEFAULT_STATIC_EXTENSIONS, extractBodyTitle, extractUrlSlug, firecrawlBreakerSignal, isUsableCandidate, scoreCandidate, selectBestCandidate, titleSimilarity, } from './fetch-aggregate.js';
export { DecisionClient } from './engines/decision/client.js';
export { DECISION_MODEL_PROVIDER, buildDecisionRequest, parseDecisionDepth } from './engines/decision/wire.js';
export { ALIBABA_DECISION_URL, DECISION_TIMEOUT_MS, SILICONFLOW_SYSTEMONE_URL, TYPESAFE_JEV_URL } from './engines/decision/limits.js';
export { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-fetch';
/** Required services: web providers and per-operation credentials. */
export const inject = ['web', 'credentials'];
export { WEB_SEARCH_FETCH_SETTINGS_NAMESPACE };
export const Config = z.object({
    controls: z.object({
        serviceEnabled: z.dict(z.boolean()).default({}).description('服务总开关；关闭后不派发该服务，保留各能力的参与范围。'),
        mode: z.union(['organize', 'select']).default('organize').description('正文整理；select 为旧版单份正文模式。'),
        preset: z.union(['auto', 'custom', 'free', 'balanced', 'deep']).default('auto').description('自动按请求判断覆盖范围；也可固定为自定义、免费、均衡（最多三路）或深度检索。免费仍可能需要凭证。'),
        searchServices: z.array(z.string()).default(['anysearch', 'zhipu', 'zhihu', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'qianfan', 'doubao', 'firecrawl', 'tinyfish', 'serply', 'kimi', 'bing', 'aihot']).description('搜索服务 ID 与调用优先级；空数组不调用搜索服务。'),
        fetchServices: z.array(z.string()).default(['firecrawl', 'anysearch', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'doubao', 'tinyfish', 'serply', 'kimi', 'aihot']).description('提取服务 ID 与调用优先级；HTTP 静态路径不受此列表控制。'),
        maxSearchServices: z.natural().min(1).max(16).default(16).description('每个查询最多调用的搜索服务数。'),
        maxFetchServices: z.natural().min(1).max(11).default(11).description('每个 URL 最多调用的普通提取服务数。'),
        maxRequests: z.natural().min(1).max(256).default(32).description('每次 provider 操作的插件 HTTP 请求上限，包含额度查询、重试和重排；不含宿主 HTTP 重定向。'),
        searchDeadlineMs: z.natural().min(1).max(3600000).default(15000).description('搜索操作总限时，毫秒。'),
        fetchDeadlineMs: z.natural().min(1).max(3600000).default(50000).description('提取操作总限时，毫秒。'),
        maxOutputChars: z.natural().min(1000).max(1000000).default(100000).description('正文整理输出上限，按完整内容块保留，包含来源与差异说明。'),
    }).default({}).volatile().description('正文整理与操作调用控制，保存后下一次调用生效。'),
    engines: z.dict(z.object({
        enabled: z.boolean().default(true).description('是否将此服务加入搜索与可用的提取管线。'),
        apiKeyEnv: z.string().role('credential-ref').description('凭证引用名；省略时使用该服务默认引用。'),
        fetchApiKeyEnv: z.string().role('credential-ref').description('豆包提取凭证引用；默认 DOUBAO_FETCH_API_KEY。其他服务沿用 apiKeyEnv。'),
        baseURL: z.string().description('HTTP API 基础地址；省略时使用官方地址。'),
        fetchBaseURL: z.string().description('提取 API 基础地址；TinyFish 默认使用独立 Fetch API 域名。'),
        searchMode: z.union(['basic', 'pro']).description('Kimi 搜索档位；默认 pro，basic 只请求摘要，不请求整页正文。'),
    })).volatile().description('扩展服务：tavily、exa、keenable、crawl4ai、github、qianfan、doubao、firecrawl、tinyfish、serply、kimi、bing、aihot。Bing RSS 与 AIHOT 无需凭证；AIHOT 默认关闭。只配置需要启用的服务。'),
    apiKeyEnv: z
        .string()
        .role('credential-ref')
        .default(ZHIPU_DEFAULT_API_KEY_ENV)
        .volatile()
        .description('智谱凭证引用名（不是 key 本身）。实际 key 值写入 ~/.dsh/.credentials.yaml 的 refs 段同名键' +
        `（如 ${ZHIPU_DEFAULT_API_KEY_ENV}: <你的key>），或设置同名环境变量。` +
        '智谱搜索服务使用此引用（未单独覆盖时）。'),
    search: z
        .object({
        maxFanoutMs: z
            .natural()
            .default(DEFAULT_SEARCH_MAX_FANOUT_MS)
            .description('单个服务搜索限时（毫秒）。超时该路被丢弃，其余服务照常参与聚合。默认 10000。'),
        rrfK: z
            .natural()
            .default(DEFAULT_RRF_K)
            .description('RRF 融合常数 k。越大名次差异对排序影响越平缓。默认 60。'),
        rerankPool: z
            .natural()
            .default(DEFAULT_RERANK_POOL)
            .description('送入重排的候选条数上限（RRF 融合后取前 N）。默认 20。'),
        zhihuQuotaCheck: z
            .boolean()
            .default(true)
            .description('知乎每日额度日检：当日首次搜索前查一次额度，耗尽当日停用知乎路。'),
        rerank: z
            .boolean()
            .default(true)
            .volatile()
            .description('是否启用重排层（硅基流动 bge-reranker-v2-m3）。关闭则纯 RRF 排序，省一次调用。'),
        rerankTimeoutMs: z
            .natural()
            .default(RERANK_TIMEOUT_MS)
            .description('重排调用限时（毫秒），超时降级回纯 RRF 排序。默认 3000。'),
        // Deliberately no default: unset must fall back to the root `apiKeyEnv`
        // (a schema default here would shadow it, since apply cannot tell an
        // explicit default from an unset field).
        zhipuApiKeyEnv: z
            .string()
            .role('credential-ref')
            .volatile()
            .description('智谱搜索面凭证引用名（覆盖根 apiKeyEnv；留空沿用根设置）。key 值写入 ~/.dsh/.credentials.yaml refs 段同名键。'),
        anysearchApiKeyEnv: z
            .string()
            .role('credential-ref')
            .default(ANYSEARCH_DEFAULT_API_KEY_ENV)
            .volatile()
            .description(`AnySearch 凭证引用名。key 值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${ANYSEARCH_DEFAULT_API_KEY_ENV}: as_sk_…）。`),
        zhihuAccessSecretEnv: z
            .string()
            .role('credential-ref')
            .default(ZHIHU_DEFAULT_ACCESS_SECRET_ENV)
            .volatile()
            .description(`知乎 Access Secret 引用名。值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${ZHIHU_DEFAULT_ACCESS_SECRET_ENV}: <32位secret>）。`),
        siliconflowApiKeyEnv: z
            .string()
            .role('credential-ref')
            .default(SILICONFLOW_DEFAULT_API_KEY_ENV)
            .volatile()
            .description(`硅基流动（重排模型）凭证引用名。值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${SILICONFLOW_DEFAULT_API_KEY_ENV}: sk-…）。`),
        zhipuBaseURL: z
            .string()
            .default(ZHIPU_WEB_SEARCH_URL)
            .description('智谱 tools-api 通道端点（仅 zhipuTransport=tools-api 时使用）。'),
        // The transport is a closed set: an unknown spelling must not reach the
        // wire, and the schema (like the client) rejects it rather than guessing.
        zhipuTransport: z
            .union(['anthropic', 'tools-api'])
            .default(ZHIPU_DEFAULT_SEARCH_TRANSPORT)
            .volatile()
            .description('智谱搜索走哪条通道：anthropic = Anthropic 兼容端点，计费走 GLM Coding Plan 付费订阅额度（默认，不使用按次计费余额）；' +
            'tools-api = 按次计费的工具 API（需要智谱平台余额）。两条通道用同一把 key。'),
        zhipuAnthropicBaseURL: z
            .string()
            .default(ZHIPU_ANTHROPIC_BASE_URL)
            .description('anthropic 通道端点（Coding Plan 计费线）。'),
        zhipuAnthropicModel: z
            .string()
            .default(ZHIPU_ANTHROPIC_DEFAULT_MODEL)
            .description('anthropic 通道使用的 GLM 对话模型。'),
        zhipuAnthropicMaxUses: z
            .natural()
            .min(1)
            .default(ZHIPU_ANTHROPIC_MAX_USES)
            .description('anthropic 通道单次请求的搜索工具调用上限。聚合场景一轮搜索足够（默认 1），多轮只加延迟。'),
        anysearchBaseURL: z.string().default(ANYSEARCH_DEFAULT_BASE_URL).description('AnySearch 搜索端点。'),
        zhihuBaseURL: z.string().default(ZHIHU_GLOBAL_SEARCH_URL).description('知乎全网搜索端点。'),
        zhihuQuotaURL: z.string().default(ZHIHU_QUOTA_URL).description('知乎每日额度查询端点。'),
        rerankBaseURL: z.string().default(SILICONFLOW_RERANK_URL).description('硅基流动重排端点。'),
        decisionModel: z.union(['Kev-4b', 'SemIf', 'diffusiongemma', 'decision-model-preview', 'jev-latest']).default('decision-model-preview').volatile().description('自动预设的快速决策模型，保存后下一次请求生效。'),
        decisionTimeoutMs: z.natural().min(100).max(5000).default(2000).description('决策模型限时；自动预设必须取得有效决策后才派发服务。'),
    })
        .default({})
        .description('搜索聚合管线（多来源并发、去重、RRF 融合与重排）的参数与服务凭证引用。'),
    fetch: z
        .object({
        staticRouting: z
            .boolean()
            .default(true)
            .description('URL 感知分流开关。关闭后通用网页使用内置 HTTP 提取器；已启用的 AIHOT 专用 API 仍直接读取。'),
        staticDomains: z
            .array(z.string())
            .default([])
            .description('静态域名画像：命中这些域名的 URL 直接 http 单发，不消耗付费服务额度。'),
        staticExtensions: z
            .array(z.string())
            .default([...DEFAULT_STATIC_EXTENSIONS])
            .description('静态扩展名表（.json/.txt 等）：命中直接 http 单发。'),
        perEngineTimeoutMs: z
            .natural()
            .default(DEFAULT_FETCH_ENGINE_TIMEOUT_MS)
            .description('动态页单个服务抓取限时（毫秒）。默认 45000。'),
        engineWeights: z
            .dict(z.number())
            .default({})
            .description('旧版 select 模式的单份正文权重（按服务 id，如 firecrawl / anysearch / tavily）；正文整理模式不使用。'),
        firecrawlApiKeyEnv: z
            .string()
            .role('credential-ref')
            .default(FIRECRAWL_DEFAULT_API_KEY_ENV)
            .volatile()
            .description(`Firecrawl 凭证引用名。值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${FIRECRAWL_DEFAULT_API_KEY_ENV}: fc-…）。`),
        anysearchApiKeyEnv: z
            .string()
            .role('credential-ref')
            .volatile()
            .description('AnySearch 提取面凭证引用名（留空沿用搜索面 AnySearch 引用）。'),
        firecrawlBaseURL: z.string().default(FIRECRAWL_SCRAPE_URL).description('Firecrawl v2 scrape 端点。'),
        anysearchBaseURL: z.string().default(ANYSEARCH_DEFAULT_BASE_URL).description('AnySearch 提取端点。'),
    })
        .description('提取编排（URL 感知分流与动态页多来源正文整理）的参数与服务凭证引用。'),
}).description('聚合搜索与提取插件：web_search / web_fetch 背后的多来源聚合。' +
    '推荐使用 AnySearch、Firecrawl、Tavily 的官方匿名额度；需要增强服务时，把 key 值写入 ~/.dsh/.credentials.yaml 的 refs 段（键名见各凭证字段说明），无需改动本页默认值。');
/** Register aggregated providers behind the native tools. */
export function apply(ctx, config) {
    const search = config.search ?? {};
    const fetchConfig = config.fetch ?? {};
    // One resolver for every engine: resolved per operation, never cached
    // (per-operation credential resolution), so a rotated key reaches the next search.
    const resolveCredential = async (ref) => (await ctx.credentials.resolve(ref))?.value;
    const log = ctx.logger('web-search-fetch');
    const createDecision = () => {
        const decisionModel = readVolatile(search.decisionModel) ?? 'decision-model-preview';
        const decisionProvider = DECISION_MODEL_PROVIDER[decisionModel] ?? 'siliconflow';
        const decisionCredentialRef = decisionProvider === 'siliconflow'
            ? () => resolveCredentialRef(config, 'siliconflow')
            : decisionProvider === 'alibaba' ? () => 'DASHSCOPE_API_KEY' : () => 'TYPESAFE_API_KEY';
        const decision = new DecisionClient({
            model: decisionModel,
            provider: decisionProvider,
            resolveApiKey: async () => (await ctx.credentials.resolve(credentialRef(decisionCredentialRef())))?.value,
            credentialName: decisionCredentialRef(),
            timeoutMs: search.decisionTimeoutMs,
            fetchImpl: budgetedFetch(decisionFetch),
            onFailure: (reason, detail) => log.warn(`[决策] ${decisionModel} ${reason}：${detail}；本次未派发服务。`),
        });
        return decision;
    };
    const controls = () => {
        const snapshot = structuredClone(config.controls?.get() ?? {});
        return { ...snapshot, decision: createDecision(), serviceEnabled: { siliconflow: readVolatile(search.rerank) ?? true, ...snapshot.serviceEnabled } };
    };
    const ready = async (id, face) => {
        const settings = config.engines?.get()?.[id];
        if (currentControls().preset === 'free') {
            const defaults = { bing: ['https://cn.bing.com'], github: ['https://api.github.com'], aihot: ['https://aihot.news'], tinyfish: ['https://api.search.tinyfish.ai', 'https://api.fetch.tinyfish.ai'] };
            const expected = defaults[id];
            if (expected && ((settings?.baseURL && settings.baseURL !== expected[0]) || (settings?.fetchBaseURL && !expected.includes(settings.fetchBaseURL)))) {
                noteOperation(`免费预设跳过自定义端点：${id}。`);
                return false;
            }
        }
        if (id === 'bing' || id === 'aihot')
            return true;
        if (id === 'anysearch' && isAnySearchKeylessEndpoint(((face === 'fetch' ? fetchConfig.anysearchBaseURL : search.anysearchBaseURL) ?? ANYSEARCH_DEFAULT_BASE_URL)?.replace(/\/+$/, '') + (face === 'fetch' ? '/v1/extract' : '/v1/search')))
            return true;
        if (id === 'tavily' && isTavilyKeylessEndpoint(((face === 'fetch' ? settings?.fetchBaseURL ?? settings?.baseURL : settings?.baseURL) ?? 'https://api.tavily.com')?.replace(/\/+$/, '') + (face === 'fetch' ? '/extract' : '/search')))
            return true;
        if (id === 'firecrawl' && isFirecrawlKeylessEndpoint(face === 'fetch'
            ? fetchConfig.firecrawlBaseURL ?? FIRECRAWL_SCRAPE_URL
            : (settings?.baseURL ?? 'https://api.firecrawl.dev').replace(/\/+$/, '') + '/v2/search'))
            return true;
        if (typeof ctx.credentials.describe !== 'function')
            return true;
        const slot = id === 'doubao' ? face === 'fetch' ? 'doubao-fetch' : 'doubao-search' : id;
        const reference = face === 'fetch' && id === 'anysearch' ? config.fetch?.anysearchApiKeyEnv?.get() || resolveCredentialRef(config, 'anysearch')
            : face === 'search' && settings?.apiKeyEnv ? settings.apiKeyEnv
                : face === 'fetch' && id !== 'firecrawl' && settings?.fetchApiKeyEnv ? settings.fetchApiKeyEnv
                    : settings?.apiKeyEnv && id !== 'firecrawl' && !(face === 'fetch' && id === 'doubao') ? settings.apiKeyEnv
                        : resolveCredentialRef(config, slot);
        try {
            return (await ctx.credentials.describe(credentialRef(reference))).configured;
        }
        catch {
            return true;
        } // Unknown status must not silently disable a configured service.
    };
    let enginesRevision = '';
    let additionalEngines = [];
    const currentAdditionalEngines = () => {
        const settings = config.engines?.get() ?? {};
        const revision = JSON.stringify(settings);
        if (revision !== enginesRevision) {
            additionalEngines = createAdditionalEngines(settings, resolveCredential, {
                searchTimeoutMs: search.maxFanoutMs ?? DEFAULT_SEARCH_MAX_FANOUT_MS,
                fetchTimeoutMs: fetchConfig.perEngineTimeoutMs ?? DEFAULT_FETCH_ENGINE_TIMEOUT_MS,
            });
            enginesRevision = revision;
        }
        return additionalEngines;
    };
    currentAdditionalEngines();
    // Resolve names at operation time: volatile edits do not remount the plugin.
    const anysearchExtractRefName = () => fetchConfig.anysearchApiKeyEnv?.get() || resolveCredentialRef(config, 'anysearch');
    const searchOverrides = buildSearchOverrides(search);
    const provider = createAggregatedSearchProvider({
        resolveControls: controls,
        ready,
        resolveAdditionalEngines: currentAdditionalEngines,
        resolveCredential,
        logger: {
            info: (message) => log.info(message),
            warn: (message) => log.warn(message),
            error: (message) => log.error(message),
        },
        zhipuApiKeyEnv: () => resolveCredentialRef(config, 'zhipu'),
        anysearchApiKeyEnv: () => resolveCredentialRef(config, 'anysearch'),
        zhihuAccessSecretEnv: () => resolveCredentialRef(config, 'zhihu'),
        siliconflowApiKeyEnv: () => resolveCredentialRef(config, 'siliconflow'),
        ...(search.maxFanoutMs === undefined ? {} : { maxFanoutMs: search.maxFanoutMs }),
        ...(search.rrfK === undefined ? {} : { rrfK: search.rrfK }),
        ...(search.rerankPool === undefined ? {} : { rerankPool: search.rerankPool }),
        ...(search.zhihuQuotaCheck === undefined ? {} : { zhihuQuotaCheck: search.zhihuQuotaCheck }),
        ...(search.rerank === undefined ? {} : { rerank: readVolatile(search.rerank) }),
        ...(search.rerankTimeoutMs === undefined ? {} : { rerankTimeoutMs: search.rerankTimeoutMs }),
        // A live reader, not a captured value: the transport is the one field the
        // settings page edits, and a volatile edit is committed into the running
        // reference without remounting this plugin. A value captured here would keep
        // dispatching to the channel the user just switched away from.
        resolveZhipuTransport: () => projectEditableSettings(config).zhipuTransport,
        ...(search.zhipuAnthropicModel === undefined
            ? {}
            : { zhipuAnthropicModel: search.zhipuAnthropicModel }),
        ...(search.zhipuAnthropicMaxUses === undefined
            ? {}
            : { zhipuAnthropicMaxUses: search.zhipuAnthropicMaxUses }),
        ...(searchOverrides === undefined ? {} : { overrides: searchOverrides }),
    });
    ctx.web.registerSearchProvider(provider);
    // ---- fetch face (#9): conditional orchestration (DESIGN.md) ----
    const perEngineTimeoutMs = fetchConfig.perEngineTimeoutMs ?? DEFAULT_FETCH_ENGINE_TIMEOUT_MS;
    const firecrawlRefName = () => resolveCredentialRef(config, 'firecrawl');
    const breaker = new CircuitBreaker({
        onEvent: (event) => log.warn(formatBreakerEvent(event)),
    });
    // Every credential resolves per operation, never cached.
    const firecrawl = new FirecrawlClient({
        fetchImpl: budgetedFetch(),
        resolveApiKey: async () => (await ctx.credentials.resolve(credentialRef(firecrawlRefName())))?.value,
        credentialName: firecrawlRefName(),
        timeoutMs: perEngineTimeoutMs,
        baseURL: fetchConfig.firecrawlBaseURL ?? FIRECRAWL_SCRAPE_URL,
    });
    const anysearch = new AnySearchEngine({
        fetchImpl: budgetedFetch(),
        resolveApiKey: async () => (await ctx.credentials.resolve(credentialRef(anysearchExtractRefName())))?.value,
        credentialName: anysearchExtractRefName(),
        timeoutMs: perEngineTimeoutMs,
        baseURL: fetchConfig.anysearchBaseURL ?? ANYSEARCH_DEFAULT_BASE_URL,
    });
    ctx.web.registerFetchProvider(new AggregatedFetchProvider({
        resolveControls: controls,
        ready,
        get additionalEngines() { return currentAdditionalEngines(); },
        legs: createExtractionLegs({ firecrawl, anysearch }),
        route: {
            enabled: fetchConfig.staticRouting ?? true,
            staticDomains: fetchConfig.staticDomains ?? [],
            staticExtensions: fetchConfig.staticExtensions ?? DEFAULT_STATIC_EXTENSIONS,
        },
        breaker,
        logger: log,
        perEngineTimeoutMs,
        engineWeights: fetchConfig.engineWeights ?? {},
    }));
}
/**
 * Collect the search-face endpoint overrides, or `undefined` when every
 * endpoint is left at its default (so the pipeline's own defaults apply).
 */
function buildSearchOverrides(search) {
    const overrides = {
        ...(search.anysearchBaseURL === undefined ? {} : { anysearchBaseURL: search.anysearchBaseURL }),
        ...(search.zhipuBaseURL === undefined ? {} : { zhipuBaseURL: search.zhipuBaseURL }),
        ...(search.zhipuAnthropicBaseURL === undefined
            ? {}
            : { zhipuAnthropicBaseURL: search.zhipuAnthropicBaseURL }),
        ...(search.zhihuBaseURL === undefined ? {} : { zhihuBaseURL: search.zhihuBaseURL }),
        ...(search.zhihuQuotaURL === undefined ? {} : { zhihuQuotaURL: search.zhihuQuotaURL }),
        ...(search.rerankBaseURL === undefined ? {} : { rerankBaseURL: search.rerankBaseURL }),
    };
    return Object.keys(overrides).length === 0 ? undefined : overrides;
}
/** Kept so `apiKeyEnv`'s credential-ref contract stays reachable to callers. */
export { credentialRef };
