import { isAnySearchKeylessEndpoint, isTavilyKeylessEndpoint } from './keyless.js';
/**
 * dsh-web-search-fetch — registers the aggregated web search and fetch
 * providers on DSH's `ctx.web` seam, which the built-in `web_search` /
 * `web_fetch` tools consume.
 *
 * The search face aggregates the base and configured HTTP engines (DESIGN.md)
 * through one breaker, RRF fusion, and optional rerank; the fetch
 * face is URL-aware conditional orchestration (DESIGN.md) — a static route
 * passes through the built-in safe HTTP fetcher, a dynamic route fans out to
 * the base and configured extraction engines (择优, breaker-gated).
 * The plugin adds no model-visible tools (DESIGN.md).
 * @module index
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
// Keep the dictionary type nameable in generated schema declarations.
import type { Dict } from '@deepseek-ai/cosmokit';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import {
  ANYSEARCH_DEFAULT_API_KEY_ENV,
  DEFAULT_RERANK_POOL,
  DEFAULT_RRF_K,
  DEFAULT_SEARCH_MAX_FANOUT_MS,
  SILICONFLOW_DEFAULT_API_KEY_ENV,
  createAggregatedSearchProvider,
} from './search-pipeline.js';
import type { SearchEngineOverrides } from './search-pipeline.js';
import { AggregatedFetchProvider, createExtractionLegs } from './fetch-pipeline.js';
import { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
import { FirecrawlClient } from './engines/firecrawl/client.js';
import { FIRECRAWL_DEFAULT_API_KEY_ENV, FIRECRAWL_SCRAPE_URL, isFirecrawlKeylessEndpoint } from './engines/firecrawl/wire.js';
import { AnySearchEngine } from './engines/anysearch/engine.js';
import { ANYSEARCH_DEFAULT_BASE_URL } from './engines/anysearch/limits.js';
import { RERANK_TIMEOUT_MS, SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
import { DEFAULT_FETCH_ENGINE_TIMEOUT_MS, DEFAULT_STATIC_EXTENSIONS } from './fetch-aggregate.js';
import { createAdditionalEngines, type AdditionalEnginesConfig } from './engines/additional/index.js';
import { budgetedFetch, currentControls, noteOperation } from './request-budget.js';
import type { RuntimeControls } from './request-budget.js';
import { DecisionClient, decisionFetch } from './engines/decision/client.js';
import { DECISION_MODEL_PROVIDER } from './engines/decision/wire.js';
export { createAdditionalEngines, ADDITIONAL_ENGINE_DEFAULTS } from './engines/additional/index.js';
export type { AdditionalEnginesConfig, AdditionalEngineConfig, AdditionalEngineId } from './engines/additional/index.js';
import {
  WEB_SEARCH_FETCH_SETTINGS_NAMESPACE,
  resolveCredentialRef,
  readVolatile,
} from './settings-surface.js';

export { ANYSEARCH_DEFAULT_BASE_URL } from './engines/anysearch/limits.js';
export { AnySearchClient } from './engines/anysearch/client.js';
export { AnySearchClientError } from './engines/anysearch/error.js';
export type {
  AnySearchDomainCapability, AnySearchDomainsResponse, AnySearchDomainSummary,
  AnySearchMetadata, AnySearchParamInfo, AnySearchParamValue, AnySearchResult,
  AnySearchSearchRequest, AnySearchSearchResponse, AnySearchSubDomain, AnySearchSubDomainsResponse,
} from './engines/anysearch/types.js';
export { FIRECRAWL_SCRAPE_URL } from './engines/firecrawl/wire.js';
export { RERANK_TIMEOUT_MS, SILICONFLOW_RERANK_URL } from './engines/rerank/limits.js';
export {
  AggregatedSearchProvider,
  ANYSEARCH_DEFAULT_API_KEY_ENV,
  ANYSEARCH_ENGINE_ID,
  DEFAULT_RERANK_POOL,
  DEFAULT_RRF_K,
  DEFAULT_SEARCH_MAX_FANOUT_MS,
  SILICONFLOW_DEFAULT_API_KEY_ENV,
  createAggregatedSearchProvider,
  normalizeSearchUrl,
  readSearchFailureSignal,
  rrfFuse,
} from './search-pipeline.js';
export type {
  AggregatedSearchOptions,
  AggregatedSearchPipelineOptions,
  FusedCandidate,
  RerankHandle,
  ResolveCredential,
  SearchEngineClient,
  SearchEngineOverrides,
  SearchLogSink,
} from './search-pipeline.js';
export { AggregatedFetchProvider, DEFAULT_HTTP_FETCH_LIMITS, createExtractionLegs } from './fetch-pipeline.js';
export type { AggregatedFetchProviderOptions, ExtractionEngineClients } from './fetch-pipeline.js';
export {
  aggregateDynamicFetch,
  anysearchBreakerSignal,
  bodyFingerprint,
  classifyFetchRoute,
  DEFAULT_ENGINE_WEIGHTS,
  DEFAULT_FETCH_ENGINE_TIMEOUT_MS,
  DEFAULT_STATIC_EXTENSIONS,
  extractBodyTitle,
  extractUrlSlug,
  firecrawlBreakerSignal,
  isUsableCandidate,
  scoreCandidate,
  selectBestCandidate,
  titleSimilarity,
} from './fetch-aggregate.js';
export { DecisionClient } from './engines/decision/client.js';
export { DECISION_MODEL_PROVIDER, buildDecisionRequest, parseDecisionDepth } from './engines/decision/wire.js';
export { ALIBABA_DECISION_URL, DECISION_TIMEOUT_MS, SILICONFLOW_SYSTEMONE_URL, TYPESAFE_JEV_URL } from './engines/decision/limits.js';
export type { DecisionDepth, DecisionModelId, DecisionProvider } from './engines/decision/types.js';
export type {
  FetchCandidate,
  FetchEngineLeg,
  FetchPipelineLogger,
  FetchRoute,
  FetchRouteOptions,
} from './fetch-aggregate.js';
export { CircuitBreaker, formatBreakerEvent } from './breaker/index.js';
export type { BreakerSignal, CircuitBreakerOptions } from './breaker/index.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-fetch';

/** Required services: web providers and per-operation credentials. */
export const inject = ['web', 'credentials'];

