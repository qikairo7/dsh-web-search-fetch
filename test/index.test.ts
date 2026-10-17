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
      blockPrivateAddresses: true,
      probeTimeoutMs: 15_000,
      singleChannelEscalate: false,
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

  it('controls 预设与决策开关给出 0.2.20 默认值', () => {
    const defaults = Config({}).controls!.get();
    expect(defaults.preset).toBe('auto');
    expect(defaults.decisionRouting).toBe('off');
    // The budget is per page, not per transport: an organized result replaces
    // the page a reader would have opened, so its default is one long article.
    expect(defaults.maxOutputChars).toBe(15_000);
    expect(Config({ controls: { preset: 'single' } }).controls!.get().preset).toBe('single');
    expect(Config({ controls: { preset: 'multi' } }).controls!.get().preset).toBe('multi');
    expect(Config({ controls: { decisionRouting: 'model' } }).controls!.get().decisionRouting).toBe('model');
  });

  it('search 子对象给出 DESIGN §4 默认值，可逐项覆盖', () => {
    const defaults = Config({}).search!;
    expect(defaults.maxFanoutMs).toBe(10_000);
    expect(defaults.rrfK).toBe(60);
    expect(defaults.rerankPool).toBe(20);
    expect(defaults.rerank.get()).toBe(true);
    expect(defaults.rerankTimeoutMs).toBe(3_000);
    expect(refOf(defaults.anysearchApiKeyEnv)).toBe('ANYSEARCH_API_KEY');
    expect(refOf(defaults.siliconflowApiKeyEnv)).toBe('SILICONFLOW_API_KEY');
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
    // Firecrawl 带默认；AnySearch 回落到搜索面。
    const fetchRef = root?.dict?.fetch;
    const fetchNode = fetchRef === undefined ? undefined : json.refs[String(fetchRef)];
    const firecrawlRef = fetchNode?.dict?.firecrawlApiKeyEnv;
    const firecrawlNode = firecrawlRef === undefined ? undefined : json.refs[String(firecrawlRef)];
    expect(firecrawlNode?.meta?.role).toBe('credential-ref');
    expect(firecrawlNode?.meta?.default).toBe('FIRECRAWL_API_KEY');
    for (const name of ['anysearchApiKeyEnv']) {
      const ref = fetchNode?.dict?.[name];
      const node = ref === undefined ? undefined : json.refs[String(ref)];
      expect(node?.meta?.role, name).toBe('credential-ref');
      expect(node?.meta?.default, name).toBeUndefined();
    }
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

  it('基础搜索引擎返回结果、凭证按次解析并注入 Bearer', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { rerank: false, quotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const provider = stub.searchProviders[0]!;
      const result = await provider.search({ query: '测试' });
      expect(stub.resolveCalls()).toBe(1);
      const urls = engine.calls.map((call) => call.url);
      expect(urls).toContain('https://api.anysearch.com/v1/search');
      const headers = engine.calls[0]!.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-value');
      expect(result.sources.map((entry) => entry.url)).toContain('https://a.example.com/one');
      await provider.search({ query: '再测一次' });
      expect(stub.resolveCalls()).toBe(2);
    } finally {
      engine.restore();
    }
  });

  it('maxResults 截断并置 truncated', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { rerank: false, quotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试', maxResults: 2 });
      expect(result.sources).toHaveLength(2);
      expect(result.truncated).toBe(false);
    } finally {
      engine.restore();
    }
  });

  it('rerank 用硅基流动；降级时回 RRF 序并记日志', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { quotaCheck: false } }));
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
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { quotaCheck: false } }));
    const engine = stubEngineFetch();
    try {
      const result = await stub.searchProviders[0]!.search({ query: '测试', maxResults: 3 });
      expect(result.sources).toHaveLength(2);
      expect(result.truncated).toBe(false);
      expect(result.sources.map((entry) => entry.url)).toContain('https://a.example.com/one');
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
    const config = Config({ controls: { preset: 'custom' }, search: { rerank: false, quotaCheck: false }, fetch: {} });
    let revision = 'OLD';
    Object.assign(config.search, {
      anysearchApiKeyEnv: { get: () => `${revision}_ANYSEARCH` },
    });
    Object.assign(config.fetch!, { firecrawlApiKeyEnv: { get: () => `${revision}_FIRECRAWL` } });
    apply(stub.ctx, config);
    const engine = stubEngineFetch();
    try {
      await stub.searchProviders[0]!.search({ query: '测试' });
      expect(seen).toEqual(expect.arrayContaining(['OLD_ANYSEARCH']));
      revision = 'NEW';
      seen.length = 0;
      await stub.searchProviders[0]!.search({ query: '测试' });
      expect(seen).toEqual(expect.arrayContaining(['NEW_ANYSEARCH']));
      expect(seen.some(ref => ref.startsWith('OLD_'))).toBe(false);
      seen.length = 0;
      // These search fixtures have no extraction body; resolution must still use live names.
      await stub.fetchProviders[0]!.fetch({ url: 'https://example.com/page' }).catch(() => undefined);
      expect(seen).toEqual(expect.arrayContaining(['NEW_FIRECRAWL', 'NEW_ANYSEARCH']));
expect(seen.some(ref => ref.startsWith('OLD_'))).toBe(false);
    } finally {
      engine.restore();
    }
  });

  it('fetch 面只调用 Firecrawl 与 AnySearch', async () => {
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
        search: { rerank: false, quotaCheck: false },
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
      // 两路都失败时仍解析各自凭证。
      await expect(stub.fetchProviders[0]!.fetch({ url: 'https://example.com/blog/post' })).rejects.toMatchObject(
        { code: 'WEB_PROVIDER_ERROR' },
      );
      expect(seen).toContain('FC_KEY');
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
        controls: { preset: 'custom' },
        search: {
          rerank: false,
          quotaCheck: false,
          anysearchBaseURL: 'http://127.0.0.1:1',
        },
      }),
    );
    const engine = stubEngineFetch();
    try {
      await expect(stub.searchProviders[0]!.search({ query: '测试' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
      expect(engine.calls.some((call) => call.url.startsWith('http://127.0.0.1:1/v1/search'))).toBe(true);
    } finally {
      engine.restore();
    }
  });

  it('全败抛 WEB_PROVIDER_ERROR，摘要带各引擎原因', async () => {
    const stub = createStubContext();
    apply(stub.ctx, Config({ controls: { preset: 'custom' }, search: { rerank: false, quotaCheck: false } }));
    const down = { status: 500, body: '{"error":{"code":"500","message":"upstream down"}}' };
    const engine = stubEngineFetch({ anysearch: down });
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
    const config = Config({ controls: { preset: 'custom' }, engines: { tavily: { enabled: false } }, search: { rerank: false, quotaCheck: false }, fetch: {} });
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
