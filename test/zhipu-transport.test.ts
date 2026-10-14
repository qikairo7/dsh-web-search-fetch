import { describe, expect, it } from 'vitest';
import {
  extractUpstreamErrorDetail,
  formatUpstreamErrorDetail,
  isZhipuRateLimitSignal,
  parseRetryAfterMs,
  parseUpstreamErrorBody,
} from '../src/engines/zhipu/transport.js';

describe('parseUpstreamErrorBody / extractUpstreamErrorDetail', () => {
  it('标准错误体：字符串 code 与 message 都读出，数字 code 归一为字符串', () => {
    expect(parseUpstreamErrorBody('{"error":{"code":"1701","message":"并发已达上限"}}')).toEqual({
      code: '1701',
      message: '并发已达上限',
    });
    expect(parseUpstreamErrorBody('{"error":{"code":1703,"message":"引擎无有效数据"}}')).toEqual({
      code: '1703',
      message: '引擎无有效数据',
    });
  });

  it('detail 格式 `(code …): message`；只有一者时只出半截', () => {
    expect(extractUpstreamErrorDetail('{"error":{"code":"1701","message":"并发已达上限"}}')).toBe(
      ' (code 1701): 并发已达上限',
    );
    expect(extractUpstreamErrorDetail('{"error":{"code":"1701"}}')).toBe(' (code 1701)');
    expect(extractUpstreamErrorDetail('{"error":{"message":"出错了"}}')).toBe(': 出错了');
  });

  it('非 JSON / 非对象 / 无 error / 空字段 → undefined 与空 detail，不编造', () => {
    for (const text of [
      'not json',
      'null',
      '[1,2]',
      '"str"',
      '{"not_error":1}',
      '{"error":null}',
      '{"error":"oops"}',
      '{"error":{}}',
      '{"error":{"code":"  ","message":"  "}}',
    ]) {
      expect(parseUpstreamErrorBody(text)).toBeUndefined();
      expect(extractUpstreamErrorDetail(text)).toBe('');
    }
  });

  it('message 截断到上限（不携带无界上游文本）', () => {
    const long = 'x'.repeat(5_000);
    const detail = extractUpstreamErrorDetail(JSON.stringify({ error: { code: '1701', message: long } }));
    expect(detail).toBe(` (code 1701): ${'x'.repeat(2_000)}`);
  });

  it('formatUpstreamErrorDetail：空字段不产生空壳符号', () => {
    expect(formatUpstreamErrorDetail(undefined)).toBe('');
    expect(formatUpstreamErrorDetail({})).toBe('');
    expect(formatUpstreamErrorDetail({ code: '1701' })).toBe(' (code 1701)');
  });
});

describe('parseRetryAfterMs / isZhipuRateLimitSignal', () => {
  it('Retry-After 秒数 → 毫秒', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(' 5 ')).toBe(5_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('Retry-After HTTP 日期 → 与当前时间差（非负）', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it('缺失/不可读 → undefined（缺提示不算失败）', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
  });

  it('isZhipuRateLimitSignal 只认 {kind:"rate-limit"}', () => {
    expect(isZhipuRateLimitSignal({ kind: 'rate-limit' })).toBe(true);
    expect(isZhipuRateLimitSignal({ kind: 'rate-limit', retryAfterMs: 1_000 })).toBe(true);
    expect(isZhipuRateLimitSignal({ kind: 'other' })).toBe(false);
    expect(isZhipuRateLimitSignal(null)).toBe(false);
    expect(isZhipuRateLimitSignal('rate-limit')).toBe(false);
  });
});
