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
    expect(await selectServices(['tavily', 'kimi', 'bing', 'tinyfish', 'github'], id => id, 'search')).toEqual(['bing', 'tinyfish', 'github']);
  });
  await runOperation({ searchServices: [] }, 'search', undefined, async () => {
    expect(await selectServices(['bing'], id => id, 'search')).toEqual([]);
  });
});

it('auto preset keeps simple requests single-channel and research requests multi-channel without manual switching', async () => {
  const services = ['anysearch', 'firecrawl', 'tavily', 'exa', 'kimi'];
  // The local rule is the default: a plain request uses one channel …
  await runOperation({ preset: 'auto', request: 'search', requestText: 'DeepSeek Harness 使用入门' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
    expect(operationNotes().join(' ')).toContain('单通道');
  });
  // … and a comparison/research intent fans out.
  await runOperation({ preset: 'auto', request: 'search', requestText: '对比 DeepSeek 与 OpenAI 最新文档' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(services);
    expect(operationNotes().join(' ')).toContain('多通道');
  });
  // The explicit presets name the breadth directly.
  await runOperation({ preset: 'single', request: 'search', requestText: '对比 DeepSeek 与 OpenAI 最新文档' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
  });
  await runOperation({ preset: 'multi', request: 'search', requestText: 'DeepSeek Harness 使用入门' }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(services);
  });
});

it('auto preset treats Chinese recency words as multi-channel and leaves non-recency Chinese requests single-channel', async () => {
  const services = ['anysearch', 'firecrawl', 'tavily', 'exa', 'kimi'];
  const breadth = async (requestText: string) => {
    let selected: string[] = [];
    await runOperation({ preset: 'auto', request: 'search', requestText }, 'search', undefined, async () => {
      selected = await selectServices(services, id => id, 'search');
    });
    return selected;
  };
  // The bug report's query: a Chinese recency word alone must fan out.
  expect(await breadth('今天 AI 大模型 新闻')).toEqual(services);
  for (const query of ['今日 AI 要闻', '近期大模型进展', '最近发布的模型', '本周 AI 热点', '国产模型快讯']) {
    expect(await breadth(query), query).toEqual(services);
  }
  // English recency and research words keep working.
  for (const query of ['latest AI model news', 'AI research benchmark comparison']) {
    expect(await breadth(query), query).toEqual(services);
  }
  // A plain Chinese request with no recency or research intent stays single-channel.
  for (const query of ['如何安装 Node.js', 'Python 列表排序', 'Docker 容器入门教程']) {
    expect(await breadth(query), query).toEqual(['anysearch']);
  }
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

it('decision routing is opt-in, and an unavailable model degrades to the local rule', async () => {
  const services = ['anysearch', 'firecrawl', 'tavily', 'exa', 'kimi'];
  const controls = (depth: 'fast' | 'balanced' | 'deep' | null, outcome: 'ok' | 'throw' = 'ok') => ({
    preset: 'auto' as const,
    decisionRouting: 'model' as const,
    request: 'search' as const,
    requestText: 'DeepSeek Harness 使用入门',
    decision: {
      decide: async () => {
        if (outcome === 'throw') throw new Error('decision endpoint returned 503');
        return depth === null ? null : { depth, model: 'Kev-4b', confidence: 0.82 };
      },
    },
  });
  // fast/balanced/deep map onto 1/3/all channels.
  await runOperation(controls('fast'), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
    expect(operationNotes().join(' ')).toContain('决策模型 Kev-4b 判定为 fast');
  });
  await runOperation(controls('balanced'), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toHaveLength(3);
    expect(operationNotes().join(' ')).toContain('置信度 82%');
  });
  await runOperation(controls('deep'), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(services);
  });
  // An unusable or unreachable model never fails the search: the local rule runs.
  await runOperation(controls(null), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
    expect(operationNotes().join(' ')).toContain('改用本地规则');
  });
  await runOperation(controls('deep', 'throw'), 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
    expect(operationNotes().join(' ')).toContain('改用本地规则');
  });
  // Without the opt-in, the model is never consulted.
  await runOperation({ ...controls('deep'), decisionRouting: 'off' as const }, 'search', undefined, async () => {
    expect(await selectServices(services, id => id, 'search')).toEqual(['anysearch']);
    expect(operationNotes().join(' ')).not.toContain('决策模型');
  });
});
