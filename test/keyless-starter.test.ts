import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { AnySearchClient } from '../src/engines/anysearch/client.js';
import { EngineHttp, additionalBreakerSignal } from '../src/engines/additional/http.js';
import { createAdditionalEngines } from '../src/engines/additional/index.js';

describe('推荐服务的匿名请求', () => {
  it.each([undefined, '', '   '])('AnySearch 空密钥 %s 使用官方匿名搜索与提取', async key => {
    const requests: RequestInit[] = [];
    const client = new AnySearchClient({ resolveApiKey: async () => key, fetchImpl: async (url, init) => {
      requests.push(init!);
      return Response.json({ code: 0, message: 'success', data: String(url).endsWith('/search')
        ? { results: [{ url: 'https://example.com', title: 'Example' }], metadata: { total_results: 1, search_time_ms: 1 } }
        : { url: 'https://example.com', title: 'Example', content: 'Body' } });
    } });
    expect((await client.search({ query: 'Example' })).results).toHaveLength(1);
    expect((await client.extract({ url: 'https://example.com' })).content).toBe('Body');
    expect(requests).toHaveLength(2);
    for (const init of requests) expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('AnySearch 匿名额度耗尽不泄露上游生成的账号，也不自动重试', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ code: -1,
      message: 'username=private-user\npassword=private-password\napi_key=private-key', request_id: '5a3f8c27-1e64-4b90-a752-6d9e2f41c083',
    }, { status: 402 }));
    const client = new AnySearchClient({ resolveApiKey: async () => undefined, fetchImpl });
    const error = await client.search({ query: 'Example' }).catch(error => error);
    expect(error.kind).toBe('quota-exhausted');
    expect(error.authentication).toBe('anonymous');
    expect(error.requestId).toBe('5a3f8c27-1e64-4b90-a752-6d9e2f41c083');
    expect(String(error)).not.toMatch(/private-user|private-password|private-key/);
    expect(JSON.stringify(error)).not.toMatch(/private-user|private-password|private-key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('AnySearch 损坏的匿名错误正文及伪造诊断字段也不会泄露凭证', async () => {
    for (const response of [new Response('password=private-password api_key=private-key', { status: 402 }), Response.json({ code: -1, message: 'private-key', request_id: 'private-key', error_code: 'private-key' }, { status: 402 })]) {
      const client = new AnySearchClient({ resolveApiKey: async () => undefined, fetchImpl: async () => response });
      const error = await client.search({ query: 'Example' }).catch(error => error);
      expect(error.kind).toBe('quota-exhausted');
      expect(String(error)).not.toMatch(/private-password|private-key/);
      expect(String(error.cause)).not.toMatch(/private-password|private-key/);
      expect(JSON.stringify(error)).not.toMatch(/private-password|private-key/);
    }
  });

  it('AnySearch 自定义端点和域名发现仍需密钥', async () => {
    const fetchImpl = vi.fn();
    const custom = new AnySearchClient({ baseURL: 'https://custom.example', resolveApiKey: async () => undefined, fetchImpl });
    await expect(custom.search({ query: 'Example' })).rejects.toMatchObject({ kind: 'config' });
    const official = new AnySearchClient({ resolveApiKey: async () => undefined, fetchImpl });
    await expect(official.listDomains()).rejects.toMatchObject({ kind: 'config' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Tavily 搜索与提取使用 keyless 头，配置密钥后切换账户模式', async () => {
    let key: string | undefined;
    const headers: Headers[] = [];
    const engine = createAdditionalEngines({ tavily: {} }, async () => key, { searchTimeoutMs: 500, fetchTimeoutMs: 500,
      fetchImpl: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ results: [{ url: 'https://example.com', title: 'Example', content: 'Snippet', raw_content: 'Body' }] });
      },
    })[0]!;
    expect((await engine.search({ query: 'Example' })).sources).toHaveLength(1);
    expect((await engine.extract!('https://example.com')).body).toMatchObject({ kind: 'text', content: '# Example\n\nBody' });
    for (const h of headers) { expect(h.get('x-tavily-access-mode')).toBe('keyless'); expect(h.has('authorization')).toBe(false); }
    key = 'test-account-key';
    await engine.search({ query: 'Example' });
    expect(headers[2]!.get('authorization')).toBe('Bearer test-account-key');
    expect(headers[2]!.has('x-tavily-access-mode')).toBe(false);
  });

  it('Tavily 自定义端点、其他路径不使用匿名模式', async () => {
    const fetchImpl = vi.fn();
    for (const [baseURL, path] of [['https://custom.example', '/search'], ['https://api.tavily.com', '/crawl']]) {
      const http = new EngineHttp({ id: 'tavily', baseURL: baseURL!, resolveApiKey: async () => undefined, auth: 'bearer', timeoutMs: 500, fetchImpl });
      await expect(http.call(path!, {})).rejects.toThrow('credential is not configured');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Tavily 429保留退避时间且不输出错误正文', async () => {
    const http = new EngineHttp({ id: 'tavily', baseURL: 'https://api.tavily.com', resolveApiKey: async () => undefined, auth: 'bearer', timeoutMs: 500,
      fetchImpl: async () => Response.json({ error: { message: 'private-error-body' } }, { status: 429, headers: { 'retry-after': '60' } }),
    });
    const error = await http.call('/search', {}).catch(error => error);
    expect(additionalBreakerSignal(error)).toEqual({ kind: 'rate-limit', retryAfterMs: 60000 });
    expect(String(error)).not.toContain('private-error-body');
  });

  it('新安装只开启三家远程推荐服务，保留基础 HTTP 抓取', () => {
    const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
    const config = bundle[1].insert[0].config;
    expect(Object.entries(config.engines).filter(([, value]) => (value as { enabled: boolean }).enabled).map(([id]) => id).sort()).toEqual(['firecrawl', 'tavily']);
    expect(config.controls.serviceEnabled).toEqual({ anysearch: true, firecrawl: true, tavily: true, zhipu: false, zhihu: false, siliconflow: false, http: true });
  });
});
