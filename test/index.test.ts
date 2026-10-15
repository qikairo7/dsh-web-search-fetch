import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web';
import { apply, Config, createAggregatedSearchProvider } from '../src/index.js';
import { readFixtureText } from './helpers/fixtures.js';

interface StubContext {
  ctx: Context;
  searchProviders: WebSearchProvider[];
  fetchProviders: WebFetchProvider[];
  resolveCalls: () => number;
  logLines: string[];
}

/** Minimal structural stand-in for the seams `apply` touches. */
function createStubContext(): StubContext {
  const searchProviders: WebSearchProvider[] = [];
  const fetchProviders: WebFetchProvider[] = [];
  const logLines: string[] = [];
  let resolves = 0;
  const method = (message: string): void => {
    logLines.push(message);
  };
  const log = Object.assign(method, { info: method, warn: method, error: method, debug: method });
  const ctx = {
    web: {
      registerSearchProvider: (provider: WebSearchProvider) => {
        searchProviders.push(provider);
      },
      registerFetchProvider: (provider: WebFetchProvider) => {
        fetchProviders.push(provider);
      },
    },
    credentials: {
      resolve: async () => {
        resolves += 1;
        return { value: 'test-value', source: 'test' };
      },
    },
    logger: () => log,
  } as unknown as Context;
  return { ctx, searchProviders, fetchProviders, resolveCalls: () => resolves, logLines };
}

/** One endpoint's canned response: a body string plus an HTTP status. */
interface CannedResponse {
  readonly status?: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

/** Per-endpoint response overrides; unset endpoints serve their happy fixture. */
interface EngineResponses {
  readonly anysearch?: CannedResponse;
  /** The tools-api channel's response (served to `/paas/v4/web_search`). */
  readonly zhipu?: CannedResponse;
  /** The default anthropic channel's response (served to `/api/anthropic/v1/messages`). */
  readonly zhipuAnthropic?: CannedResponse;
  readonly zhihu?: CannedResponse;
  readonly quota?: CannedResponse;
  readonly rerank?: CannedResponse;
}

/** Route the engines' fixtures by endpoint, recording every request. */
function stubEngineFetch(responses: EngineResponses = {}): {
  calls: { url: string; init: RequestInit | undefined }[];
  restore: () => void;
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const originalFetch = globalThis.fetch;
  const fixture = (name: string): CannedResponse => ({ status: 200, body: readFixtureText(name) });
  const anysearch = responses.anysearch ?? fixture('anysearch-search-response.json');
  const zhipu = responses.zhipu ?? fixture('zhipu-web-search-response.json');
  // A `zhipu` override means "the Zhipu engine answers this way"; without a
  // channel-specific override it applies to whichever channel is active.
  const zhipuAnthropic =
    responses.zhipuAnthropic ?? responses.zhipu ?? fixture('zhipu-anthropic-response.json');
  const zhihu = responses.zhihu ?? fixture('zhihu-global-search-response.json');
  const quota = responses.quota ?? fixture('zhihu-quota-response.json');
  const rerank = responses.rerank ?? fixture('siliconflow-rerank-response.json');

  const serve = (canned: CannedResponse): Response =>
    new Response(canned.body, {
      status: canned.status ?? 200,
      headers: { 'content-type': 'application/json', ...canned.headers },
    });

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('anysearch.com')) return serve(anysearch);
    if (url.includes('siliconflow.cn')) return serve(rerank);
    if (url.includes('zhihu.com/api/v1/quota')) return serve(quota);
    if (url.includes('zhihu.com')) return serve(zhihu);
    // The Zhipu face has two channels; the endpoint says which fixture answers.
    if (url.includes('/anthropic/')) return serve(zhipuAnthropic);
    return serve(zhipu);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = originalFetch) };
}

