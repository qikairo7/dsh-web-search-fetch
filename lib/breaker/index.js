/**
 * Engine-agnostic daily breaker — public surface of `src/breaker/`. A pure
 * module (no cordis, no network): the upper layer constructs one
 * {@link CircuitBreaker}, forwards signals per engine, asks
 * {@link CircuitBreaker.isBroken} before dispatching, and wires `onEvent`
 * onto `ctx.logger` (designed so the pipelines of #8/#9 and engine quota
 * check of #4 can consume it without touching the plugin context).
 * @module breaker
 */
export { CircuitBreaker, DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS, formatBreakerEvent, nextLocalMidnight, } from './breaker.js';
