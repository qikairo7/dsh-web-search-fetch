/**
 * 生产链路保护：目标站 404 作为**结果**抵达聚合、探测与调用方。
 *
 * `test/fetch-target-status.test.ts` 锁的是单个适配器的返回形状；
 * `test/fetch-aggregate.test.ts` 里那条 `new TargetStatusError()` 腿是合成的，
 * 生产走不到（适配器已经把错误转成结果）。本文件补上中间那段：
 * `createAdditionalEngines` → 适配器 → `EngineHttp` → `AggregatedFetchProvider`
 * → 探测/聚合 → 调用方，用回环 mock server 走真实 HTTP。
 *
 * 契约（用户 2026-10-20 澄清，见 .scratch/dev-loop/fix-eight-p21-contract-20261020.md）：
 * Crawl4AI 的 502 + `origin_status: 404` 必须以 `statusCode: 404` 结果交给调用方，
 * 不能被错报成「引擎不可用」；没有 `origin_status` 的 502 与 AnySearch 的
 * 422 `extract_failed` 仍是 provider 失败。
 * @module test/fetch-target-status-product-path
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebError } from '@deepseek-ai/dsh-web';
import { AggregatedFetchProvider, createExtractionLegs } from '../src/fetch-pipeline.js';
import { createAdditionalEngines } from '../src/engines/additional/index.js';
import { AnySearchEngine } from '../src/engines/anysearch/index.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import type { RuntimeControls } from '../src/request-budget.js';

const target = 'https://example.com/missing-page';
const secret = async () => 'test-secret';

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function catchError(promise: Promise<unknown>): Promise<WebError> {
  const error = await promise.then(
    () => { throw new Error('expected the fetch to reject, but it resolved'); },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WebError);
  return error as WebError;
}

/**
 * The real provider chain over a loopback server answering Crawl4AI's
 * documented target-error shape (https://api.crawl4ai.com/llms.txt:
 * a 502 `origin-error:<n>` carries the site's own code in `origin_status`).
 */
async function crawl4aiProvider(payload: unknown, controls: RuntimeControls, logged: string[] = []): Promise<AggregatedFetchProvider> {
  server = await startMockServer((_request, response) => {
    response.statusCode = 502;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  const engines = createAdditionalEngines(
    { crawl4ai: { baseURL: server.url, fetchBaseURL: server.url } },
    secret,
    { searchTimeoutMs: 500, fetchTimeoutMs: 500 },
  );
  return new AggregatedFetchProvider({
    additionalEngines: engines,
    legs: [],
    route: { staticDomains: [] },
    blockPrivateAddresses: false,
    logger: { info: message => logged.push(message), warn: message => logged.push(message) },
    resolveControls: () => ({ mode: 'organize', fetchServices: ['crawl4ai'], ...controls }),
  });
}

describe('生产链路：Crawl4AI 的目标站 404 以结果抵达调用方', () => {
  it('502 + origin_status:404 → statusCode 404 结果，不报引擎不可用', async () => {
    const provider = await crawl4aiProvider({ error: 'origin-error:404', origin_status: 404 }, { preset: 'custom' });
    const result = await provider.fetch({ url: target });
    expect(result.statusCode).toBe(404);
    expect(result.body.content).toContain('404');
  });

  it('自动预设：首路探测判为不足并升级，站点码仍是返回值而非全败错误', async () => {
    const logged: string[] = [];
    const provider = await crawl4aiProvider({ error: 'origin-error:404', origin_status: 404 }, { preset: 'auto' }, logged);
    const result = await provider.fetch({ url: target });
    expect(result.statusCode).toBe(404);
    expect(result.body.content).toContain('404');
    // 探测把非 2xx 判为不足并升级；没有任何一路被标成引擎不可用。
    expect(logged.join('\n')).toContain('不足');
    expect(logged.join('\n')).not.toContain('engine-unavailable');
  });

  it('没有 origin_status 的 502 仍是 provider 失败，归 engine-unavailable', async () => {
    const provider = await crawl4aiProvider({ error: 'no-answer:empty-render' }, { preset: 'custom' });
    const error = await catchError(provider.fetch({ url: target }));
    expect(error.code).toBe('WEB_PROVIDER_ERROR');
    expect(error.message).toContain('engine-unavailable');
    expect(error.message).not.toContain('target-rejected');
  });

  it('另一路失败时，404 结果仍被返回，而不是被并进全败的引擎不可用', async () => {
    server = await startMockServer((_request, response) => {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'origin-error:404', origin_status: 404 }));
    });
    const engines = createAdditionalEngines(
      { crawl4ai: { baseURL: server.url, fetchBaseURL: server.url } },
      secret,
      { searchTimeoutMs: 500, fetchTimeoutMs: 500 },
    );
    const logged: string[] = [];
    const provider = new AggregatedFetchProvider({
      additionalEngines: engines,
      legs: [{ engineId: 'tavily', extract: async () => { throw new WebError('tavily: HTTP 503', 'WEB_PROVIDER_ERROR'); } }],
      route: { staticDomains: [] },
      blockPrivateAddresses: false,
      logger: { info: message => logged.push(message), warn: message => logged.push(message) },
      resolveControls: () => ({ mode: 'organize', preset: 'custom', fetchServices: ['tavily', 'crawl4ai'] }),
    });
    const result = await provider.fetch({ url: target });
    expect(result.statusCode).toBe(404);
    expect(result.body.content).toContain('404');
    expect(logged.join('\n')).toContain('crawl4ai 成功：状态 404');
    expect(logged.join('\n')).toContain('tavily 失败');
  });
});

describe('生产链路：AnySearch 422 extract_failed 仍是 provider 失败', () => {
  it('HTTP 422 envelope → engine-unavailable，不被读成目标站状态', async () => {
    server = await startMockServer((_request, response) => {
      response.statusCode = 422;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 42201, message: 'extract failed', error_code: 'extract_failed' }));
    });
    const anysearch = new AnySearchEngine({
      resolveApiKey: async () => 'as_sk_test_key',
      credentialName: 'ANYSEARCH_API_KEY',
      baseURL: server.url,
      timeoutMs: 500,
    });
    const provider = new AggregatedFetchProvider({
      legs: createExtractionLegs({
        firecrawl: { scrape: async () => { throw new WebError('must not be dispatched', 'WEB_PROVIDER_ERROR'); } },
        anysearch,
      }),
      resolveControls: () => ({ mode: 'organize', preset: 'custom', fetchServices: ['anysearch'] }),
      blockPrivateAddresses: false,
    });
    const error = await catchError(provider.fetch({ url: target }));
    expect(error.code).toBe('WEB_PROVIDER_ERROR');
    expect(error.message).toContain('engine-unavailable');
    expect(error.message).not.toContain('target-rejected');
    expect(error.message).toContain('anysearch');
  });
});