describe('Config', () => {
  /**
   * Read a credential-reference field.
   *
   * These fields are `.volatile()` — the settings card reads the reference name
   * out of the served form, and a volatile field parses into a live reference
   * whose value is read through `.get()`.
   */
  const refOf = (value: { get(): string | undefined } | string | undefined): string | undefined =>
    typeof value === 'object' && value !== null ? value.get() : value;

  it('apiKeyEnv 默认 ZHIPU_API_KEY，显式值透传', () => {
    expect(refOf(Config({}).apiKeyEnv)).toBe('ZHIPU_API_KEY');
    expect(refOf(Config({ apiKeyEnv: 'MY_ZHIPU_KEY' }).apiKeyEnv)).toBe('MY_ZHIPU_KEY');
  });

  it('fetch 子对象：分流/域名画像/扩展名表/超时/权重默认值就位', () => {
    const resolved = Config({}).fetch;
    expect(resolved).toMatchObject({
      staticRouting: true,
      staticDomains: [],
      staticExtensions: [
        'txt',
        'text',
        'xml',
        'json',
        'md',
        'markdown',
        'csv',
        'tsv',
        'rss',
        'atom',
        'yaml',
        'yml',
        'log',
        'ini',
        'toml',
        'ics',
        'vtt',
        'srt',
      ],
      perEngineTimeoutMs: 45_000,
      engineWeights: {},
      firecrawlBaseURL: 'https://api.firecrawl.dev/v2/scrape',
      anysearchBaseURL: 'https://api.anysearch.com',
    });
    expect(refOf(resolved?.firecrawlApiKeyEnv)).toBe('FIRECRAWL_API_KEY');
    const overridden = Config({
      fetch: {
        perEngineTimeoutMs: 1_000,
        staticDomains: ['docs.example.com'],
        staticExtensions: ['json'],
        engineWeights: { firecrawl: 5 },
        firecrawlBaseURL: 'http://127.0.0.1:9/scrape',
        anysearchBaseURL: 'http://127.0.0.1:9',
      },
    }).fetch;
    expect(overridden?.perEngineTimeoutMs).toBe(1_000);
    expect(overridden?.staticDomains).toEqual(['docs.example.com']);
    expect(overridden?.staticExtensions).toEqual(['json']);
    expect(overridden?.engineWeights).toEqual({ firecrawl: 5 });
    expect(overridden?.firecrawlBaseURL).toBe('http://127.0.0.1:9/scrape');
    expect(overridden?.anysearchBaseURL).toBe('http://127.0.0.1:9');
    expect(overridden?.staticRouting).toBe(true);
  });

  it('search 子对象给出 DESIGN §4 默认值，可逐项覆盖', () => {
    const defaults = Config({}).search!;
    expect(defaults.maxFanoutMs).toBe(10_000);
    expect(defaults.rrfK).toBe(60);
    expect(defaults.rerankPool).toBe(20);
    expect(defaults.zhihuQuotaCheck).toBe(true);
    expect(defaults.rerank.get()).toBe(true);
    expect(defaults.rerankTimeoutMs).toBe(3_000);
    expect(refOf(defaults.anysearchApiKeyEnv)).toBe('ANYSEARCH_API_KEY');
    expect(refOf(defaults.zhihuAccessSecretEnv)).toBe('ZHIHU_ACCESS_SECRET');
    expect(refOf(defaults.siliconflowApiKeyEnv)).toBe('SILICONFLOW_API_KEY');
    // 五个端点全量透出，默认即 DESIGN.md 公开端点
    expect(defaults.zhipuBaseURL).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
    expect(defaults.anysearchBaseURL).toBe('https://api.anysearch.com');
    expect(defaults.zhihuBaseURL).toBe('https://developer.zhihu.com/api/v1/content/global_search');
    expect(defaults.zhihuQuotaURL).toBe('https://developer.zhihu.com/api/v1/quota');
    expect(defaults.rerankBaseURL).toBe('https://api.siliconflow.cn/v1/rerank');
    // zhipuApiKeyEnv 无 schema 默认（未设置时回落到根 apiKeyEnv，由 apply 解析）
    expect(refOf(defaults.zhipuApiKeyEnv)).toBeUndefined();

    // issue #12：传输通道默认 anthropic（Coding Plan 路线），四项可配。
    // zhipuTransport 是 volatile 字段（设置卡片要改它，命名空间也靠它才可服务），
    // 解析结果是活引用，取值要走 .get()。
    expect(refOf(defaults.zhipuTransport)).toBe('anthropic');
    expect(defaults.zhipuAnthropicBaseURL).toBe('https://open.bigmodel.cn/api/anthropic/v1');
    expect(defaults.zhipuAnthropicModel).toBe('glm-4.6');
    expect(defaults.zhipuAnthropicMaxUses).toBe(1);

    const channel = Config({
      search: { zhipuTransport: 'tools-api', zhipuAnthropicModel: 'glm-4.5-air', zhipuAnthropicMaxUses: 8 },
    }).search!;
    expect(refOf(channel.zhipuTransport)).toBe('tools-api');
    expect(channel.zhipuAnthropicModel).toBe('glm-4.5-air');
    expect(channel.zhipuAnthropicMaxUses).toBe(8);

    // 未知通道名与非法 maxUses 在 schema 层拒绝，不落到线上
    expect(() => Config({ search: { zhipuTransport: 'nope' as never } })).toThrow();
    expect(() => Config({ search: { zhipuAnthropicMaxUses: 0 } })).toThrow();

    const overridden = Config({ search: { rrfK: 5, maxFanoutMs: 250 } }).search!;
    expect(overridden.rrfK).toBe(5);
    expect(overridden.maxFanoutMs).toBe(250);
    // 未覆盖的字段仍取默认
    expect(overridden.rerankPool).toBe(20);
  });

  it('凭证引用字段带 credential-ref 角色（配置面不出现凭证值）', () => {
    const json = Config.toJSON() as {
      uid: number;
      refs: Record<
        string,
        {
          meta?: { role?: string; default?: unknown };
          dict?: Record<string, number>;
        }
      >;
    };
    const root = json.refs[String(json.uid)];
    const fieldRef = root?.dict?.apiKeyEnv;
    const field = fieldRef === undefined ? undefined : json.refs[String(fieldRef)];
    expect(field?.meta?.role).toBe('credential-ref');
    expect(field?.meta?.default).toBe('ZHIPU_API_KEY');

    // search 子对象里的引擎凭证引用同样是 credential-ref
    const searchRef = root?.dict?.search;
    const searchNode = searchRef === undefined ? undefined : json.refs[String(searchRef)];
    const names = ['zhipuApiKeyEnv', 'anysearchApiKeyEnv', 'zhihuAccessSecretEnv', 'siliconflowApiKeyEnv'];
    const defaults: Record<string, string | undefined> = {
      zhipuApiKeyEnv: undefined,
      anysearchApiKeyEnv: 'ANYSEARCH_API_KEY',
      zhihuAccessSecretEnv: 'ZHIHU_ACCESS_SECRET',
      siliconflowApiKeyEnv: 'SILICONFLOW_API_KEY',
    };
    for (const name of names) {
      const ref = searchNode?.dict?.[name];
      const node = ref === undefined ? undefined : json.refs[String(ref)];
      expect(node?.meta?.role, name).toBe('credential-ref');
      expect(node?.meta?.default, name).toBe(defaults[name]);
    }

    // Firecrawl 带默认；AnySearch 回落到搜索面。提取不再提供智谱配置。
    const fetchRef = root?.dict?.fetch;
    const fetchNode = fetchRef === undefined ? undefined : json.refs[String(fetchRef)];
    const firecrawlRef = fetchNode?.dict?.firecrawlApiKeyEnv;
    const firecrawlNode = firecrawlRef === undefined ? undefined : json.refs[String(firecrawlRef)];
    expect(firecrawlNode?.meta?.role).toBe('credential-ref');
    expect(firecrawlNode?.meta?.default).toBe('FIRECRAWL_API_KEY');
    expect(fetchNode?.dict?.zhipuApiKeyEnv).toBeUndefined();
    expect(fetchNode?.dict?.zhipuReaderBaseURL).toBeUndefined();
    for (const name of ['anysearchApiKeyEnv']) {
      const ref = fetchNode?.dict?.[name];
      const node = ref === undefined ? undefined : json.refs[String(ref)];
      expect(node?.meta?.role, name).toBe('credential-ref');
      expect(node?.meta?.default, name).toBeUndefined();
    }
  });

  it('五个 credential-ref 默认全部就位：ZHIPU / ANYSEARCH / ZHIHU / SILICONFLOW / FIRECRAWL', () => {
    const config = Config({});
    const refs = [
      config.apiKeyEnv,
      config.search!.anysearchApiKeyEnv,
      config.search!.zhihuAccessSecretEnv,
      config.search!.siliconflowApiKeyEnv,
      config.fetch!.firecrawlApiKeyEnv,
    ].map(refOf);
    expect(refs).toEqual([
      'ZHIPU_API_KEY',
      'ANYSEARCH_API_KEY',
      'ZHIHU_ACCESS_SECRET',
      'SILICONFLOW_API_KEY',
      'FIRECRAWL_API_KEY',
    ]);
  });
});