export { WEB_SEARCH_FETCH_SETTINGS_NAMESPACE };

/** Search-pipeline configuration (DESIGN.md). */
export interface SearchConfig {
  /** Per-engine deadline in milliseconds; defaults to the documented 10 s. */
  maxFanoutMs?: number;
  /** RRF constant `k`; defaults to 60. */
  rrfK?: number;
  /** Candidates handed to rerank; defaults to 20. */
  rerankPool?: number;
  /** Set `false` to skip the rerank stage entirely (pure RRF). */
  rerank?: Volatile<boolean> | boolean;
  /** Rerank whole-operation deadline in milliseconds; defaults to the documented ~3 s. */
  rerankTimeoutMs?: number;
  /** AnySearch credential reference; defaults to `ANYSEARCH_API_KEY`. Volatile. */
  anysearchApiKeyEnv?: Volatile<string>;
  /** SiliconFlow rerank credential reference; defaults to `SILICONFLOW_API_KEY`. Volatile. */
  siliconflowApiKeyEnv?: Volatile<string>;
  /** AnySearch origin (DESIGN.md); defaults to `https://api.anysearch.com`. */
  anysearchBaseURL?: string;
  /** SiliconFlow rerank endpoint (DESIGN.md); defaults to the public endpoint. */
  rerankBaseURL?: string;
  /** Fast decision model behind the automatic preset. */
  decisionModel?: Volatile<'Kev-4b' | 'SemIf' | 'diffusiongemma' | 'decision-model-preview' | 'jev-latest'>;
  /** Decision-model request budget. */
  decisionTimeoutMs?: number;
}

