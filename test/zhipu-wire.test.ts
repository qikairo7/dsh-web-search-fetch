import { describe, expect, it } from 'vitest';
import {
  buildZhipuSearchRequest,
  clampZhipuCount,
  mapZhipuSearchResponse,
  resolveZhipuContentSize,
  resolveZhipuSearchEngine,
  truncateToCodePoints,
} from '../src/engines/zhipu/wire.js';
import type { ZhipuSearchResponse } from '../src/types.js';
import { readFixtureJson } from './helpers/fixtures.js';

describe('buildZhipuSearchRequest', () => {
  it('默认 search_engine=search_pro、content_size=medium，并显式传 search_intent=false', () => {
    const request = buildZhipuSearchRequest('测试查询');
    expect(request.search_engine).toBe('search_pro');
    expect(request.content_size).toBe('medium');
    expect(request.search_intent).toBe(false);
    expect('search_intent' in request).toBe(true);
  });

  it('searchEngine 可配：四个档位透传', () => {
    const engines = ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'] as const;
    for (const engine of engines) {
      expect(buildZhipuSearchRequest('q', undefined, { searchEngine: engine }).search_engine).toBe(engine);
    }
  });

  it('contentSize 可配：high 透传；缺省 medium', () => {
    expect(buildZhipuSearchRequest('q', undefined, { contentSize: 'high' }).content_size).toBe('high');
    expect(buildZhipuSearchRequest('q', undefined, {}).content_size).toBe('medium');
  });

  it('count 与 maxResults 对齐', () => {
    expect(buildZhipuSearchRequest('q', 7).count).toBe(7);
  });

  it('maxResults 缺省时不携带 count（交给 API 默认）', () => {
    expect('count' in buildZhipuSearchRequest('q')).toBe(false);
  });

  it('count 夹取到 1–50', () => {
    expect(clampZhipuCount(0)).toBe(1);
    expect(clampZhipuCount(200)).toBe(50);
    expect(clampZhipuCount(12.7)).toBe(12);
    expect(buildZhipuSearchRequest('q', 200).count).toBe(50);
  });

  it('70 字符以内的查询原样传递', () => {
    const query = '查'.repeat(70);
    expect(buildZhipuSearchRequest(query).search_query).toBe(query);
  });

  it('超过 70 字符截断到 70', () => {
    const query = '查'.repeat(80);
    const sent = buildZhipuSearchRequest(query).search_query;
    expect(Array.from(sent)).toHaveLength(70);
    expect(sent).toBe('查'.repeat(70));
  });

  it('截断按码点，不拆开代理对', () => {
    const query = `${'a'.repeat(69)}😀尾`;
    const sent = buildZhipuSearchRequest(query).search_query;
    expect(Array.from(sent)).toHaveLength(70);
    expect(sent.endsWith('😀')).toBe(true);
  });

  it('truncateToCodePoints 边界：正好 max 不截', () => {
    expect(truncateToCodePoints('abc', 3)).toBe('abc');
    expect(truncateToCodePoints('abcd', 3)).toBe('abc');
  });
});

describe('resolveZhipuSearchEngine / resolveZhipuContentSize', () => {
  it('合法值透传', () => {
    expect(resolveZhipuSearchEngine('search_std')).toBe('search_std');
    expect(resolveZhipuSearchEngine('search_pro_quark')).toBe('search_pro_quark');
    expect(resolveZhipuContentSize('high')).toBe('high');
    expect(resolveZhipuContentSize('medium')).toBe('medium');
  });

  it('缺省/非法运行时值回落默认（search_pro / medium），不编造档位', () => {
    expect(resolveZhipuSearchEngine(undefined)).toBe('search_pro');
    expect(resolveZhipuSearchEngine('search_ultra')).toBe('search_pro');
    expect(resolveZhipuSearchEngine(42)).toBe('search_pro');
    expect(resolveZhipuContentSize(undefined)).toBe('medium');
    expect(resolveZhipuContentSize('low')).toBe('medium');
    expect(resolveZhipuContentSize(null)).toBe('medium');
  });
});

describe('mapZhipuSearchResponse', () => {
  it('官方文档样例映射为 seam sources（link→url、content→snippet、publish_date→publishedAt 原样）', () => {
    const payload = readFixtureJson<ZhipuSearchResponse>('zhipu-web-search-response.json');
    expect(mapZhipuSearchResponse(payload)).toEqual({
      sources: [
        {
          url: 'https://www.sohu.com/a/897879632_121123890',
          title: '2025年5月23日财经早资讯',
          snippet: '一、1-4月我国对外直接投资575.4亿美元，同比增长7.5%。',
          publishedAt: '2025-05-23',
        },
      ],
      truncated: false,
    });
  });

  it('无 link 的条目丢弃；空字符串/非字符串字段省略而非编造', () => {
    const payload: ZhipuSearchResponse = {
      search_result: [
        { title: '无链接' },
        { link: '  https://example.com/a  ', content: '   ', publish_date: '', title: 42 },
        null,
        'not-an-object',
      ],
    };
    expect(mapZhipuSearchResponse(payload)).toEqual({
      sources: [{ url: 'https://example.com/a' }],
      truncated: false,
    });
  });

  it('search_result 缺失或非数组 → 空 sources', () => {
    expect(mapZhipuSearchResponse({})).toEqual({ sources: [], truncated: false });
    expect(mapZhipuSearchResponse({ search_result: 'oops' })).toEqual({ sources: [], truncated: false });
  });
});