describe('apply', () => {
  it('在两个注册表各注册一个 provider，id 均为 aggregated', () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({}));
    expect(stub.searchProviders).toHaveLength(1);
    expect(stub.fetchProviders).toHaveLength(1);
    expect(stub.searchProviders[0]!.id).toBe('aggregated');
    expect(stub.fetchProviders[0]!.id).toBe('aggregated');
    expect(stub.searchProviders[0]!.available()).toBe(true);
    expect(stub.fetchProviders[0]!.available()).toBe(true);
  });

  it('apply 不解析凭证（按次解析、不缓存）', () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({}));
    expect(stub.resolveCalls()).toBe(0);
  });

  it('三路引擎并发：各自解析一次凭证、Bearer 注入、结果聚合为 seam sources', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { rerank: false, zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const provider = stub.searchProviders[0]!;
      const result = await provider.search({ query: '测试' });
      // 三路引擎各解析一次凭证（按次解析、不缓存）
      expect(stub.resolveCalls()).toBe(3);

      const urls = engine.calls.map((call) => call.url);
      expect(urls).toContain('https://api.anysearch.com/v1/search');
      expect(urls).toContain('https://open.bigmodel.cn/api/anthropic/v1/messages');
      expect(urls.some((url) => url.startsWith('https://developer.zhihu.com/api/v1/content/global_search'))).toBe(
        true,
      );
      for (const call of engine.calls) {
        const headers = call.init?.headers as Record<string, string>;
        expect(headers.authorization).toBe('Bearer test-value');
      }

      // 三路结果合并（five sources, no overlap between the fixtures）
      const returned = result.sources.map((entry) => entry.url).sort();
      expect(returned).toEqual(
        [
          'https://a.example.com/one',
          'https://b.example.com/two',
          'https://www.sohu.com/a/897879632_121123890',
          'https://zhuanlan.zhihu.com/p/2234567890',
          'https://www.zhihu.com/question/123456/answer/987654321',
        ].sort(),
      );
      expect(result.truncated).toBe(false);
      // 知乎 EditTime → ISO、智谱 publish_date 原样，穿过管线仍在
      const byUrl = new Map(result.sources.map((entry) => [entry.url, entry]));
      expect(byUrl.get('https://www.zhihu.com/question/123456/answer/987654321')?.publishedAt).toBe(
        new Date(1748261757 * 1000).toISOString(),
      );
      expect(byUrl.get('https://www.sohu.com/a/897879632_121123890')?.publishedAt).toBe('2025-05-23');

      await provider.search({ query: '再测一次' });
      expect(stub.resolveCalls()).toBe(6);
    } finally {
      engine.restore();
    }
  });

  it('maxResults 截断并置 truncated', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false, zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试', maxResults: 2 });
      expect(result.sources).toHaveLength(2);
      expect(result.truncated).toBe(true);
    } finally {
      engine.restore();
    }
  });

  it('rerank 用硅基流动；降级时回 RRF 序并记日志', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { zhihuQuotaCheck: false } }));
    // 硅基流动 429 → 客户端降级为 null，管线保持 RRF 序并记降级日志
    const engine = stubEngineFetch({
      rerank: { status: 429, body: '{"code":429,"message":"rate limited"}' },
    });
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试' });
      expect(result.sources.length).toBeGreaterThan(0);
      expect(engine.calls.some((call) => call.url.includes('siliconflow.cn'))).toBe(true);
      expect(stub.logLines.some((line) => line.includes('重排') && line.includes('降级'))).toBe(true);
    } finally {
      engine.restore();
    }
  });

  it('rerank 成功时按硅基流动返回的索引重排（首位不再是 RRF 首位）', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试', maxResults: 3 });
      // RRF 首位是 AnySearch 的 a.example.com（三路 rank1 同分，按派发序）；
      // 硅基流动夹具把 index 2 提到首位，RRF 序的 pool[2] 是知乎问题那条
      expect(result.sources[0]!.url).toBe('https://www.zhihu.com/question/123456/answer/987654321');
      expect(result.sources[0]!.url).not.toBe('https://a.example.com/one');
      expect(result.sources).toHaveLength(3);
      expect(result.truncated).toBe(true);
    } finally {
      engine.restore();
    }
  });
});