/** Fetch-side configuration: routing knobs, engine endpoints, and 择优 tuning. */
export interface FetchConfig {
  /** `false` bypasses routing: every URL uses the HTTP fetcher. Default `true`. */
  staticRouting?: boolean;
  /** Static-domain profiles whose pages skip the paid engines. */
  staticDomains?: string[];
  /** Static extension table; defaults to the built-in list (`.json`, `.txt`, …). */
  staticExtensions?: string[];
  /** Dynamic-path per-engine deadline in milliseconds. Default 45 s (DESIGN.md). */
  perEngineTimeoutMs?: number;
  /** 择优 weight overrides per engine id; missing entries keep the defaults. */
  engineWeights?: Record<string, number>;
  /** Firecrawl credential reference; defaults to `FIRECRAWL_API_KEY`. */
  firecrawlApiKeyEnv?: Volatile<string>;
  /** AnySearch extract credential reference; falls back to the search-face one. */
  anysearchApiKeyEnv?: Volatile<string | undefined>;
  /** Firecrawl v2 scrape endpoint (DESIGN.md); defaults to the public endpoint. */
  firecrawlBaseURL?: string;
  /** AnySearch origin for the extract face (DESIGN.md); defaults to the public origin. */
  anysearchBaseURL?: string;
}

/** Plugin configuration. */
export interface Config {
  controls?: Volatile<RuntimeControls | undefined>;
  /** Additional engines; a configured entry is enabled unless set to false. */
  engines?: Volatile<AdditionalEnginesConfig | undefined>;
  /** Search-pipeline knobs (DESIGN.md). */
  search?: SearchConfig;
  /** Fetch-side knobs, all optional. */
  fetch?: FetchConfig;
}

