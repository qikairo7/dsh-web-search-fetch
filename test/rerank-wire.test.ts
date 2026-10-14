import { describe, expect, it } from 'vitest';
import {
  SILICONFLOW_DEFAULT_API_KEY_ENV,
  SILICONFLOW_RERANK_URL,
  RERANK_TIMEOUT_MS,
} from '../src/engines/rerank/limits.js';
import type { RerankResponse } from '../src/engines/rerank/types.js';
import {
  SILICONFLOW_RERANK_MODEL,
  buildRerankRequest,
  clampRerankTopN,
  orderRerankedIndexes,
} from '../src/engines/rerank/wire.js';
import { readFixtureJson } from './helpers/fixtures.js';

describe('buildRerankRequest', () => {
  it('固定 model 与 return_documents=false，query/documents 原样透传', () => {
    const documents = ['标题一\n摘要一', '标题二\n摘要二', '标题三\n摘要三'];
    expect(buildRerankRequest('测试查询', documents, 2)).toEqual({
      model: 'BAAI/bge-reranker-v2-m3',
      query: '测试查询',
      documents,
      top_n: 2,
      return_documents: false,
    });
    expect(SILICONFLOW_RERANK_MODEL).toBe('BAAI/bge-reranker-v2-m3');
  });

  it('top_n 夹取：至少 1，最多 documents.length', () => {
    const documents = ['a', 'b'];
    expect(buildRerankRequest('q', documents, 9).top_n).toBe(2);
    expect(buildRerankRequest('q', documents, 0).top_n).toBe(1);
  });

  it('不主动传分块参数（文档是短拼接，交给模型默认）', () => {
    const request = buildRerankRequest('q', ['a'], 1);
    expect('max_chunks_per_doc' in request).toBe(false);
    expect('overlap_tokens' in request).toBe(false);
  });
});

describe('clampRerankTopN', () => {
  it('夹取到 1–documentCount', () => {
    expect(clampRerankTopN(3, 10)).toBe(3);
    expect(clampRerankTopN(0, 10)).toBe(1);
    expect(clampRerankTopN(-5, 10)).toBe(1);
    expect(clampRerankTopN(99, 10)).toBe(10);
    expect(clampRerankTopN(4.7, 10)).toBe(4);
  });

  it('非有限数退化为 documentCount', () => {
    expect(clampRerankTopN(Number.NaN, 6)).toBe(6);
    expect(clampRerankTopN(Number.POSITIVE_INFINITY, 6)).toBe(6);
  });
});

describe('orderRerankedIndexes', () => {
  it('官方文档样例：按 relevance_score 降序给出原数组下标序列', () => {
    const payload = readFixtureJson<RerankResponse>('siliconflow-rerank-response.json');
    expect(orderRerankedIndexes(payload, 5)).toEqual([2, 0, 4, 3, 1]);
  });

  it('上游顺序不可信：按分数降序重排', () => {
    const payload = {
      results: [
        { index: 1, relevance_score: 0.2 },
        { index: 0, relevance_score: 0.9 },
      ],
    };
    expect(orderRerankedIndexes(payload, 2)).toEqual([0, 1]);
  });

  it('返回完整排列：未上榜的文档按原序接在尾部', () => {
    const payload = {
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
      ],
    };
    expect(orderRerankedIndexes(payload, 4)).toEqual([2, 0, 1, 3]);
  });

  it('越界下标、非整数、非数字分数、重复下标一律跳过', () => {
    const payload = {
      results: [
        { index: 9, relevance_score: 0.9 },
        { index: -1, relevance_score: 0.95 },
        { index: 1, relevance_score: 'high' },
        { index: '1', relevance_score: 0.8 },
        null,
        'not-an-object',
        { index: 0, relevance_score: 0.4 },
        { index: 0, relevance_score: 0.99 },
      ],
    };
    expect(orderRerankedIndexes(payload, 3)).toEqual([0, 1, 2]);
  });

  it('results 缺失、非数组、为空或全部不可用 → undefined（降级信号）', () => {
    expect(orderRerankedIndexes({}, 3)).toBeUndefined();
    expect(orderRerankedIndexes({ results: 'oops' }, 3)).toBeUndefined();
    expect(orderRerankedIndexes({ results: [] }, 3)).toBeUndefined();
    expect(orderRerankedIndexes({ results: [{ index: 7, relevance_score: 0.5 }] }, 3)).toBeUndefined();
    expect(orderRerankedIndexes(null, 3)).toBeUndefined();
  });

  it('documentCount 为 0 → undefined', () => {
    expect(orderRerankedIndexes({ results: [{ index: 0, relevance_score: 0.5 }] }, 0)).toBeUndefined();
  });
});

describe('rerank limits 常量', () => {
  it('端点、凭证 ref 名与默认限时符合 DESIGN §3/§4', () => {
    expect(SILICONFLOW_RERANK_URL).toBe('https://api.siliconflow.cn/v1/rerank');
    expect(SILICONFLOW_DEFAULT_API_KEY_ENV).toBe('SILICONFLOW_API_KEY');
    expect(RERANK_TIMEOUT_MS).toBe(3_000);
  });
});
