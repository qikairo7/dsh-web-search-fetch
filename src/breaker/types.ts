/**
 * Public types of the engine-agnostic daily breaker. Kept free of any cordis
 * or DSH import so the module stays a pure state machine (DESIGN.md 配额熔断).
 * @module breaker/types
 */

/** Why one engine got taken out of rotation. */
export type BreakerReason = 'rate-limit' | 'quota-exhausted' | 'insufficient-credits';

/**
 * One breaker input. `rate-limit` is a cooldown (Retry-After semantics),
 * the other two are daily exhaustion signals (broken until local midnight).
 */
export interface BreakerSignal {
  readonly kind: BreakerReason;
  /** Retry-After hint in milliseconds; only meaningful for `rate-limit`. */
  readonly retryAfterMs?: number;
}

/** Answer to "is this engine currently out of rotation?". */
export interface BreakerStatus {
  readonly broken: boolean;
  /** Present exactly when `broken` is true. */
  readonly reason?: BreakerReason;
  /** For `rate-limit`: when the cooldown ends. */
  readonly cooldownUntil?: number;
  /** For daily exhaustion: local midnight of the next day. */
  readonly resetAt?: number;
}

/** Structured event emitted on every breaker transition (open and recovery). */
export type BreakerEvent =
  | {
      readonly type: 'open';
      readonly engineId: string;
      readonly reason: BreakerReason;
      /** When the signal was recorded. */
      readonly at: number;
      /** Expected recovery time (local midnight or cooldown end). */
      readonly until: number;
    }
  | {
      readonly type: 'recovery';
      readonly engineId: string;
      readonly reason: BreakerReason;
      /** When the recovery was observed (first query past the deadline). */
      readonly at: number;
    };

/** Construction-time dependencies of {@link CircuitBreaker} (see `breaker.ts`). */
export interface CircuitBreakerOptions {
  /**
   * Sink for open/recovery events. The upper layer maps this onto
   * `ctx.logger` ({@link formatBreakerEvent} renders the log line); the
   * module itself never imports cordis.
   */
  onEvent?: (event: BreakerEvent) => void;
  /**
   * The one clock this module reads. Defaults to `Date.now`; tests inject a
   * fixed function, and every method additionally accepts a per-call `now`.
   */
  now?: () => number;
  /** Short cooldown applied to a bare `rate-limit` (no Retry-After). Default 60 s. */
  defaultRateLimitCooldownMs?: number;
  /** Upper bound of the exponential rate-limit backoff. Default 1 h. */
  maxRateLimitCooldownMs?: number;
}
