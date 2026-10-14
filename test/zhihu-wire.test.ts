import { describe, expect, it } from 'vitest';
import {
  buildZhihuSearchRequest,
  clampZhihuCount,
  formatEditTime,
  isTimestampWithinTolerance,
  isZhihuQuotaExhausted,
  mapZhihuQuotaResponse,
  mapZhihuSearchResponse,
  readInt64,
  readZhihuCode,
  stripHighlightTags,
  stripUtmParams,
} from '../src/engines/zhihu/wire.js';
import {
  ZHIHU_COUNT_MAX,
  ZHIHU_COUNT_MIN,
  ZHIHU_TIMESTAMP_TOLERANCE_SECONDS,
} from '../src/engines/zhihu/limits.js';
import { normalizeZhihuCountMax, resolveZhihuEngineOptions } from '../src/engines/zhihu/options.js';
import type { ZhihuQuotaResponse, ZhihuSearchResponse } from '../src/engines/zhihu/types.js';
import { readFixtureJson } from './helpers/fixtures.js';

describe('buildZhihuSearchRequest', () => {
  it('Query 原样传递，Count 与 maxResults 对齐', () => {
    const request = buildZhihuSearchRequest('知乎开放平台', 7);
    expect(request).toEqual({ Query: '知乎开放平台', Count: 7 });
  });

  it('maxResults 缺省时不携带 Count（交给 API 默认 10）', () => {
    const request = buildZhihuSearchRequest('q');
    expect('Count' in request).toBe(false);
  });

  it('不发 Filter / SearchDB（ADR-0002 垂直参数边界）', () => {
    const request = buildZhihuSearchRequest('q', 20) as unknown as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['Count', 'Query']);
  });

  it('Query 不做长度截断（API 未记载上限，不编造规则）', () => {
    const query = '知乎'.repeat(400);
    expect(buildZhihuSearchRequest(query).Query).toBe(query);
  });
});