export const Config = z.object({
  controls: z.object({
    serviceEnabled: z.dict(z.boolean()).default({}).description('服务总开关；关闭后不派发该服务，保留各能力的参与范围。'),
    mode: z.union(['organize', 'select']).default('organize').description('正文整理；select 为旧版单份正文模式。'),
    preset: z.union(['auto', 'custom', 'free', 'balanced', 'deep']).default('auto').description('自动按请求判断覆盖范围；也可固定为自定义、免费、均衡（最多三路）或深度检索。免费仍可能需要凭证。'),
    searchServices: z.array(z.string()).default(['anysearch', 'deepseek', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'firecrawl', 'tinyfish', 'serply', 'kimi', 'bing', 'aihot']).description('搜索服务 ID 与调用优先级；空数组不调用搜索服务。'),
    fetchServices: z.array(z.string()).default(['firecrawl', 'anysearch', 'deepseek', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'tinyfish', 'serply', 'kimi', 'aihot']).description('提取服务 ID 与调用优先级；HTTP 静态路径不受此列表控制。'),
    maxSearchServices: z.natural().min(1).max(13).default(13).description('每个查询最多调用的搜索服务数。'),
    maxFetchServices: z.natural().min(1).max(11).default(11).description('每个 URL 最多调用的普通提取服务数。'),
    maxRequests: z.natural().min(1).max(256).default(32).description('每次 provider 操作的插件 HTTP 请求上限，包含额度查询、重试和重排；不含宿主 HTTP 重定向。'),
    searchDeadlineMs: z.natural().min(1).max(3600000).default(15000).description('搜索操作总限时，毫秒。'),
    fetchDeadlineMs: z.natural().min(1).max(3600000).default(50000).description('提取操作总限时，毫秒。'),
    maxOutputChars: z.natural().min(1000).max(1000000).default(100000).description('正文整理输出上限，按完整内容块保留，包含来源与差异说明。'),
  }).default({}).volatile().description('正文整理与操作调用控制，保存后下一次调用生效。'),
  engines: z.dict(z.object({
    enabled: z.boolean().default(true).description('是否将此服务加入搜索与可用的提取管线。'),
    apiKeyEnv: z.string().role('credential-ref').description('凭证引用名；省略时使用该服务默认引用。'),
    baseURL: z.string().description('HTTP API 基础地址；省略时使用官方地址。'),
    fetchBaseURL: z.string().description('提取 API 基础地址；TinyFish 默认使用独立 Fetch API 域名。'),
    searchMode: z.union(['basic', 'pro']).description('Kimi 搜索档位；默认 pro，basic 只请求摘要，不请求整页正文。'),
  })).volatile().description('扩展服务：deepseek、tavily、exa、keenable、crawl4ai、github、firecrawl、tinyfish、serply、kimi、bing、aihot。DeepSeek 新 API 与 AIHOT 默认关闭；Bing RSS 与 AIHOT 无需凭证。只配置需要启用的服务。'),
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
      rerank: z
        .boolean()
        .default(true)
        .volatile()
        .description('是否启用重排层（硅基流动 bge-reranker-v2-m3）。关闭则纯 RRF 排序，省一次调用。'),
      rerankTimeoutMs: z
        .natural()
        .default(RERANK_TIMEOUT_MS)
        .description('重排调用限时（毫秒），超时降级回纯 RRF 排序。默认 3000。'),
      anysearchApiKeyEnv: z
        .string()
        .role('credential-ref')
        .default(ANYSEARCH_DEFAULT_API_KEY_ENV)
        .volatile()
        .description(
          `AnySearch 凭证引用名。key 值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${ANYSEARCH_DEFAULT_API_KEY_ENV}: as_sk_…）。`,
        ),
      siliconflowApiKeyEnv: z
        .string()
        .role('credential-ref')
        .default(SILICONFLOW_DEFAULT_API_KEY_ENV)
        .volatile()
        .description(
          `硅基流动（重排模型）凭证引用名。值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${SILICONFLOW_DEFAULT_API_KEY_ENV}: sk-…）。`,
        ),
      anysearchBaseURL: z.string().default(ANYSEARCH_DEFAULT_BASE_URL).description('AnySearch 搜索端点。'),
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
        .description(
          `Firecrawl 凭证引用名。值写入 ~/.dsh/.credentials.yaml refs 段同名键（如 ${FIRECRAWL_DEFAULT_API_KEY_ENV}: fc-…）。`,
        ),
      anysearchApiKeyEnv: z
        .string()
        .role('credential-ref')
        .volatile()
        .description('AnySearch 提取面凭证引用名（留空沿用搜索面 AnySearch 引用）。'),
      firecrawlBaseURL: z.string().default(FIRECRAWL_SCRAPE_URL).description('Firecrawl v2 scrape 端点。'),
      anysearchBaseURL: z.string().default(ANYSEARCH_DEFAULT_BASE_URL).description('AnySearch 提取端点。'),
    })
    .description('提取编排（URL 感知分流与动态页多来源正文整理）的参数与服务凭证引用。'),
}).description(
  '聚合搜索与提取插件：web_search / web_fetch 背后的多来源聚合。' +
    '推荐使用 AnySearch、Firecrawl、Tavily 的官方匿名额度；需要增强服务时，把 key 值写入 ~/.dsh/.credentials.yaml 的 refs 段（键名见各凭证字段说明），无需改动本页默认值。',
);