describe('apply 凭证回落链与端点透出', () => {
  it('保存引用名后下一次搜索与提取读取新引用，无需重挂插件', async () => {
    const stub = createStubContext();
    const seen: string[] = [];
    (stub.ctx.credentials as { resolve: (ref: unknown) => Promise<unknown> }).resolve = async (ref) => {
      seen.push(String(ref));
      return { value: 'test-value', source: 'test' };
    };
    const config = Config({ search: { rerank: false, zhihuQuotaCheck: false }, fetch: {} });
    let revision = 'OLD';
    Object.assign(config, { apiKeyEnv: { get: () => `${revision}_ZHIPU` } });
    Object.assign(config.search, {
      anysearchApiKeyEnv: { get: () => `${revision}_ANYSEARCH` },
      zhihuAccessSecretEnv: { get: () => `${revision}_ZHIHU` },
    });
    Object.assign(config.fetch!, { firecrawlApiKeyEnv: { get: () => `${revision}_FIRECRAWL` } });
    apply(stub.ctx, config);
    const engine = stubEngineFetch();
    try {
      await stub.searchProviders[0]!.search({ query: '测试' });
      expect(seen).toEqual(expect.arrayContaining(['OLD_ZHIPU', 'OLD_ANYSEARCH', 'OLD_ZHIHU']));
      revision = 'NEW';
      seen.length = 0;
      await stub.searchProviders[0]!.search({ query: '测试' });
      expect(seen).toEqual(expect.arrayContaining(['NEW_ZHIPU', 'NEW_ANYSEARCH', 'NEW_ZHIHU']));
      expect(seen.some(ref => ref.startsWith('OLD_'))).toBe(false);
      seen.length = 0;
      // These search fixtures have no extraction body; resolution must still use live names.
      await stub.fetchProviders[0]!.fetch({ url: 'https://example.com/page' }).catch(() => undefined);
      expect(seen).toEqual(expect.arrayContaining(['NEW_FIRECRAWL', 'NEW_ANYSEARCH']));
      expect(seen).not.toContain('NEW_ZHIPU');
      expect(seen.some(ref => ref.startsWith('OLD_'))).toBe(false);
    } finally {
      engine.restore();
    }
  });

  it('root apiKeyEnv 控制智谱搜索，提取不解析此引用', async () => {
    const stub = createStubContext();
    const seen: string[] = [];
    (stub.ctx.credentials as { resolve: (ref: unknown) => Promise<unknown> }).resolve = async (ref) => {
      seen.push(String(ref));
      return { value: 'test-value', source: 'test' };
    };
    apply(stub.ctx, Config({ apiKeyEnv: 'MY_ZHIPU_KEY', search: { rerank: false, zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      await stub.searchProviders[0]!.search({ query: '测试' });
      // 搜索面三路各自解析：智谱用 MY_ZHIPU_KEY
      expect(seen).toContain('MY_ZHIPU_KEY');
      expect(seen).not.toContain('ZHIPU_API_KEY');
      // 动态提取不解析智谱凭证；搜索夹具不提供可用提取正文。
      seen.length = 0;
      await stub.fetchProviders[0]!.fetch({ url: 'https://example.com/some/page' }).catch(() => undefined);
      expect(seen).not.toContain('MY_ZHIPU_KEY');
      expect(seen).not.toContain('ZHIPU_API_KEY');
    } finally {
      engine.restore();
    }
  });

  it('search.zhipuApiKeyEnv 覆盖 root apiKeyEnv（显式更专者优先）', async () => {
    const stub = createStubContext();
    const seen: string[] = [];
    (stub.ctx.credentials as { resolve: (ref: unknown) => Promise<unknown> }).resolve = async (ref) => {
      seen.push(String(ref));
      return { value: 'test-value', source: 'test' };
    };
    apply(
      stub.ctx,
      Config({
        apiKeyEnv: 'ROOT_KEY',
        search: { zhipuApiKeyEnv: 'SEARCH_KEY', rerank: false, zhihuQuotaCheck: false },
      }),
    );
    const engine = stubEngineFetch();
    try {
      await stub.searchProviders[0]!.search({ query: '测试' });
      expect(seen).toContain('SEARCH_KEY');
      expect(seen).not.toContain('ROOT_KEY');
    } finally {
      engine.restore();
    }
  });

  it('fetch 面只调用 Firecrawl 与 AnySearch，不解析智谱凭证或调用阅读端点', async () => {
    const stub = createStubContext();
    const seen: string[] = [];
    (stub.ctx.credentials as { resolve: (ref: unknown) => Promise<unknown> }).resolve = async (ref) => {
      seen.push(String(ref));
      return { value: 'test-value', source: 'test' };
    };
    apply(
      stub.ctx,
      Config({
        controls: { preset: 'custom' },
        search: { rerank: false, zhihuQuotaCheck: false },
        fetch: {
          firecrawlApiKeyEnv: 'FC_KEY',
          anysearchApiKeyEnv: 'AS_EXTRACT_KEY',
          firecrawlBaseURL: 'http://127.0.0.1:1/scrape',
          anysearchBaseURL: 'http://127.0.0.1:1',
        },
      }),
    );
    const engine = stubEngineFetch();
    try {
      // 两路都失败时仍解析各自凭证，智谱只用于搜索。
      await expect(stub.fetchProviders[0]!.fetch({ url: 'https://example.com/blog/post' })).rejects.toMatchObject(
        { code: 'WEB_PROVIDER_ERROR' },
      );
      expect(seen).toContain('FC_KEY');
      expect(seen).not.toContain('ZHIPU_API_KEY');
      expect(seen).toContain('AS_EXTRACT_KEY');
      expect(seen).not.toContain('FIRECRAWL_API_KEY');
      expect(seen).not.toContain('ANYSEARCH_API_KEY');
      expect(engine.calls).toHaveLength(2);
      expect(engine.calls.some(call => call.url.includes('/reader'))).toBe(false);
    } finally {
      engine.restore();
    }
  });

  it('search 面端点覆盖生效：请求打到注入的 baseURL', async () => {
    const stub = createStubContext();
    apply(
      stub.ctx,
      Config({
        search: {
          rerank: false,
          zhihuQuotaCheck: false,
          zhipuBaseURL: 'http://127.0.0.1:1/web_search',
          zhipuAnthropicBaseURL: 'http://127.0.0.1:1/anthropic/v1',
          anysearchBaseURL: 'http://127.0.0.1:1',
          zhihuBaseURL: 'http://127.0.0.1:1/global_search',
        },
      }),
    );
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试' });
      // 三路都打到注入端点（mock fetch 兜底服务各面夹具）；智谱默认走 anthropic 通道
      const urls = engine.calls.map((call) => call.url);
      expect(urls).toContain('http://127.0.0.1:1/anthropic/v1/messages');
      expect(urls).toContain('http://127.0.0.1:1/v1/search');
      expect(urls.some((url) => url.startsWith('http://127.0.0.1:1/global_search'))).toBe(true);
      // mock 对非公网端点返回对应夹具：聚合仍成功（证明确实打到了注入地址）
      expect(result.sources.length).toBeGreaterThan(0);
    } finally {
      engine.restore();
    }
  });

  it('search.zhipuTransport=tools-api 时智谱改打工具 API 端点，请求体为工具 API 形状', async () => {
    const stub = createStubContext();
    apply(
      stub.ctx,
      Config({
        search: {
          rerank: false,
          zhihuQuotaCheck: false,
          zhipuTransport: 'tools-api',
          zhipuBaseURL: 'http://127.0.0.1:1/web_search',
        },
      }),
    );
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试', maxResults: 4 });
      const zhipuCall = engine.calls.find((call) => call.url.startsWith('http://127.0.0.1:1/web_search'));
      expect(zhipuCall).toBeDefined();
      expect(JSON.parse(String(zhipuCall!.init?.body))).toEqual({
        search_engine: 'search_pro',
        search_query: '测试',
        search_intent: false,
        content_size: 'medium',
        count: 4,
      });
      // 工具 API 夹具的 URL 进入聚合结果
      expect(result.sources.some((source) => source.url === 'https://www.sohu.com/a/897879632_121123890')).toBe(
        true,
      );
    } finally {
      engine.restore();
    }
  });

  it('search.zhipuAnthropicModel / zhipuAnthropicMaxUses 落入 Messages 请求体', async () => {
    const stub = createStubContext();
    apply(
      stub.ctx,
      Config({
        search: {
          rerank: false,
          zhihuQuotaCheck: false,
          zhipuAnthropicModel: 'glm-4.5-air',
          zhipuAnthropicMaxUses: 6,
        },
      }),
    );
    const engine = stubEngineFetch();
    try {
      await stub.searchProviders[0]!.search({ query: '测试' });
      const call = engine.calls.find((entry) => entry.url.includes('/anthropic/'));
      expect(call).toBeDefined();
      const body = JSON.parse(String(call!.init?.body)) as {
        model: string;
        max_tokens: number;
        tools: { type: string; name: string; max_uses: number }[];
        messages: { role: string; content: string }[];
      };
      expect(body.model).toBe('glm-4.5-air');
      expect(body.max_tokens).toBe(1_024);
      expect(body.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
      ]);
      expect(body.messages).toEqual([{ role: 'user', content: '测试' }]);
      const headers = call!.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-value');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    } finally {
      engine.restore();
    }
  });
});

