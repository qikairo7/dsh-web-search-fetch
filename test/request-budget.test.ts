import { expect, it } from 'vitest';
import { budgetedFetch, operationNotes, requestCount, runOperation, selectServices } from '../src/request-budget.js';

it('reserves permits atomically across concurrent attempts and retries', async () => {
  let sent = 0;
  const fetcher = budgetedFetch(async () => { sent++; return new Response('ok'); });
  await runOperation({ maxRequests: 2 }, 'search', undefined, async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => fetcher('https://example.com')));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(requestCount()).toBe(2);
  });
  expect(sent).toBe(2);
});
it('isolates simultaneous operations and cancels before network dispatch', async () => {
  let sent = 0;
  const fetcher = budgetedFetch(async () => { sent++; return new Response('ok'); });
  await Promise.all([1, 2].map(() => runOperation({ maxRequests: 1 }, 'fetch', undefined, async () => {
    await fetcher('https://example.com');
    await expect(fetcher('https://example.com')).rejects.toThrow('budget exhausted');
  })));
  const cancelled = new AbortController(); cancelled.abort();
  await expect(runOperation({}, 'fetch', cancelled.signal, async () => fetcher('https://example.com'))).rejects.toMatchObject({ code: 'WEB_ABORTED' });
  expect(sent).toBe(2);
});
it('enforces a deadline even when injected work ignores cancellation', async () => {
  await expect(runOperation({ fetchDeadlineMs: 10 }, 'fetch', undefined, () => new Promise(() => {}))).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' });
});
it('uses priority, enabled capability lists, credential presence and preset caps', async () => {
  await runOperation({ preset: 'balanced', searchServices: ['c', 'b', 'a', 'd', 'e'], maxSearchServices: 5 }, 'search', undefined, async () => {
    expect(await selectServices(['a', 'b', 'c', 'd', 'e'], id => id, 'search', async id => id !== 'c')).toEqual(['b', 'a', 'd']);
  });
  await runOperation({ preset: 'free' }, 'search', undefined, async () => {
    expect(await selectServices(['zhipu', 'kimi', 'bing', 'tinyfish', 'github'], id => id, 'search')).toEqual(['bing', 'tinyfish', 'github']);
  });
  await runOperation({ searchServices: [] }, 'search', undefined, async () => {
    expect(await selectServices(['bing'], id => id, 'search')).toEqual([]);
  });
});

it('auto preset keeps simple requests fast and research requests broad without manual switching', async () => {
  const services = ['anysearch', 'firecrawl', 'tavily', 'exa', 'kimi'];
  await runOperation({ preset: 'auto', request: 'search', requestText: 'DeepSeek Harness 使用入门' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch', 'firecrawl', 'tavily']);
    expect(operationNotes().join(' ')).toContain('快速响应');
  });
  await runOperation({ preset: 'auto', request: 'search', requestText: '对比 DeepSeek 与 OpenAI 最新文档' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(services);
    expect(operationNotes().join(' ')).toContain('广覆盖');
  });
});

it('auto preset chooses extraction breadth from the URL instead of asking the user', async () => {
  const services = ['firecrawl', 'anysearch', 'tavily', 'exa', 'kimi'];
  await runOperation({ preset: 'auto', request: 'fetch', requestText: 'https://example.com/docs/guide' }, 'fetch', undefined, async () => {
    expect(await selectServices(services, id => id, 'fetch')).toHaveLength(5);
    expect(operationNotes().join(' ')).toContain('文档提取');
  });
  await runOperation({ preset: 'auto', request: 'fetch', requestText: 'https://example.com/post/article' }, 'fetch', undefined, async () => {
    expect(await selectServices(services, id => id, 'fetch')).toHaveLength(5);
    expect(operationNotes().join(' ')).toContain('深度提取');
  });
  await runOperation({ preset: 'auto', request: 'fetch', requestText: 'https://github.com/org/repo' }, 'fetch', undefined, async () => {
    expect(await selectServices(services, id => id, 'fetch')).toHaveLength(5);
    expect(operationNotes().join(' ')).toContain('文档提取');
  });
  await runOperation({ preset: 'auto', request: 'fetch', requestText: 'https://example.com/data.json' }, 'fetch', undefined, async () => {
    expect(await selectServices(services, id => id, 'fetch')).toHaveLength(3);
    expect(operationNotes().join(' ')).toContain('轻量提取');
  });
});

it('uses the decision model as the primary automatic-routing layer and local rules as failure fallback', async () => {
  const services = ['anysearch', 'firecrawl', 'tavily', 'exa', 'kimi'];
  const controls = (depth: 'fast' | 'balanced' | 'deep' | null) => ({
    preset: 'auto' as const,
    request: 'search' as const,
    requestText: 'DeepSeek Harness 使用入门',
    decision: {
      decide: async () => depth === null ? null : { depth, model: 'Kev-4b', confidence: 0.82 },
    },
  });
  await runOperation(controls('fast'), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch', 'firecrawl', 'tavily']);
    expect(operationNotes().join(' ')).toContain('决策模型 Kev-4b 判定为 fast');
  });
  await runOperation(controls('balanced'), 'search', undefined, async () => {
    expect((await selectServices(services, id => id, 'search'))).toHaveLength(5);
    expect(operationNotes().join(' ')).toContain('置信度 82%');
  });
  await runOperation(controls(null), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch', 'firecrawl', 'tavily']);
    expect(operationNotes().join(' ')).toContain('快速响应');
  });
});