/** Register aggregated providers behind the native tools. */
export function apply(ctx: Context, config: Config): void {
  const search = config.search ?? {};
  const fetchConfig = config.fetch ?? {};
  // One resolver for every engine: resolved per operation, never cached
  // (per-operation credential resolution), so a rotated key reaches the next search.
  const resolveCredential = async (ref: CredentialRef): Promise<string | undefined> =>
    (await ctx.credentials.resolve(ref))?.value;
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
  const controls = (): RuntimeControls => {
    const snapshot = structuredClone(config.controls?.get() ?? {}) as RuntimeControls;
    return { ...snapshot, decision: createDecision(), serviceEnabled: { siliconflow: readVolatile(search.rerank) ?? true, ...snapshot.serviceEnabled } };
  };
  const ready = async (id: string, face: 'search' | 'fetch'): Promise<boolean> => {
    const settings = config.engines?.get()?.[id as keyof AdditionalEnginesConfig];
    if (currentControls().preset === 'free') {
      const defaults = { bing: ['https://cn.bing.com'], github: ['https://api.github.com'], aihot: ['https://aihot.news'], tinyfish: ['https://api.search.tinyfish.ai', 'https://api.fetch.tinyfish.ai'] };
      const expected = defaults[id as keyof typeof defaults];
      if (expected && ((settings?.baseURL && settings.baseURL !== expected[0]) || (settings?.fetchBaseURL && !expected.includes(settings.fetchBaseURL)))) {
        noteOperation(`免费预设跳过自定义端点：${id}。`); return false;
      }
    }
    if (id === 'bing' || id === 'aihot') return true;
    if (id === 'anysearch' && isAnySearchKeylessEndpoint(((face === 'fetch' ? fetchConfig.anysearchBaseURL : search.anysearchBaseURL) ?? ANYSEARCH_DEFAULT_BASE_URL)?.replace(/\/+$/, '') + (face === 'fetch' ? '/v1/extract' : '/v1/search'))) return true;
    if (id === 'tavily' && isTavilyKeylessEndpoint(((face === 'fetch' ? settings?.fetchBaseURL ?? settings?.baseURL : settings?.baseURL) ?? 'https://api.tavily.com')?.replace(/\/+$/, '') + (face === 'fetch' ? '/extract' : '/search'))) return true;
    if (id === 'firecrawl' && isFirecrawlKeylessEndpoint(face === 'fetch'
      ? fetchConfig.firecrawlBaseURL ?? FIRECRAWL_SCRAPE_URL
      : (settings?.baseURL ?? 'https://api.firecrawl.dev').replace(/\/+$/, '') + '/v2/search')) return true;
    if (typeof ctx.credentials.describe !== 'function') return true;
    const reference = face === 'fetch' && id === 'anysearch' ? config.fetch?.anysearchApiKeyEnv?.get() || resolveCredentialRef(config, 'anysearch')
      : settings?.apiKeyEnv && id !== 'firecrawl' ? settings.apiKeyEnv
      : resolveCredentialRef(config, id as Parameters<typeof resolveCredentialRef>[1]);
    try { return (await ctx.credentials.describe(credentialRef(reference))).configured; }
    catch { return true; } // Unknown status must not silently disable a configured service.
  };
  let enginesRevision = '';
  let additionalEngines: ReturnType<typeof createAdditionalEngines> = [];
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
  const anysearchExtractRefName = () =>
    fetchConfig.anysearchApiKeyEnv?.get() || resolveCredentialRef(config, 'anysearch');

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
    anysearchApiKeyEnv: () => resolveCredentialRef(config, 'anysearch'),
    siliconflowApiKeyEnv: () => resolveCredentialRef(config, 'siliconflow'),
    ...(search.maxFanoutMs === undefined ? {} : { maxFanoutMs: search.maxFanoutMs }),
    ...(search.rrfK === undefined ? {} : { rrfK: search.rrfK }),
    ...(search.rerankPool === undefined ? {} : { rerankPool: search.rerankPool }),
    ...(search.rerank === undefined ? {} : { rerank: readVolatile(search.rerank) }),
    ...(search.rerankTimeoutMs === undefined ? {} : { rerankTimeoutMs: search.rerankTimeoutMs }),
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
  ctx.web.registerFetchProvider(
    new AggregatedFetchProvider({
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
    }),
  );

}

/**
 * Collect the search-face endpoint overrides, or `undefined` when every
 * endpoint is left at its default (so the pipeline's own defaults apply).
 */
function buildSearchOverrides(search: SearchConfig): SearchEngineOverrides | undefined {
  const overrides: SearchEngineOverrides = {
    ...(search.anysearchBaseURL === undefined ? {} : { anysearchBaseURL: search.anysearchBaseURL }),
    ...(search.rerankBaseURL === undefined ? {} : { rerankBaseURL: search.rerankBaseURL }),
  };
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}
