import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  formatBreakerEvent,
  nextLocalMidnight,
  type BreakerEvent,
} from '../src/breaker/index.js';

/** 本地时间 2026-10-13 15:00（假时钟起点；断言全部按本地组件构造，与宿主时区无关）。 */
const DAY_START = new Date(2026, 9, 13, 15, 0, 0);
const NEXT_MIDNIGHT = new Date(2026, 9, 14, 0, 0, 0).getTime();

function collectEvents(): { events: BreakerEvent[]; onEvent: (event: BreakerEvent) => void } {
  const events: BreakerEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

/**
 * 聚合管线的约定（#8/#9 照此实现）：每次派发前询问 isBroken，
 * 熔断或冷却中的引擎直接跳过，不阻塞其余引擎。
 */
function dispatchableEngines(breaker: CircuitBreaker, engines: readonly string[]): string[] {
  return engines.filter((engineId) => !breaker.isBroken(engineId));
}

beforeEach(() => {
  // 只伪造 Date：时间来源集中在假时钟，测试其余部分保持真实。
  vi.useFakeTimers({ now: DAY_START, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nextLocalMidnight', () => {
  it('同日内取次日零点；跨月/跨年正确进位（本地时区）', () => {
    expect(nextLocalMidnight(new Date(2026, 9, 13, 15, 0, 0).getTime())).toBe(NEXT_MIDNIGHT);
    expect(nextLocalMidnight(new Date(2026, 9, 31, 23, 59, 59).getTime())).toBe(
      new Date(2026, 10, 1, 0, 0, 0).getTime(),
    );
    expect(nextLocalMidnight(new Date(2026, 11, 31, 8, 0, 0).getTime())).toBe(
      new Date(2027, 0, 1, 0, 0, 0).getTime(),
    );
  });
});

describe('CircuitBreaker 当日熔断', () => {
  it('quota-exhausted 触发当日熔断：返回值与 status 给出原因与本地次日零点恢复时间', () => {
    const breaker = new CircuitBreaker();
    const status = breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    expect(status).toEqual({ broken: true, reason: 'quota-exhausted', resetAt: NEXT_MIDNIGHT });
    expect(breaker.isBroken('engine-a')).toBe(true);
    expect(breaker.status('engine-a')).toEqual({
      broken: true,
      reason: 'quota-exhausted',
      resetAt: NEXT_MIDNIGHT,
    });
  });

  it('insufficient-credits（欠费）同样触发当日熔断', () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('engine-z', { kind: 'insufficient-credits' });
    expect(breaker.status('engine-z')).toEqual({
      broken: true,
      reason: 'insufficient-credits',
      resetAt: NEXT_MIDNIGHT,
    });
  });

  it('当日持续停用：当晚 23:59:59 仍熔断，次日零点整自动恢复', () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    vi.setSystemTime(new Date(2026, 9, 13, 23, 59, 59));
    expect(breaker.isBroken('engine-a')).toBe(true);
    vi.setSystemTime(new Date(2026, 9, 14, 0, 0, 0));
    expect(breaker.isBroken('engine-a')).toBe(false);
    expect(breaker.status('engine-a')).toEqual({ broken: false });
  });

  it('当日熔断期间收到 rate-limit：当日熔断不被降级，短冷却不生效', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' }, t0);
    breaker.recordSignal('engine-a', { kind: 'rate-limit', retryAfterMs: 1_000 }, t0);
    expect(breaker.status('engine-a', t0)).toEqual({
      broken: true,
      reason: 'quota-exhausted',
      resetAt: NEXT_MIDNIGHT,
    });
    expect(breaker.isBroken('engine-a', t0 + 1_000)).toBe(true);
  });

  it('rate-limit 冷却中又收到额度耗尽：升级为当日熔断，冷却不再适用', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-a', { kind: 'rate-limit', retryAfterMs: 1_000 }, t0);
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' }, t0 + 500);
    expect(breaker.status('engine-a', t0 + 500)).toEqual({
      broken: true,
      reason: 'quota-exhausted',
      resetAt: NEXT_MIDNIGHT,
    });
    expect(breaker.isBroken('engine-a', t0 + 2_000)).toBe(true);
    expect(breaker.isBroken('engine-a', NEXT_MIDNIGHT)).toBe(false);
  });
});

