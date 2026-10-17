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
import type { BreakerEvent, BreakerSignal, BreakerStatus, CircuitBreakerOptions } from './types.js';
/** Default cooldown for a `rate-limit` without a Retry-After hint. */
export declare const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000;
/** Default ceiling of the exponential rate-limit backoff. */
export declare const MAX_RATE_LIMIT_COOLDOWN_MS = 3600000;
/**
 * Next local midnight strictly after `nowMs`. Month/year rollovers included;
 * the "local" timezone is simply the host's.
 */
export declare function nextLocalMidnight(nowMs: number): number;
/**
 * Render one breaker event as the single log line the upper layer writes via
 * `ctx.logger`. Carries the engine name, the trigger reason, and — for opens —
 * the expected recovery time (#7 acceptance).
 */
export declare function formatBreakerEvent(event: BreakerEvent): string;
export declare class CircuitBreaker {
    private readonly onEvent;
    private readonly clock;
    private readonly defaultCooldownMs;
    private readonly maxCooldownMs;
    private readonly engines;
    constructor(options?: CircuitBreakerOptions);
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
    recordSignal(engineId: string, signal: BreakerSignal, now?: number): BreakerStatus;
    /** Is the engine currently out of rotation at `now`? Unknown engines are not. */
    isBroken(engineId: string, now?: number): boolean;
    /**
     * Current breaker status; unknown engines are safely `{ broken: false }`.
     * A query that lands after an entry's deadline settles it — the recovery
     * event fires exactly once here, which is why the breaker needs no timers.
     */
    status(engineId: string, now?: number): BreakerStatus;
    private emit;
}
