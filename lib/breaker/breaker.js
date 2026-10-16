/** Default cooldown for a `rate-limit` without a Retry-After hint. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** Default ceiling of the exponential rate-limit backoff. */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 3_600_000;
/**
 * Next local midnight strictly after `nowMs`. Month/year rollovers included;
 * the "local" timezone is simply the host's.
 */
export function nextLocalMidnight(nowMs) {
    const date = new Date(nowMs);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}
/**
 * Render one breaker event as the single log line the upper layer writes via
 * `ctx.logger`. Carries the engine name, the trigger reason, and — for opens —
 * the expected recovery time (#7 acceptance).
 */
export function formatBreakerEvent(event) {
    if (event.type === 'open') {
        const until = new Date(event.until).toISOString();
        const expectation = event.reason === 'rate-limit' ? `预计恢复 ${until}` : `预计恢复 ${until}（本地次日零点）`;
        return `[熔断] 引擎 ${event.engineId} 已停用：触发原因 ${event.reason}，${expectation}`;
    }
    return `[熔断] 引擎 ${event.engineId} 熔断恢复：原触发原因 ${event.reason}`;
}
export class CircuitBreaker {
    onEvent;
    clock;
    defaultCooldownMs;
    maxCooldownMs;
    engines = new Map();
    constructor(options = {}) {
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
    recordSignal(engineId, signal, now = this.clock()) {
        // Settle any expired entry first: a recovery that no query observed yet
        // is reported before the new signal is applied.
        this.status(engineId, now);
        const entry = this.engines.get(engineId);
        if (signal.kind === 'rate-limit') {
            // Daily breaks are stronger; a rate-limit never downgrades them.
            if (entry !== undefined && entry.reason !== 'rate-limit')
                return this.status(engineId, now);
            const hint = readCooldownHint(signal.retryAfterMs, this.defaultCooldownMs);
            if (hint <= 0) {
                if (entry === undefined)
                    return { broken: false };
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
        if (entry !== undefined && entry.reason !== 'rate-limit')
            return this.status(engineId, now);
        const resetAt = nextLocalMidnight(now);
        this.engines.set(engineId, { reason: signal.kind, resetAt });
        this.emit({ type: 'open', engineId, reason: signal.kind, at: now, until: resetAt });
        return { broken: true, reason: signal.kind, resetAt };
    }
    /** Is the engine currently out of rotation at `now`? Unknown engines are not. */
    isBroken(engineId, now = this.clock()) {
        return this.status(engineId, now).broken;
    }
    /**
     * Current breaker status; unknown engines are safely `{ broken: false }`.
     * A query that lands after an entry's deadline settles it — the recovery
     * event fires exactly once here, which is why the breaker needs no timers.
     */
    status(engineId, now = this.clock()) {
        const entry = this.engines.get(engineId);
        if (entry === undefined)
            return { broken: false };
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
    emit(event) {
        this.onEvent?.(event);
    }
}
/** Normalize a Retry-After hint: a finite number is used verbatim, anything else falls back. */
function readCooldownHint(retryAfterMs, fallbackMs) {
    return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : fallbackMs;
}
