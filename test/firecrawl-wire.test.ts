import { describe, expect, it } from 'vitest';
import {
  buildFirecrawlScrapeRequest,
  classifyFirecrawlHttpFailure,
  extractFirecrawlErrorCode,
  extractFirecrawlErrorDetail,
  firecrawlWebErrorCode,
  isRetryableFirecrawlStatus,
  mapFirecrawlScrapeResult,
  parseRetryAfterMs,
  readFirecrawlScrapeSuccess,
  FIRECRAWL_DEFAULT_API_KEY_ENV,
  FIRECRAWL_RETRYABLE_STATUS,
  FIRECRAWL_SCRAPE_TIMEOUT_MS,
  FIRECRAWL_SCRAPE_URL,
} from '../src/engines/firecrawl/wire.js';
import { readFixtureJson } from './helpers/fixtures.js';

describe('firecrawl 常量（DESIGN §3：v2 + maxAge=0 + timeout 45s）', () => {
  it('端点、默认凭证 ref、单路超时锁定', () => {
    expect(FIRECRAWL_SCRAPE_URL).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(FIRECRAWL_DEFAULT_API_KEY_ENV).toBe('FIRECRAWL_API_KEY');
    expect(FIRECRAWL_SCRAPE_TIMEOUT_MS).toBe(45_000);
  });

  it('可重试集合恰为 {408,429,500,502,503,504}', () => {
    expect([...FIRECRAWL_RETRYABLE_STATUS].sort((a, b) => a - b)).toEqual([408, 429, 500, 502, 503, 504]);
  });
});

describe('buildFirecrawlScrapeRequest', () => {
  it('请求体形状契约：markdown、onlyMainContent=true、maxAge=0（关缓存）、timeout', () => {
    expect(buildFirecrawlScrapeRequest('https://example.com/')).toEqual({
      url: 'https://example.com/',
      formats: ['markdown'],
      onlyMainContent: true,
      maxAge: 0,
      timeout: 45_000,
    });
  });

  it('timeout 可配：与单路上限同源', () => {
    expect(buildFirecrawlScrapeRequest('https://example.com/', 12_000).timeout).toBe(12_000);
  });
});

describe('isRetryableFirecrawlStatus', () => {
  it('集合成员判定为真，集合外为假', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableFirecrawlStatus(status), `status ${status}`).toBe(true);
    }
    for (const status of [200, 400, 401, 402, 403, 404, 405, 409, 418, 501, 505]) {
      expect(isRetryableFirecrawlStatus(status), `status ${status}`).toBe(false);
    }
  });
});

describe('parseRetryAfterMs', () => {
  it('秒数形式 → 毫秒', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(' 3 ')).toBe(3_000);
  });

  it('HTTP-date 形式 → 相对 now 的毫秒', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:20 GMT', now)).toBe(20_000);
  });

  it('已过去的 HTTP-date → 0，不为负', () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:29:00 GMT');
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0);
  });

  it('缺失/空/垃圾值 → undefined', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});

describe('classifyFirecrawlHttpFailure', () => {
  it('402 → breaker + insufficient-credits 熔断信号', () => {
    expect(classifyFirecrawlHttpFailure(402)).toEqual({
      class: 'breaker',
      status: 402,
      signal: { kind: 'insufficient-credits' },
    });
  });

  it('错误码 insufficient_credits（含大小写/空格变体）→ 同样熔断', () => {
    expect(classifyFirecrawlHttpFailure(402, 'insufficient_credits')).toEqual({
      class: 'breaker',
      status: 402,
      signal: { kind: 'insufficient-credits' },
    });
    expect(classifyFirecrawlHttpFailure(200, 'Insufficient Credits')).toEqual({
      class: 'breaker',
      status: 200,
      signal: { kind: 'insufficient-credits' },
    });
  });

  it('429 → breaker + rate-limit 熔断信号，Retry-After 进信号', () => {
    expect(classifyFirecrawlHttpFailure(429, undefined, 120_000)).toEqual({
      class: 'breaker',
      status: 429,
      signal: { kind: 'rate-limit', retryAfterMs: 120_000 },
    });
  });

  it('429 无 Retry-After → 信号不带 retryAfterMs', () => {
    expect(classifyFirecrawlHttpFailure(429)).toEqual({
      class: 'breaker',
      status: 429,
      signal: { kind: 'rate-limit' },
    });
    expect(classifyFirecrawlHttpFailure(200, 'Rate Limit')).toEqual({
      class: 'breaker',
      status: 200,
      signal: { kind: 'rate-limit' },
    });
  });

  it('可重试集合成员（408/500/502/503/504）→ retryable', () => {
    for (const status of [408, 500, 502, 503, 504]) {
      expect(classifyFirecrawlHttpFailure(status), `status ${status}`).toEqual({
        class: 'retryable',
        status,
      });
    }
  });

  it('503 带 Retry-After → retryable 携带 retryAfterMs', () => {
    expect(classifyFirecrawlHttpFailure(503, undefined, 30_000)).toEqual({
      class: 'retryable',
      status: 503,
      retryAfterMs: 30_000,
    });
  });

  it('400/401/403/404 → fatal（本 URL/凭证不可救，重试无意义）', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(classifyFirecrawlHttpFailure(status), `status ${status}`).toEqual({
        class: 'fatal',
        status,
      });
    }
  });

  it('集合外的其余状态（405/418/501...）→ fatal', () => {
    for (const status of [405, 409, 418, 501, 505]) {
      expect(classifyFirecrawlHttpFailure(status), `status ${status}`).toEqual({
        class: 'fatal',
        status,
      });
    }
  });
});

