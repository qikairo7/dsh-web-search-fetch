/**
 * Contract tests for the AnySearch engine's pure wire layer: envelope
 * narrowing, response parsing, and the mapping into the seam's vocabulary.
 * No HTTP and no credentials here — these are value-in/value-out calls.
 */
import { describe, expect, it } from 'vitest';
import {
  endpoint,
  envelopeData,
  isAbsoluteHttpUrl,
  mapExtractResponse,
  mapSearchResponse,
  parseExtractData,
  parseSearchData,
  readEnvelope,
} from '../src/engines/anysearch/wire.js';
import { MAX_CANONICAL_CONTENT_CHARS } from '../src/engines/anysearch/limits.js';
import { readFixtureJson } from './helpers/fixtures.js';

/** Wrap a `data` payload in a successful envelope. */
function successEnvelope(data: unknown, requestId = 'req_1'): unknown {
  return { code: 0, message: 'success', request_id: requestId, data };
}

/** Parse an envelope straight through to search data. */
function parseSearch(data: unknown) {
  return parseSearchData(envelopeData(readEnvelope(successEnvelope(data))));
}

describe('endpoint 拼接', () => {
  it('保留 baseURL 的路径前缀并追加 API 路径', () => {
    expect(endpoint('https://api.anysearch.com', '/v1/search')).toBe(
      'https://api.anysearch.com/v1/search',
    );
    expect(endpoint('https://api.anysearch.test/root/', '/v1/search')).toBe(
      'https://api.anysearch.test/root/v1/search',
    );
  });

  it('剥掉 baseURL 自带的 query 与锚点', () => {
    expect(endpoint('https://api.anysearch.test/root?x=1#frag', '/v1/extract')).toBe(
      'https://api.anysearch.test/root/v1/extract',
    );
  });

  it('非 HTTP(S) 或非法 baseURL 返回 undefined（供 available() 判定）', () => {
    expect(endpoint('file:///tmp/api', '/v1/search')).toBeUndefined();
    expect(endpoint('not a url', '/v1/search')).toBeUndefined();
    expect(endpoint('ftp://api.anysearch.test', '/v1/search')).toBeUndefined();
  });
});

describe('isAbsoluteHttpUrl', () => {
  it('只接受绝对 HTTP(S) URL', () => {
    expect(isAbsoluteHttpUrl('https://example.com/a')).toBe(true);
    expect(isAbsoluteHttpUrl('http://example.com/a')).toBe(true);
    expect(isAbsoluteHttpUrl('/relative/path')).toBe(false);
    expect(isAbsoluteHttpUrl('file:///private')).toBe(false);
    expect(isAbsoluteHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isAbsoluteHttpUrl('')).toBe(false);
  });
});

describe('信封校验', () => {
  it('读取 code/message/request_id/error_code/data', () => {
    const envelope = readEnvelope({
      code: -1,
      message: 'Target is blocked by Extract policy.',
      request_id: 'req_blocked',
      error_code: 'extract_target_blocked',
      data: null,
    });
    expect(envelope).toEqual({
      code: -1,
      message: 'Target is blocked by Extract policy.',
      requestId: 'req_blocked',
      errorCode: 'extract_target_blocked',
      data: null,
    });
  });

  it('错误信封的 data: null 不算形状错误（只有成功的信封才要求 data 是对象）', () => {
    expect(() => readEnvelope({ code: 42903, message: 'rate_limit_exceeded', data: null })).not.toThrow();
    expect(() => envelopeData(readEnvelope({ code: 0, message: 'ok', data: null }))).toThrow(
      'data must be an object',
    );
  });

  it('code 缺失或非数字 → 报出字段路径', () => {
    expect(() => readEnvelope({ message: 'x', data: {} })).toThrow('code must be a number');
    expect(() => readEnvelope('not an object')).toThrow('response must be an object');
    expect(() => readEnvelope(null)).toThrow('response must be an object');
    expect(() => readEnvelope([1, 2])).toThrow('response must be an object');
  });

  it('request_id 类型不对 → 报错，不静默丢弃', () => {
    expect(() => readEnvelope({ code: 0, message: 'ok', request_id: 42, data: {} })).toThrow(
      'request_id must be a string',
    );
  });
});

