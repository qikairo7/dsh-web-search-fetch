import { describe, expect, it } from 'vitest';
import type { WebSearchRequest } from '@deepseek-ai/dsh-web';
import { CircuitBreaker } from '../src/breaker/index.js';
import { AggregatedSearchProvider } from '../src/search-aggregate.js';
import type { SearchEngineClient } from '../src/search-aggregate.js';

const engine = (id: string, sources: readonly { url: string; title?: string; snippet?: string }[]): SearchEngineClient => ({
  id,
  search: async () => ({ sources, truncated: false }),
});

/** Records what the provider asked the rerank stage to do. */
function recordingReranker() {
  const calls: { documents: readonly string[] }[] = [];
  return {
    calls,
    rerank: {
      rerank: async (_query: string, documents: readonly string[]) => {
        calls.push({ documents });
        return documents.map((_doc, index) => index);
      },
    },
  };
}

describe('搜索相关性过滤', () => {
  it('查询有 ≥2 个有效词、结果全不相干 → 空 sources + 说明', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [{ url: 'https://unrelated.test/x', title: 'Weather forecast', snippet: 'Sunny.' }])],
    });
    const output = await provider.search({ query: 'zxqvj plorptastic nonsense token' });
    expect(output.sources).toEqual([]);
    expect(output.content).toContain('未找到与查询相关的结果');
    expect(output.truncated).toBe(false);
  });

  it('相关的结果保留，不相干的被剔除', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [
        { url: 'https://docs.test/deepseek', title: 'DeepSeek Harness guide' },
        { url: 'https://unrelated.test/x', title: 'Weather forecast' },
      ])],
    });
    const output = await provider.search({ query: 'DeepSeek Harness guide' });
    expect(output.sources.map(source => source.url)).toEqual(['https://docs.test/deepseek']);
  });

  it('单词查询且是连字符复合 token → 仍按词元交集过滤', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [
        { url: 'https://github.com/gwtproject/gwt/issues/9931', title: 'Issue 9931' },
        { url: 'https://convertilo.com/9931-pounds-to-ounces', title: '9931 pounds to ounces' },
      ])],
    });
    const output = await provider.search({ query: 'zxqvj-9931-plorptastic-nonsense-token' });
    expect(output.sources).toEqual([]);
    expect(output.content).toContain('未找到与查询相关的结果');
  });

  it('单词查询不是复合 token → 保留（信息不足，不过滤）', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [{ url: 'https://example.test/x', title: 'Something else entirely' }])],
    });
    expect((await provider.search({ query: '上海天气' })).sources).toHaveLength(1);
  });

  it('有意义的连字符复合查询仍能命中', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [
        { url: 'https://github.com/deepseek-ai/deepseek-harness', title: 'deepseek-harness guide' },
        { url: 'https://unrelated.test/x', title: 'Weather forecast' },
      ])],
    });
    const output = await provider.search({ query: 'deepseek-harness-guide' });
    expect(output.sources.map(source => source.url)).toEqual(['https://github.com/deepseek-ai/deepseek-harness']);
  });

  it('单有效词或 site: 过滤不做相关性过滤（信息不足）', async () => {
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      engines: [engine('a', [{ url: 'https://example.test/x', title: 'Something else entirely' }])],
    });
    const output = await provider.search({ query: 'пример' });
    expect(output.sources).toHaveLength(1);
  });
});

describe('single 预设的搜索行为', () => {
  it('不调用重排，也不做官方域名补充检索', async () => {
    const queries: string[] = [];
    const reranker = recordingReranker();
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      resolveControls: () => ({ preset: 'single' }),
      rerank: reranker.rerank,
      engines: ['a', 'b'].map(id => ({
        id,
        search: async (request: WebSearchRequest) => {
          queries.push(request.query);
          return { truncated: false, sources: [{ url: `https://${id}.test/python-guide`, title: 'Python guide reference' }] };
        },
      })),
    });
    const output = await provider.search({ query: 'Python official documentation guide', maxResults: 5 });
    expect(reranker.calls).toHaveLength(0);
    expect(queries).toEqual(['Python official documentation guide']);
    expect(output.sources).toHaveLength(1);
  });

  it('multi 预设照常重排', async () => {
    const reranker = recordingReranker();
    const provider = new AggregatedSearchProvider({
      breaker: new CircuitBreaker(),
      resolveControls: () => ({ preset: 'multi' }),
      rerank: reranker.rerank,
      engines: ['a', 'b'].map(id => ({ id, search: async () => ({ truncated: false, sources: [{ url: `https://${id}.test/guide`, title: 'Guide reference' }] }) })),
    });
    await provider.search({ query: 'Guide reference', maxResults: 5 });
    expect(reranker.calls).toHaveLength(1);
  });
});