describe('firecrawlWebErrorCode', () => {
  it('400 → WEB_INVALID_URL', () => {
    expect(firecrawlWebErrorCode(400)).toBe('WEB_INVALID_URL');
  });

  it('403/404 → WEB_BLOCKED_URL', () => {
    expect(firecrawlWebErrorCode(403)).toBe('WEB_BLOCKED_URL');
    expect(firecrawlWebErrorCode(404)).toBe('WEB_BLOCKED_URL');
  });

  it('其余（401/402/408/429/5xx）→ WEB_PROVIDER_ERROR', () => {
    for (const status of [401, 402, 408, 429, 500, 503]) {
      expect(firecrawlWebErrorCode(status), `status ${status}`).toBe('WEB_PROVIDER_ERROR');
    }
  });
});

describe('readFirecrawlScrapeSuccess', () => {
  it('成功信封（fixture）→ markdown 与 statusCode', () => {
    const fixture = readFixtureJson<{ data: { markdown: string } }>('firecrawl-scrape-response.json');
    expect(readFirecrawlScrapeSuccess(fixture)).toEqual({
      markdown: fixture.data.markdown,
      statusCode: 200,
    });
  });

  it('目标站非 200 但有文档 → 照样解析出 statusCode', () => {
    expect(
      readFirecrawlScrapeSuccess({
        success: true,
        data: { markdown: '# 404 页面', metadata: { statusCode: 404, sourceURL: 'https://gone.example/' } },
      }),
    ).toEqual({ markdown: '# 404 页面', statusCode: 404 });
  });

  it('statusCode 缺失或非数字 → 默认 200', () => {
    expect(readFirecrawlScrapeSuccess({ success: true, data: { markdown: 'x' } })?.statusCode).toBe(200);
    expect(
      readFirecrawlScrapeSuccess({ success: true, data: { markdown: 'x', metadata: { statusCode: '200' } } })
        ?.statusCode,
    ).toBe(200);
  });

  it('空字符串 markdown 是合法文档', () => {
    expect(readFirecrawlScrapeSuccess({ success: true, data: { markdown: '' } })).toEqual({
      markdown: '',
      statusCode: 200,
    });
  });

  it('success 非 true / markdown 非字符串 / data 缺失 → undefined', () => {
    expect(readFirecrawlScrapeSuccess({ success: false, data: { markdown: 'x' } })).toBeUndefined();
    expect(readFirecrawlScrapeSuccess({ success: true })).toBeUndefined();
    expect(readFirecrawlScrapeSuccess({ success: true, data: { markdown: 42 } })).toBeUndefined();
    expect(readFirecrawlScrapeSuccess({ success: true, data: {} })).toBeUndefined();
    expect(readFirecrawlScrapeSuccess(null)).toBeUndefined();
    expect(readFirecrawlScrapeSuccess('oops')).toBeUndefined();
  });
});

describe('mapFirecrawlScrapeResult', () => {
  it('映射为 seam result：markdown→text body、statusCode 透传、url 用请求 url、truncated=false', () => {
    expect(mapFirecrawlScrapeResult('https://example.com/x', { markdown: '# Hi', statusCode: 404 })).toEqual({
      url: 'https://example.com/x',
      statusCode: 404,
      body: { kind: 'text', content: '# Hi' },
      truncated: false,
    });
  });
});

describe('extractFirecrawlErrorCode / extractFirecrawlErrorDetail', () => {
  it('提取顶层 code 与 error 字符串', () => {
    const body = JSON.stringify({ success: false, error: 'Insufficient credits', code: 'insufficient_credits' });
    expect(extractFirecrawlErrorCode(body)).toBe('insufficient_credits');
    expect(extractFirecrawlErrorDetail(body)).toBe(' (code insufficient_credits): Insufficient credits');
  });

  it('嵌套 error.code/message 也识别（防御性）', () => {
    const body = JSON.stringify({ success: false, error: { code: 'X1', message: 'bad' } });
    expect(extractFirecrawlErrorCode(body)).toBe('X1');
    expect(extractFirecrawlErrorDetail(body)).toBe(' (code X1): bad');
  });

  it('非 JSON / 无 error 字段 → 空', () => {
    expect(extractFirecrawlErrorDetail('rate limited')).toBe('');
    expect(extractFirecrawlErrorCode('rate limited')).toBeUndefined();
    expect(extractFirecrawlErrorDetail(JSON.stringify({ success: false }))).toBe('');
  });

  it('超长 message 截断到 2000 字符（码点）', () => {
    const body = JSON.stringify({ success: false, error: 'x'.repeat(3_000) });
    const detail = extractFirecrawlErrorDetail(body);
    expect(detail.includes('x'.repeat(2_000))).toBe(true);
    expect(detail.includes('x'.repeat(2_001))).toBe(false);
  });
});