describe('CircuitBreaker rate-limit 冷却', () => {
  it('带 retryAfterMs 按该时长冷却（Retry-After 语义），到期即恢复', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0);
    expect(breaker.status('engine-z', t0)).toEqual({
      broken: true,
      reason: 'rate-limit',
      cooldownUntil: t0 + 30_000,
    });
    expect(breaker.isBroken('engine-z', t0 + 29_999)).toBe(true);
    expect(breaker.isBroken('engine-z', t0 + 30_000)).toBe(false);
  });

  it('不带 retryAfterMs 退化为默认 60 秒短冷却，构造参数可配', () => {
    const t0 = DAY_START.getTime();
    const def = new CircuitBreaker();
    def.recordSignal('engine-z', { kind: 'rate-limit' }, t0);
    expect(def.status('engine-z', t0).cooldownUntil).toBe(t0 + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const custom = new CircuitBreaker({ defaultRateLimitCooldownMs: 5_000 });
    custom.recordSignal('engine-z', { kind: 'rate-limit' }, t0);
    expect(custom.isBroken('engine-z', t0 + 4_999)).toBe(true);
    expect(custom.isBroken('engine-z', t0 + 5_000)).toBe(false);
  });

  it('冷却期内同类信号指数退避加倍：1× → 2× → 4×，从新起点重新计时', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0);
    expect(breaker.status('anysearch', t0).cooldownUntil).toBe(t0 + 60_000);
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0 + 10_000);
    expect(breaker.status('anysearch', t0 + 10_000).cooldownUntil).toBe(t0 + 10_000 + 120_000);
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0 + 20_000);
    expect(breaker.status('anysearch', t0 + 20_000).cooldownUntil).toBe(t0 + 20_000 + 240_000);
    expect(breaker.isBroken('anysearch', t0 + 260_000)).toBe(false);
  });

  it('退避上限 1 小时：冷却内连续信号封顶', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    for (let i = 0; i < 7; i += 1) {
      breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0);
    }
    expect(breaker.status('anysearch', t0).cooldownUntil).toBe(t0 + MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it('退避上限可配（maxRateLimitCooldownMs）', () => {
    const breaker = new CircuitBreaker({ maxRateLimitCooldownMs: 90_000 });
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0);
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0);
    expect(breaker.status('engine-z', t0).cooldownUntil).toBe(t0 + 90_000);
  });

  it('冷却结束后再来信号：退避清零，从 1× 重新开始', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0);
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, t0 + 10_000);
    const afterCooldown = t0 + 60_000 + 120_000;
    expect(breaker.isBroken('anysearch', afterCooldown)).toBe(false);
    breaker.recordSignal('anysearch', { kind: 'rate-limit', retryAfterMs: 60_000 }, afterCooldown);
    expect(breaker.status('anysearch', afterCooldown).cooldownUntil).toBe(afterCooldown + 60_000);
  });

  it('retryAfterMs 0（立即重试）不构成熔断，不发事件', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 0 }, t0);
    expect(breaker.isBroken('engine-z', t0)).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('冷却期间的 retryAfterMs 0：上游撤回限流，冷却立即解除并发恢复事件', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0);
    expect(breaker.isBroken('engine-z', t0)).toBe(true);
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 0 }, t0 + 5_000);
    expect(breaker.isBroken('engine-z', t0 + 5_000)).toBe(false);
    expect(events).toEqual([
      { type: 'open', engineId: 'engine-z', reason: 'rate-limit', at: t0, until: t0 + 30_000 },
      { type: 'recovery', engineId: 'engine-z', reason: 'rate-limit', at: t0 + 5_000 },
    ]);
    // 冷却后的下一次信号从 1× 重新计时（不残留退避）。
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0 + 6_000);
    expect(breaker.status('engine-z', t0 + 6_000).cooldownUntil).toBe(t0 + 36_000);
  });
});

describe('CircuitBreaker 多引擎与未知引擎', () => {
  it('多引擎互不影响：各自独立触发、独立恢复', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' }, t0);
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0);
    expect(breaker.isBroken('engine-a', t0)).toBe(true);
    expect(breaker.isBroken('engine-z', t0)).toBe(true);
    expect(breaker.isBroken('anysearch', t0)).toBe(false);
    // engine-z 冷却先到期，丝毫不影响 engine-a 的当日熔断，也没动过 anysearch。
    expect(breaker.isBroken('engine-z', t0 + 30_000)).toBe(false);
    expect(breaker.isBroken('engine-a', t0 + 30_000)).toBe(true);
    expect(breaker.isBroken('anysearch', t0 + 30_000)).toBe(false);
    expect(events.map((event) => `${event.type}:${event.engineId}`)).toEqual([
      'open:engine-a',
      'open:engine-z',
      'recovery:engine-z',
    ]);
  });

  it('未知 engineId 查询安全返回未熔断', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.isBroken('never-seen')).toBe(false);
    expect(breaker.status('never-seen')).toEqual({ broken: false });
  });
});