describe('createAggregatedSearchProvider', () => {
  it('引擎可注入端点覆盖，且不读凭证构造（惰性解析）', () => {
    let resolves = 0;
    const provider = createAggregatedSearchProvider({
      resolveCredential: async () => {
        resolves += 1;
        return 'test-value';
      },
      overrides: {
        anysearchBaseURL: 'http://127.0.0.1:1',
        zhipuBaseURL: 'http://127.0.0.1:1',
        zhihuBaseURL: 'http://127.0.0.1:1',
        zhihuQuotaURL: 'http://127.0.0.1:1',
        rerankBaseURL: 'http://127.0.0.1:1',
      },
    });
    expect(provider.id).toBe('aggregated');
    expect(resolves).toBe(0);
  });
});

describe('引擎失败信号经真实客户端转发熔断', () => {
  it('智谱 429 → rate-limit 熔断，该引擎后续被跳过，其余路照常返回', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false, zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch({
      zhipu: { status: 429, body: '{"error":{"code":"1301","message":"rate limited"}}' },
    });
    try {
      const provider = stub.searchProviders[0]!;
      const first = await provider.search({ query: '测试' });
      expect(first.sources.length).toBeGreaterThan(0);
      // 智谱熔断事件写醒目日志行
      expect(stub.logLines.some((line) => line.includes('熔断') && line.includes('zhipu'))).toBe(true);

      // 第二次搜索：智谱已被熔断，不再派发（配额查询已关，只数搜索请求）
      const before = engine.calls.filter((call) => call.url.includes('bigmodel.cn')).length;
      await provider.search({ query: '再测' });
      const after = engine.calls.filter((call) => call.url.includes('bigmodel.cn')).length;
      expect(after).toBe(before);
      expect(stub.logLines.some((line) => line.includes('zhipu') && line.includes('跳过'))).toBe(true);
    } finally {
      engine.restore();
    }
  });

  it('知乎配额 remaining<=0 → 当日熔断，知乎不派发，其余路照常', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false } }));
    const engine = stubEngineFetch({
      quota: {
        body: JSON.stringify({
          Code: 0,
          Message: 'success',
          Data: [
            { APIID: 'global_search', APIName: '全网搜索', TotalQuota: 5000, TotalUsed: 5000, RemainingQuota: 0 },
          ],
        }),
      },
    });
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试' });
      expect(result.sources.length).toBeGreaterThan(0);
      // 知乎一路被额度熔断跳过：只查过 quota，没有发出 global_search
      expect(engine.calls.some((call) => call.url.includes('/global_search'))).toBe(false);
      expect(stub.logLines.some((line) => line.includes('额度') && line.includes('zhihu'))).toBe(true);
      expect(stub.logLines.some((line) => line.includes('熔断') && line.includes('zhihu'))).toBe(true);
    } finally {
      engine.restore();
    }
  });

  it('知乎 30001 → rate-limit 熔断，该路被丢弃其余照常', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false, zhihuQuotaCheck: false } }));
    const engine = stubEngineFetch({
      zhihu: { status: 200, body: JSON.stringify({ Code: 30001, Message: '请求过于频繁' }) },
    });
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试' });
      expect(result.sources.length).toBeGreaterThan(0);
      expect(stub.logLines.some((line) => line.includes('熔断') && line.includes('zhihu'))).toBe(true);
      // 熔断后追问：知乎不再派发
      const before = engine.calls.filter((call) => call.url.includes('zhihu.com')).length;
      await stub.searchProviders[0]!.search({ query: '再测' });
      expect(engine.calls.filter((call) => call.url.includes('zhihu.com')).length).toBe(before);
    } finally {
      engine.restore();
    }
  });

  it('一路超时不阻塞其余：限时到点丢弃该路并记日志，其余路结果返回', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false, zhihuQuotaCheck: false, maxFanoutMs: 60 } }));
    const originalFetch = globalThis.fetch;
    const anysearch = readFixtureText('anysearch-search-response.json');
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('bigmodel.cn')) {
        // 智谱挂住，超过单引擎限时；限时到点时管线 abort 该路，这里跟着拒绝
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === null || signal === undefined) return;
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return new Response(anysearch, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const started = Date.now();
      const result = await stub.searchProviders[0]!.search({ query: '测试' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.sources.length).toBeGreaterThan(0);
      // 智谱超时：日志带引擎名、延迟与超时原因
      const timeoutLine = stub.logLines.find((line) => line.includes('zhipu') && line.includes('超时'));
      expect(timeoutLine).toBeDefined();
      expect(timeoutLine).toMatch(/\d+ms/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('全败抛 WEB_PROVIDER_ERROR，摘要带各引擎原因', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ search: { rerank: false, zhihuQuotaCheck: false } }));
    const down = { status: 500, body: '{"error":{"code":"500","message":"upstream down"}}' };
    const engine = stubEngineFetch({ anysearch: down, zhipu: down, zhihu: down });
    try {
      await expect(stub.searchProviders[0]!.search({ query: '测试' })).rejects.toThrow(/every engine/i);
      await expect(stub.searchProviders[0]!.search({ query: '测试' })).rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
      });
    } finally {
      engine.restore();
    }
  });
});