describe('Count 上限', () => {
  it('夹取到文档上限 20', () => {
    expect(ZHIHU_COUNT_MAX).toBe(20);
    expect(buildZhihuSearchRequest('q', 21).Count).toBe(20);
    expect(buildZhihuSearchRequest('q', 1000).Count).toBe(20);
    expect(clampZhihuCount(20)).toBe(20);
  });

  it('下界为 1，小数向下取整', () => {
    expect(ZHIHU_COUNT_MIN).toBe(1);
    expect(clampZhihuCount(0)).toBe(1);
    expect(clampZhihuCount(-5)).toBe(1);
    expect(clampZhihuCount(12.7)).toBe(12);
  });

  it('NaN / Infinity 退回下界而不是发出非法 Count', () => {
    expect(clampZhihuCount(Number.NaN)).toBe(1);
    expect(clampZhihuCount(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('引擎选项的 countMax 只能下调，不能突破 20', () => {
    expect(buildZhihuSearchRequest('q', 10, 5).Count).toBe(5);
    expect(normalizeZhihuCountMax(50)).toBe(20);
    expect(normalizeZhihuCountMax(0)).toBe(1);
    expect(normalizeZhihuCountMax(undefined)).toBe(20);
  });
});

describe('stripUtmParams', () => {
  it('剥掉全部 utm_* 参数，保留其余参数与 fragment', () => {
    expect(
      stripUtmParams(
        'https://www.zhihu.com/question/123/answer/456?utm_medium=openapi_platform&utm_source=zhihu#frag',
      ),
    ).toBe('https://www.zhihu.com/question/123/answer/456#frag');
  });

  it('utm_* 之外的原参数按原样保留', () => {
    expect(stripUtmParams('https://a.com/x?page=2&utm_source=s&utm_campaign=c')).toBe(
      'https://a.com/x?page=2',
    );
  });

  it('无 utm 的 URL 原样返回', () => {
    expect(stripUtmParams('https://a.com/x?page=2')).toBe('https://a.com/x?page=2');
    expect(stripUtmParams('https://a.com/x')).toBe('https://a.com/x');
  });

  it('大小写不敏感；只剥 utm_*，不碰 utm / utm2 这类同名近邻', () => {
    expect(stripUtmParams('https://a.com/x?UTM_Source=S')).toBe('https://a.com/x');
    expect(stripUtmParams('https://a.com/x?utm=1&utm2=2')).toBe('https://a.com/x?utm=1&utm2=2');
    expect(stripUtmParams('https://a.com/x?utm_source=s&page=1')).toBe('https://a.com/x?page=1');
  });

  it('不可解析的 URL 原样返回，不丢不猜', () => {
    expect(stripUtmParams('not a url')).toBe('not a url');
    expect(stripUtmParams('')).toBe('');
  });
});

describe('stripHighlightTags', () => {
  it('剥掉 <em> / </em> 高亮标签', () => {
    expect(stripHighlightTags('把<em>搜索</em>能力做成 OpenAPI')).toBe('把搜索能力做成 OpenAPI');
  });

  it('大小写与带空格的标签同样剥掉', () => {
    expect(stripHighlightTags('<EM>a</EM><em >b</em >')).toBe('ab');
  });

  it('其他标签原样保留，不越权清洗未知标记', () => {
    expect(stripHighlightTags('<b>x</b> <em>y</em>')).toBe('<b>x</b> y');
  });
});

describe('formatEditTime', () => {
  it('Unix 秒 → ISO 8601 字符串', () => {
    expect(formatEditTime(1748261757)).toBe('2025-05-26T12:15:57.000Z');
  });

  it('十进制字符串同样接受（int64 常以字符串下发）', () => {
    expect(formatEditTime('1748348157')).toBe(new Date(1748348157 * 1000).toISOString());
  });

  it('缺失 / 非法 / 非正数不下结论，返回 undefined', () => {
    expect(formatEditTime(undefined)).toBeUndefined();
    expect(formatEditTime(null)).toBeUndefined();
    expect(formatEditTime('abc')).toBeUndefined();
    expect(formatEditTime(0)).toBeUndefined();
    expect(formatEditTime(-1)).toBeUndefined();
    expect(formatEditTime(1.5)).toBeUndefined();
  });
});

describe('readInt64', () => {
  it('接受整数与十进制字符串', () => {
    expect(readInt64(5000)).toBe(5000);
    expect(readInt64('5000')).toBe(5000);
    expect(readInt64(' 5000 ')).toBe(5000);
    expect(readInt64(0)).toBe(0);
  });

  it('拒绝浮点、非数字文本与其它类型', () => {
    expect(readInt64(1.5)).toBeUndefined();
    expect(readInt64('1.5')).toBeUndefined();
    expect(readInt64('abc')).toBeUndefined();
    expect(readInt64(null)).toBeUndefined();
    expect(readInt64(true)).toBeUndefined();
  });
});

describe('readZhihuCode', () => {
  it('数字与字符串 Code 都读得到', () => {
    expect(readZhihuCode({ Code: 0 })).toBe(0);
    expect(readZhihuCode({ Code: 20001 })).toBe(20001);
    expect(readZhihuCode({ Code: '30001' })).toBe(30001);
  });

  it('缺失或不可读时返回 undefined（不当作成功）', () => {
    expect(readZhihuCode({})).toBeUndefined();
    expect(readZhihuCode({ Code: null })).toBeUndefined();
    expect(readZhihuCode({ Code: 'oops' })).toBeUndefined();
    expect(readZhihuCode(null)).toBeUndefined();
  });
});

describe('mapZhihuSearchResponse', () => {
  it('官方样例映射为 seam sources：Url 剥 utm、ContentText 剥高亮、EditTime→publishedAt', () => {
    const payload = readFixtureJson<ZhihuSearchResponse>('zhihu-global-search-response.json');
    expect(mapZhihuSearchResponse(payload)).toEqual({
      sources: [
        {
          url: 'https://www.zhihu.com/question/123456/answer/987654321',
          title: '如何评价 <em>知乎</em> 开放平台？',
          snippet: '开放平台把搜索能力做成 OpenAPI，按日限额免费调用。',
          publishedAt: '2025-05-26T12:15:57.000Z',
        },
        {
          url: 'https://zhuanlan.zhihu.com/p/2234567890',
          title: '知乎 OpenAPI 使用体验',
          snippet: '文档清晰，但 Count 上限只有 20。',
          publishedAt: '2025-05-27T12:15:57.000Z',
        },
      ],
      truncated: false,
    });
  });

  it('Title 保留 <em>（只清洗 ContentText），互动数据不进 sources', () => {
    const mapped = mapZhihuSearchResponse({
      Data: {
        Items: [
          {
            Title: '<em>标题</em>',
            ContentText: '<em>正文</em>',
            Url: 'https://a.com/1',
            VoteUpCount: 999,
            CommentCount: 1,
            AuthorName: 'x',
            AuthorityLevel: '4',
          },
        ],
      },
    });
    expect(mapped.sources[0]).toEqual({
      url: 'https://a.com/1',
      title: '<em>标题</em>',
      snippet: '正文',
    });
    expect(Object.keys(mapped.sources[0]!).sort()).toEqual(['snippet', 'title', 'url']);
  });

  it('无 Url 的条目丢弃；空字符串/非字符串字段省略而非编造', () => {
    const mapped = mapZhihuSearchResponse({
      Data: {
        Items: [
          { Title: '无链接' },
          { Url: '  https://a.com/2  ', ContentText: '   ', Title: 42, EditTime: 'nope' },
          null,
          'not-an-object',
        ],
      },
    });
    expect(mapped).toEqual({ sources: [{ url: 'https://a.com/2' }], truncated: false });
  });

  it('Data / Items 缺失或非数组 → 空 sources', () => {
    expect(mapZhihuSearchResponse({})).toEqual({ sources: [], truncated: false });
    expect(mapZhihuSearchResponse({ Data: null })).toEqual({ sources: [], truncated: false });
    expect(mapZhihuSearchResponse({ Data: { Items: 'oops' } })).toEqual({ sources: [], truncated: false });
    expect(mapZhihuSearchResponse({ Data: [] })).toEqual({ sources: [], truncated: false });
  });
});

describe('mapZhihuQuotaResponse', () => {
  it('取 APIID 匹配的条目为 {total, used, remaining}', () => {
    const payload = readFixtureJson<ZhihuQuotaResponse>('zhihu-quota-response.json');
    expect(mapZhihuQuotaResponse(payload, 'global_search')).toEqual({
      total: 5000,
      used: 1234,
      remaining: 3766,
    });
  });

  it('int64 以字符串下发时同样读取', () => {
    expect(
      mapZhihuQuotaResponse(
        {
          Code: 0,
          Data: [
            { APIID: 'global_search', TotalQuota: '5000', TotalUsed: '5000', RemainingQuota: '0' },
          ],
        },
        'global_search',
      ),
    ).toEqual({ total: 5000, used: 5000, remaining: 0 });
  });

  it('APIID 不匹配或字段缺失 → undefined（不当成额度耗尽）', () => {
    expect(mapZhihuQuotaResponse({ Code: 0, Data: [] }, 'global_search')).toBeUndefined();
    expect(
      mapZhihuQuotaResponse({ Code: 0, Data: [{ APIID: 'other', TotalQuota: 1 }] }, 'global_search'),
    ).toBeUndefined();
    expect(
      mapZhihuQuotaResponse(
        { Code: 0, Data: [{ APIID: 'global_search', TotalQuota: 1, TotalUsed: 1 }] },
        'global_search',
      ),
    ).toBeUndefined();
    expect(mapZhihuQuotaResponse({ Code: 0, Data: null }, 'global_search')).toBeUndefined();
  });
});

describe('isZhihuQuotaExhausted', () => {
  it('remaining<=0 视为耗尽（熔断信号）', () => {
    expect(isZhihuQuotaExhausted({ total: 5000, used: 5000, remaining: 0 })).toBe(true);
    expect(isZhihuQuotaExhausted({ total: 5000, used: 6000, remaining: -1 })).toBe(true);
  });

  it('remaining>0 不耗尽', () => {
    expect(isZhihuQuotaExhausted({ total: 5000, used: 1, remaining: 4999 })).toBe(false);
  });

  it('额度读不到时不判定为耗尽（数据面 fail-open）', () => {
    expect(isZhihuQuotaExhausted(undefined)).toBe(false);
  });
});

describe('isTimestampWithinTolerance', () => {
  it('±10 分钟窗口内为真，窗外为假', () => {
    const nowMs = 1748261757_000;
    expect(isTimestampWithinTolerance(1748261757, nowMs)).toBe(true);
    expect(isTimestampWithinTolerance(1748261757 + 600, nowMs)).toBe(true);
    expect(isTimestampWithinTolerance(1748261757 - 600, nowMs)).toBe(true);
    expect(isTimestampWithinTolerance(1748261757 + 601, nowMs)).toBe(false);
    expect(isTimestampWithinTolerance(1748261757 - 601, nowMs)).toBe(false);
  });

  it('容忍值可覆盖；非有限值恒为假', () => {
    const nowMs = 1748261757_000;
    expect(isTimestampWithinTolerance(1748261757 + 120, nowMs, 60)).toBe(false);
    expect(isTimestampWithinTolerance(Number.NaN, nowMs)).toBe(false);
  });

  it('常量是文档所述的 600 秒', () => {
    expect(ZHIHU_TIMESTAMP_TOLERANCE_SECONDS).toBe(600);
  });
});

describe('resolveZhihuEngineOptions', () => {
  it('缺省走引擎默认值', () => {
    expect(resolveZhihuEngineOptions()).toMatchObject({
      baseURL: 'https://developer.zhihu.com/api/v1/content/global_search',
      quotaURL: 'https://developer.zhihu.com/api/v1/quota',
      timeoutMs: 10_000,
      countMax: 20,
    });
  });

  it('覆盖值生效；空串与非法 timeout 退回默认', () => {
    const resolved = resolveZhihuEngineOptions({
      baseURL: '  http://127.0.0.1:1/search  ',
      timeoutMs: 0,
      countMax: 5,
    });
    expect(resolved.baseURL).toBe('http://127.0.0.1:1/search');
    expect(resolved.timeoutMs).toBe(10_000);
    expect(resolved.countMax).toBe(5);
  });

  it('countMax 超上限被夹回 20', () => {
    expect(resolveZhihuEngineOptions({ countMax: 999 }).countMax).toBe(20);
  });
});
