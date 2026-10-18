/**
 * 目标站非 2xx 的状态码必须作为结果返回，而不是变成"引擎不可用"。
 *
 * seam 契约（`@deepseek-ai/dsh-web` 的 `WebFetchResult`）写明：成功取回一个非
 * 2xx 响应是**结果**，不是错误，状态码是资源状态的一部分。探测（`probeVerdict`）
 * 也据此把 `non-2xx` 判为不足并升级多路整理。
 *
 * Crawl4AI Cloud 对目标站的 4xx 不返回 200 信封，而是回 HTTP 502
 * `{"error":"origin-error:404"}` 并在 `origin_status` 里带站点自己的码
 * （见 https://api.crawl4ai.com/llms.txt）。适配器把整个 502 当成
 * "引擎不可用"抛出时，目标站的 404 就此丢失，与引擎真的挂掉无法区分。
 *
 * 断言是硬的：目标站 404 必须**作为结果**返回 `statusCode: 404`。不接受
 * "抛错但消息里含 404"——那只是把状态降级成错误文本，探测逻辑拿不到它。
 * @module test/fetch-target-status
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAdditionalEngines, type AdditionalEngineId } from '../src/engines/additional/index.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

const target = 'https://example.com/missing-page';
const secret = async () => 'test-secret';

async function extract(id: AdditionalEngineId, status: number, payload: unknown) {
  server = await startMockServer((_request, response) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  const engine = createAdditionalEngines(
    { [id]: { baseURL: server.url, fetchBaseURL: server.url } },
    secret,
    { searchTimeoutMs: 500, fetchTimeoutMs: 500 },
  )[0]!;
  return await engine.extract!(target).then(
    result => ({ kind: 'result' as const, result }),
    error => ({ kind: 'error' as const, error }),
  );
}

describe('目标站非 2xx 状态抵达调用方', () => {
  it('crawl4ai：目标站 404 作为结果返回，而不是抛成引擎不可用', async () => {
    // 形状来源：https://api.crawl4ai.com/llms.txt
    // 「a 502 "origin-error:<n>" means the site itself answered an error
    //  (its own code is in the reason and in `origin_status`)」
    const outcome = await extract('crawl4ai', 502, {
      error: 'origin-error:404',
      origin_status: 404,
    });

    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(outcome.result.statusCode).toBe(404);
  });

  it('crawl4ai：目标站 200 仍返回 200', async () => {
    const outcome = await extract('crawl4ai', 200, { ok: true, markdown: 'Body' });
    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') expect(outcome.result.statusCode).toBe(200);
  });

  it('crawl4ai：没有 origin_status 的 502 仍是引擎失败', async () => {
    // 引擎自己的故障（余额、限流、宕机）不得被误判成目标站状态。
    const outcome = await extract('crawl4ai', 502, { error: 'no-answer:empty-render' });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect((outcome.error as { code?: string }).code).toBe('WEB_PROVIDER_ERROR');
    }
  });

  it('crawl4ai 搜索通道不受目标状态读取影响', async () => {
    // 搜索响应没有目标站；错误信封必须仍是引擎失败，而不是被读成目标站状态。
    server = await startMockServer((_request, response) => {
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'origin-error:404', origin_status: 404 }));
    });
    const engine = createAdditionalEngines(
      { crawl4ai: { baseURL: server.url, fetchBaseURL: server.url } },
      secret,
      { searchTimeoutMs: 500, fetchTimeoutMs: 500 },
    )[0]!;
    await expect(engine.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' });
  });
});