describe('与聚合管线的约定（管线跳过熔断引擎）', () => {
  const ENGINES = ['anysearch', 'engine-z', 'engine-a'] as const;

  it('当日熔断的引擎被跳过，其余引擎照常派发；跨日后重新加入', () => {
    const breaker = new CircuitBreaker();
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    expect(dispatchableEngines(breaker, ENGINES)).toEqual(['anysearch', 'engine-z']);
    vi.setSystemTime(new Date(2026, 9, 14, 0, 0, 0));
    expect(dispatchableEngines(breaker, ENGINES)).toEqual(['anysearch', 'engine-z', 'engine-a']);
  });

  it('rate-limit 冷却期内被跳过，冷却结束自动回队', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 10_000 }, t0);
    expect(dispatchableEngines(breaker, ENGINES)).toEqual(['anysearch', 'engine-a']);
    vi.setSystemTime(t0 + 10_000);
    expect(dispatchableEngines(breaker, ENGINES)).toEqual(['anysearch', 'engine-z', 'engine-a']);
  });
});

describe('事件与日志行', () => {
  it('熔断触发事件与日志行含引擎名、触发原因、预计恢复时间', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    expect(events).toEqual([
      {
        type: 'open',
        engineId: 'engine-a',
        reason: 'quota-exhausted',
        at: DAY_START.getTime(),
        until: NEXT_MIDNIGHT,
      },
    ]);
    const line = formatBreakerEvent(events[0]!);
    expect(line).toContain('engine-a');
    expect(line).toContain('quota-exhausted');
    expect(line).toContain(new Date(NEXT_MIDNIGHT).toISOString());
  });

  it('恢复事件在跨日后首次查询时恰好发出一次，日志行含引擎名与原因', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    vi.setSystemTime(new Date(2026, 9, 14, 3, 0, 0));
    expect(breaker.isBroken('engine-a')).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: 'recovery',
      engineId: 'engine-a',
      reason: 'quota-exhausted',
      at: new Date(2026, 9, 14, 3, 0, 0).getTime(),
    });
    expect(breaker.isBroken('engine-a')).toBe(false);
    expect(events).toHaveLength(2); // 不重复发
    const line = formatBreakerEvent(events[1]!);
    expect(line).toContain('engine-a');
    expect(line).toContain('quota-exhausted');
    expect(line).toContain('熔断恢复');
  });

  it('rate-limit 的每次冷却决定都发触发事件（含退避后的预计恢复时间）', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0);
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 30_000 }, t0 + 5_000);
    expect(events).toEqual([
      { type: 'open', engineId: 'engine-z', reason: 'rate-limit', at: t0, until: t0 + 30_000 },
      {
        type: 'open',
        engineId: 'engine-z',
        reason: 'rate-limit',
        at: t0 + 5_000,
        until: t0 + 5_000 + 60_000,
      },
    ]);
    expect(formatBreakerEvent(events[1]!)).toContain(new Date(t0 + 65_000).toISOString());
  });

  it('当日熔断期间的重复同类信号：resetAt 不变、不重复发事件', () => {
    const { events, onEvent } = collectEvents();
    const breaker = new CircuitBreaker({ onEvent });
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    vi.setSystemTime(new Date(2026, 9, 13, 20, 0, 0));
    breaker.recordSignal('engine-a', { kind: 'quota-exhausted' });
    expect(events).toHaveLength(1);
    expect(breaker.status('engine-a').resetAt).toBe(NEXT_MIDNIGHT);
  });

  it('未注入 onEvent 时静默工作，状态机照常', () => {
    const breaker = new CircuitBreaker();
    const t0 = DAY_START.getTime();
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 1_000 }, t0);
    expect(breaker.isBroken('engine-z', t0)).toBe(true);
    expect(breaker.isBroken('engine-z', t0 + 1_000)).toBe(false);
  });
});

describe('时钟注入', () => {
  it('构造注入 now() 时钟被使用，方法级 now 可覆盖', () => {
    const fixed = new Date(2026, 9, 13, 15, 0, 0).getTime();
    const breaker = new CircuitBreaker({ now: () => fixed });
    breaker.recordSignal('engine-z', { kind: 'rate-limit', retryAfterMs: 10_000 });
    expect(breaker.status('engine-z')).toEqual({
      broken: true,
      reason: 'rate-limit',
      cooldownUntil: fixed + 10_000,
    });
    // 方法级 now 覆盖注入时钟：到期、结算恢复。
    expect(breaker.isBroken('engine-z', fixed + 10_000)).toBe(false);
    expect(breaker.status('engine-z')).toEqual({ broken: false });
  });
});