describe('search 响应解析', () => {
  it('夹具信封 → 校验后的结果与 metadata', () => {
    const response = parseSearchData(
      envelopeData(readEnvelope(readFixtureJson('anysearch-search-response.json'))),
    );
    expect(response.requestId).toBe('req_search_1');
    expect(response.results).toEqual([
      { title: 'Result A', url: 'https://a.example.com/one', snippet: 'First summary' },
      { title: 'Result B', url: 'https://b.example.com/two', snippet: 'Second summary' },
    ]);
    expect(response.metadata).toEqual({ totalResults: 2, searchTimeMs: 37 });
  });

  it('无 url 的结构化结果保留在解析层，并计入 urlLessResults', () => {
    const response = parseSearch({
      results: [
        { title: 'Web source', url: 'https://source.test/result', content: 'citeable' },
        { title: 'Finance data', url: '', content: '{"close":1272.75}' },
      ],
      metadata: { total_results: 2, search_time_ms: 9 },
    });
    expect(response.results).toEqual([
      { title: 'Web source', url: 'https://source.test/result', content: 'citeable' },
      { title: 'Finance data', content: '{"close":1272.75}' },
    ]);
    expect(response.metadata.urlLessResults).toBe(1);
  });

  it('非绝对 HTTP(S) 的 url 丢弃并计入 droppedInvalidUrlResults', () => {
    const response = parseSearch({
      results: [
        { title: 'Relative', url: '/not-absolute', content: 'discarded' },
        { title: 'Non-HTTP', url: 'file:///private', content: 'discarded' },
      ],
      metadata: { total_results: 2, search_time_ms: 4 },
    });
    expect(response.results).toEqual([]);
    expect(response.metadata.droppedInvalidUrlResults).toBe(2);
  });

  it('content 总量按到达顺序截断到 MAX_CANONICAL_CONTENT_CHARS', () => {
    const response = parseSearch({
      results: [
        {
          title: 'First',
          url: 'https://first.test',
          content: 'a'.repeat(MAX_CANONICAL_CONTENT_CHARS - 2),
        },
        { title: 'Second', url: 'https://second.test', content: 'bcdef' },
      ],
      metadata: { total_results: 2, search_time_ms: 1 },
    });
    expect(response.results[0]?.content).toHaveLength(MAX_CANONICAL_CONTENT_CHARS - 2);
    expect(response.results[1]?.content).toBe('bc');
  });

  it('metadata 缺失或字段类型不对 → 报出字段路径', () => {
    expect(() => parseSearch({ results: [] })).toThrow('data.metadata must be an object');
    expect(() =>
      parseSearch({ results: [], metadata: { total_results: '2', search_time_ms: 1 } }),
    ).toThrow('data.metadata.total_results must be a number');
    expect(() =>
      parseSearch({ results: [], metadata: { total_results: -1, search_time_ms: 1 } }),
    ).toThrow('data.metadata.total_results must be a non-negative integer');
  });

  it('results 非数组 → 报出字段路径', () => {
    expect(() => parseSearch({ results: {}, metadata: { total_results: 0, search_time_ms: 0 } })).toThrow(
      'data.results must be an array',
    );
  });

  it('title 缺失 → 报出字段路径（title 是必填字段）', () => {
    expect(() =>
      parseSearch({
        results: [{ url: 'https://a.test' }],
        metadata: { total_results: 1, search_time_ms: 1 },
      }),
    ).toThrow('data.results[0].title must be a string');
  });
});

describe('extract 响应解析', () => {
  it('夹具信封 → url/title/content', () => {
    const response = parseExtractData(
      envelopeData(readEnvelope(readFixtureJson('anysearch-extract-response.json'))),
    );
    expect(response).toEqual({
      requestId: 'req_extract_1',
      url: 'https://example.com/article',
      title: 'Example article',
      content: '# Example article\n\nCleaned body.',
    });
  });

  it('url 非绝对 HTTP(S) / title 缺失 / content 非字符串 → 报出字段路径', () => {
    const base = { url: 'https://example.test/a', title: 'T', content: 'C' };
    expect(() => parseExtractData({ data: { ...base, url: 'file:///private' } })).toThrow(
      'data.url must be an absolute HTTP(S) URL',
    );
    expect(() => parseExtractData({ data: { url: base.url, content: 'C' } })).toThrow(
      'data.title must be a string',
    );
    expect(() => parseExtractData({ data: { ...base, content: null } })).toThrow(
      'data.content must be a string',
    );
  });
});

describe('seam 映射', () => {
  it('search → WebSearchResult：无 url 的条目在映射层丢弃，truncated 恒为 false', () => {
    const response = parseSearch({
      results: [
        { title: 'Kept', url: 'https://keep.test/a', snippet: 'S' },
        { title: 'Dropped', url: '', content: 'structured only' },
      ],
      metadata: { total_results: 2, search_time_ms: 3 },
    });
    expect(mapSearchResponse(response)).toEqual({
      sources: [{ url: 'https://keep.test/a', title: 'Kept', snippet: 'S' }],
      truncated: false,
    });
  });

  it('search → 空白 title/snippet 省略而不是塞空串', () => {
    const response = parseSearch({
      results: [{ title: '   ', url: 'https://keep.test/a', snippet: '  ' }],
      metadata: { total_results: 1, search_time_ms: 3 },
    });
    expect(mapSearchResponse(response)).toEqual({
      sources: [{ url: 'https://keep.test/a' }],
      truncated: false,
    });
  });

  it('extract → WebFetchResult：正文归一为 text、状态码 200、不再截断', () => {
    expect(
      mapExtractResponse({
        url: 'https://example.test/article',
        title: 'Example article',
        content: '# body',
      }),
    ).toEqual({
      url: 'https://example.test/article',
      statusCode: 200,
      body: { kind: 'text', content: '# body' },
      truncated: false,
    });
  });
});
