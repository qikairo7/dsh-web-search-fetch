import { describe, expect, it } from 'vitest';
import { DecisionClient } from '../src/engines/decision/client.js';
import { buildDecisionRequest, parseDecisionDepth } from '../src/engines/decision/wire.js';
import { startMockServer } from './helpers/mock-server.js';

describe('wire', () => {
  it('builds one depth question and parses the choice response', () => {
    const request = buildDecisionRequest('Kev-4b', 'search', '对比两个项目的性能');
    expect(request).toMatchObject({ model: 'Kev-4b', state: { request: 'search', text: '对比两个项目的性能' } });
    expect(parseDecisionDepth({ model: 'Kev-4b', answers: { depth: { type: 'choice', choice: 'deep', confidence: 0.8 } } })).toMatchObject({ depth: 'deep', model: 'Kev-4b', confidence: 0.8 });
    expect(parseDecisionDepth({ model: 'broken', answers: { depth: { choice: 'unknown' } } })).toBeUndefined();
  });
});

describe('client', () => {
  it('posts to the provider endpoint and resolves a decision', async () => {
    const server = await startMockServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model: 'Kev-4b', answers: { depth: { type: 'choice', choice: 'balanced', confidence: 0.7 } } }));
    });
    const client = new DecisionClient({ model: 'Kev-4b', provider: 'siliconflow', resolveApiKey: async () => 'test-key', credentialName: 'SILICONFLOW_API_KEY', baseURL: server.url });
    const outcome = await client.decide('search', 'query');
    expect(outcome).toMatchObject({ depth: 'balanced', model: 'Kev-4b' });
    expect(server.requests[0]!.headers.authorization).toBe('Bearer test-key');
    await server.close();
  });

  it('degrades to null on HTTP failure without leaking credentials', async () => {
    const failures: string[] = [];
    const server = await startMockServer((_request, response) => {
      response.statusCode = 401;
      response.end(JSON.stringify({ code: 401, message: 'invalid key' }));
    });
    const client = new DecisionClient({ model: 'jev-latest', provider: 'typesafe', resolveApiKey: async () => 'test-key', credentialName: 'TYPESAFE_API_KEY', baseURL: server.url, onFailure: (reason, detail) => failures.push(`${reason}: ${detail}`) });
    expect(await client.decide('fetch', 'https://example.com')).toBeNull();
    expect(failersJoin(failures)).toContain('http-error: HTTP 401');
    await server.close();
  });
});

function failersJoin(values: string[]): string {
  return values.join('\n');
}
