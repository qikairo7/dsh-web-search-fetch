import { afterEach, describe, expect, it } from 'vitest';
import { AnySearchClient } from '../src/engines/anysearch/client.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';
import './helpers/anysearch-network-guard.js';

let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('AnySearch 高级请求', () => {
  it('垂直参数完整进入 HTTP 请求', async () => {
    server = await startMockServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, data: { results: [], metadata: { total_results: 0, search_time_ms: 1 } } }));
    });
    const client = new AnySearchClient({ baseURL: server.url, resolveApiKey: async () => 'test-key' });
    const request = { query: 'papers', maxResults: 3, tag: 'academic/arxiv', params: { year: 2026, reviewed: true }, zone: 'intl' as const, language: 'en' };
    await client.search(request);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ query: 'papers', max_results: 3, tag: request.tag, params: request.params, zone: 'intl', language: 'en' });
  });

  it('能力目录使用 GET、保留端点路径并编码领域，每次请求重新解析凭证', async () => {
    server = await startMockServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: 0, request_id: 'catalog-id', data: { domains: [] } }));
    });
    let key = 'first-key';
    const client = new AnySearchClient({ baseURL: `${server.url}/api/`, resolveApiKey: async () => key });
    expect(await client.listDomains()).toEqual({ requestId: 'catalog-id', domains: [] });
    key = 'second-key';
    await client.getSubDomains(['finance & legal', '学术']);
    expect(server.requests.map(request => [request.method, request.body, request.headers.authorization])).toEqual([
      ['GET', '', 'Bearer first-key'], ['GET', '', 'Bearer second-key'],
    ]);
    expect(server.requests[0]!.url).toBe('/api/v1/domains');
    const url = new URL(server.requests[1]!.url, server.url);
    expect(url.pathname).toBe('/api/v1/sub-domains');
    expect(url.searchParams.getAll('domain')).toEqual(['finance & legal', '学术']);
  });

  it('拒绝形状错误的能力目录，并保留操作与请求编号', async () => {
    server = await startMockServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const domains = request.url.endsWith('/domains')
        ? [{ domain: 'finance', description: 'Finance', sub_domain_count: -1 }]
        : [{ domain: 'finance', description: 'Finance', sub_domains: [{ sub_domain: 'finance.quote', description: 'Quote', params: { ticker: { description: 'Symbol', required: 'yes' } } }] }];
      response.end(JSON.stringify({ code: 0, request_id: 'bad-catalog', data: { domains } }));
    });
    const client = new AnySearchClient({ baseURL: server.url, resolveApiKey: async () => 'test-key' });
    await expect(client.listDomains()).rejects.toMatchObject({ operation: 'domains', requestId: 'bad-catalog' });
    await expect(client.getSubDomains(['finance'])).rejects.toMatchObject({ operation: 'sub_domains', requestId: 'bad-catalog' });
  });
});