describe('live extension settings', () => {
  it('开关保存后下一次搜索与提取改变扩展路数，两个 provider 各注册一次', async () => {
    const stub = createStubContext();
    const config = Config({ controls: { preset: 'custom' }, engines: { tavily: { enabled: false } }, search: { rerank: false, zhihuQuotaCheck: false }, fetch: {} });
    let enabled = false;
    Object.assign(config, { engines: { get: () => ({ tavily: { enabled } }) } });
    apply(stub.ctx, config);
    const fixture = stubEngineFetch();
    const baseFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.includes('api.tavily.com')) return baseFetch(input, init);
      calls.push(url);
      return new Response(JSON.stringify({ results: [{ url: 'https://example.com/article', title: 'fixture', content: 'fixture', raw_content: 'fixture '.repeat(50) }] }),
        { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await stub.searchProviders[0]!.search({ query: 'fixture' });
      expect(calls).toEqual([]);
      enabled = true;
      await stub.searchProviders[0]!.search({ query: 'fixture' });
      expect(calls).toContain('https://api.tavily.com/search');
      await stub.fetchProviders[0]!.fetch({ url: 'https://example.com/article' });
      expect(calls).toContain('https://api.tavily.com/extract');
      enabled = false;
      calls.length = 0;
      await stub.searchProviders[0]!.search({ query: 'fixture' });
      await stub.fetchProviders[0]!.fetch({ url: 'https://example.com/article' }).catch(() => undefined);
      expect(calls).toEqual([]);
      expect(stub.searchProviders).toHaveLength(1);
      expect(stub.fetchProviders).toHaveLength(1);
    } finally { fixture.restore(); }
  });
});
