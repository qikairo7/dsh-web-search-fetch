/**
 * The engine-agnostic daily breaker (DESIGN.md 配额熔断, GLOSSARY 配额熔断):
 * consumes quota-exhaustion signals (e.g. an engine `quota()` reporting
 * `remaining <= 0`) and the rate-limit / insufficient-credit error
 * classifications forwarded by the pipelines (#8/#9), takes the engine out of
 * rotation until local midnight (daily exhaustion) or for a cooldown
 * (rate-limit), recovers automatically, and reports state through
 * {@link CircuitBreaker.isBroken} / {@link CircuitBreaker.status}. State lives
 * only in memory; no model-facing tool (DESIGN.md) — open/recovery transitions
 * go out through `onEvent`, rendered as the prominent log lines by
 * {@link formatBreakerEvent} and written by the upper layer via `ctx.logger`.
 *
 * Pure state machine: no cordis, no network, no timers. Recovery is decided
 * lazily on the first query past the deadline, so nothing schedules or wakes.
 *
 * Invariant: an entry exists in `engines` if and only if the engine is
 * currently broken; an expired break is settled (and its recovery event
 * emitted) by whichever query — `status`, `isBroken` or `recordSignal` —
 * notices it first.
 * @module breaker/breaker
 */
import type {
  BreakerEvent,
  BreakerSignal,
  BreakerStatus,
  CircuitBreakerOptions,
} from './types.js';

/** Default cooldown for a `rate-limit` without a Retry-After hint. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Default ceiling of the exponential rate-limit backoff. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 3_600_000;

interface CooldownEntry {
  readonly reason: 'rate-limit';
  /** Consecutive cooldowns installed for this engine; resets once one expires. */
  streak: number;
  /** Cooldown deadline, `now + duration` at install time. */
  cooldownUntil: number;
}

interface DailyEntry {
  readonly reason: 'quota-exhausted' | 'insufficient-credits';
  /** Local midnight that ends the break. */
  readonly resetAt: number;
}

type EngineEntry = CooldownEntry | DailyEntry;

/**
 * Next local midnight strictly after `nowMs`. Month/year rollovers included;
 * the "local" timezone is simply the host's.
 */
export function nextLocalMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/**
 * Render one breaker event as the single log line the upper layer writes via
 * `ctx.logger`. Carries the engine name, the trigger reason, and — for opens —
 * the expected recovery time (#7 acceptance).
 */
export function formatBreakerEvent(event: BreakerEvent): string {
  if (event.type === 'open') {
    const until = new Date(event.until).toISOString();
    const expectation =
      event.reason === 'rate-limit' ? `预计恢复 ${until}` : `预计恢复 ${until}（本地次日零点）`;
    return `[熔断] 引擎 ${event.engineId} 已停用：触发原因 ${event.reason}，${expectation}`;
  }
  return `[熔断] 引擎 ${event.engineId} 熔断恢复：原触发原因 ${event.reason}`;
}

export class CircuitBreaker {
  private readonly onEvent: ((event: BreakerEvent) => void) | undefined;
  private readonly clock: () => number;
  private readonly defaultCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly engines = new Map<string, EngineEntry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.onEvent = options.onEvent;
    this.clock = options.now ?? Date.now;
    this.defaultCooldownMs = options.defaultRateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.maxCooldownMs = options.maxRateLimitCooldownMs ?? MAX_RATE_LIMIT_COOLDOWN_MS;
  }

  /**
   * Feed one breaker signal for an engine and return the resulting status.
   *
   * - `rate-limit`: cooldown for `retryAfterMs` (Retry-After semantics) or,
   *   when absent, the configured short default; repeating while the cooldown
   *   is still running backs off `hint × 2^(streak-1)`, capped at
   *   `maxRateLimitCooldownMs`. A hint of 0 or less retracts a running
   *   cooldown and installs nothing. Never downgrades a daily break.
   * - `quota-exhausted` / `insufficient-credits`: breaks until local
   *   midnight; upgraded from a running cooldown, idempotent within the day
   *   (first reason wins, no repeated event).
   */
  recordSignal(engineId: string, signal: BreakerSignal, now: number = this.clock()): BreakerStatus {
    // Settle any expired entry first: a recovery that no query observed yet
    // is reported before the new signal is applied.
    this.status(engineId, now);
    const entry = this.engines.get(engineId);

    if (signal.kind === 'rate-limit') {
      // Daily breaks are stronger; a rate-limit never downgrades them.
      if (entry !== undefined && entry.reason !== 'rate-limit') return this.status(engineId, now);
      const hint = readCooldownHint(signal.retryAfterMs, this.defaultCooldownMs);
      if (hint <= 0) {
        if (entry === undefined) return { broken: false };
        // The upstream retracted the rate limit: lift the cooldown.
        this.engines.delete(engineId);
        this.emit({ type: 'recovery', engineId, reason: 'rate-limit', at: now });
        return { broken: false };
      }
      const streak = entry === undefined ? 1 : entry.streak + 1;
      const duration = Math.min(hint * 2 ** (streak - 1), this.maxCooldownMs);
      const cooldownUntil = now + duration;
      this.engines.set(engineId, { reason: 'rate-limit', streak, cooldownUntil });
      this.emit({ type: 'open', engineId, reason: 'rate-limit', at: now, until: cooldownUntil });
      return { broken: true, reason: 'rate-limit', cooldownUntil };
    }

    // quota-exhausted / insufficient-credits: break until local midnight.
    if (entry !== undefined && entry.reason !== 'rate-limit') return this.status(engineId, now);
    const resetAt = nextLocalMidnight(now);
    this.engines.set(engineId, { reason: signal.kind, resetAt });
    this.emit({ type: 'open', engineId, reason: signal.kind, at: now, until: resetAt });
    return { broken: true, reason: signal.kind, resetAt };
  }

  /** Is the engine currently out of rotation at `now`? Unknown engines are not. */
  isBroken(engineId: string, now: number = this.clock()): boolean {
    return this.status(engineId, now).broken;
  }

  /**
   * Current breaker status; unknown engines are safely `{ broken: false }`.
   * A query that lands after an entry's deadline settles it — the recovery
   * event fires exactly once here, which is why the breaker needs no timers.
   */
  status(engineId: string, now: number = this.clock()): BreakerStatus {
    const entry = this.engines.get(engineId);
    if (entry === undefined) return { broken: false };
    const until = entry.reason === 'rate-limit' ? entry.cooldownUntil : entry.resetAt;
    if (now < until) {
      return entry.reason === 'rate-limit'
        ? { broken: true, reason: 'rate-limit', cooldownUntil: until }
        : { broken: true, reason: entry.reason, resetAt: until };
    }
    this.engines.delete(engineId);
    this.emit({ type: 'recovery', engineId, reason: entry.reason, at: now });
    return { broken: false };
  }

  private emit(event: BreakerEvent): void {
    this.onEvent?.(event);
  }
}

/** Normalize a Retry-After hint: a finite number is used verbatim, anything else falls back. */
function readCooldownHint(retryAfterMs: number | undefined, fallbackMs: number): number {
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : fallbackMs;
}
