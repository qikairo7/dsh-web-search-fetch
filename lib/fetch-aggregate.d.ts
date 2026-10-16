import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { BreakerSignal, CircuitBreaker } from './breaker/index.js';
/** The two dispatch routes of the fetch pipeline. */
export type FetchRoute = 'static' | 'dynamic';
/**
 * Default static-extension table (the issue's `.txt/.xml/.json/.md/.csv 等`).
 * Extensions not in this list — `.pdf`, `.html`, no extension, unknown —
 * route dynamic (DESIGN.md: PDF and unknown pages go to the engine bundle).
 */
export declare const DEFAULT_STATIC_EXTENSIONS: readonly string[];
/** Routing knobs; every field has a production default. */
export interface FetchRouteOptions {
    /** `false` disables URL awareness entirely: every fetch goes through HTTP. */
    readonly enabled?: boolean;
    /** Static extension table; entries may carry a leading dot and any case. */
    readonly staticExtensions?: readonly string[];
    /** Static-domain profiles: exact host or any subdomain of it (dot-bounded). */
    readonly staticDomains?: readonly string[];
}
/**
 * Decide the route for one URL. Rules, in order:
 *
 * 1. Routing disabled → `static` (the pass-through configuration).
 * 2. Unparseable or non-HTTP(S) URLs → `static`, so the HTTP fetcher — which
 *    owns URL validation — answers with `WEB_INVALID_URL`.
 * 3. Host equal to, or a dot-bounded subdomain of, a configured static
 *    domain → `static` (the domain profile wins over the path).
 * 4. Last path segment carries an extension from the table → `static`.
 * 5. Everything else → `dynamic`.
 */
export declare function classifyFetchRoute(rawUrl: string, options?: FetchRouteOptions): FetchRoute;
/** Default per-engine weights (DESIGN.md: firecrawl highest, others behind). */
export declare const DEFAULT_ENGINE_WEIGHTS: Readonly<Record<string, number>>;
/** Weight given to an engine with no explicit or default entry. */
export declare const DEFAULT_UNKNOWN_ENGINE_WEIGHT = 2;
/** Body length (in characters) at which the length score saturates. */
export declare const LENGTH_SCORE_FULL_CHARS = 2000;
/** Maximum length score, added at {@link LENGTH_SCORE_FULL_CHARS} characters. */
export declare const LENGTH_SCORE_MAX = 2;
/** Maximum weight of the text-density signal (text characters / total). */
export declare const DENSITY_SCORE_MAX = 1;
/** Maximum weight of the slug-vs-title match signal. */
export declare const TITLE_MATCH_SCORE_MAX = 1.5;
/** How much of the body head is searched for its title. */
export declare const TITLE_WINDOW_CHARS = 500;
/** Default per-engine extraction budget (DESIGN.md: ≤45 s per engine). */
export declare const DEFAULT_FETCH_ENGINE_TIMEOUT_MS = 45000;
/** One candidate that entered selection. */
export interface FetchCandidate {
    readonly engineId: string;
    readonly result: WebFetchResult;
    readonly receivedAt?: string;
}
/** Per-signal breakdown behind a candidate's score, for tests and logs. */
export interface CandidateScoreBreakdown {
    readonly weight: number;
    readonly length: number;
    readonly density: number;
    readonly titleMatch: number;
}
/** A scored candidate. */
export interface ScoredCandidate extends FetchCandidate {
    readonly score: number;
    readonly breakdown: CandidateScoreBreakdown;
}
/**
 * Whether a candidate counts as a usable body: a 200-with-empty (or
 * pure-whitespace) body is invalid and gets no score (issue #9 acceptance).
 */
export declare function isUsableCandidate(result: WebFetchResult): boolean;
/** The final path segment of a URL, separators normalized to spaces, lowercased. */
export declare function extractUrlSlug(rawUrl: string): string;
/**
 * The body's title, simplified per the issue: within the first
 * {@link TITLE_WINDOW_CHARS} characters, the first markdown heading wins;
 * otherwise the first non-empty line. Empty when neither exists.
 */
export declare function extractBodyTitle(text: string): string;
/** Jaccard similarity of two titles' token sets; empty input scores 0. */
export declare function titleSimilarity(a: string, b: string): number;
/** Consistency fingerprint: first 8 hex digits of the sha1 of the body. */
export declare function bodyFingerprint(text: string): string;
/**
 * Score one candidate: engine weight + body length (capped) + body density +
 * slug-vs-title match. Deterministic and pure, so selection is reproducible.
 */
export declare function scoreCandidate(engineId: string, result: WebFetchResult, requestUrl: string, weights?: Partial<Record<string, number>>): ScoredCandidate;
/**
 * 择优: pick the highest-scoring usable candidate; ties go to the earlier
 * candidate (engine dispatch order). Unusable (empty-body) candidates are
 * excluded; `best` is `undefined` only when nothing usable came back.
 */
export declare function selectBestCandidate(requestUrl: string, candidates: readonly FetchCandidate[], weights?: Partial<Record<string, number>>): {
    best: ScoredCandidate | undefined;
    scored: readonly ScoredCandidate[];
};
/**
 * Read Firecrawl's breaker signal off a caught error: the `breaker`-classified
 * `FirecrawlFailure` already carries the vocabulary-conform signal (`402` →
 * `insufficient-credits`, `429` → `rate-limit` with the Retry-After hint).
 */
export declare function firecrawlBreakerSignal(error: unknown): BreakerSignal | undefined;
/**
 * Read AnySearch's breaker signal: the engine's failure classification maps
 * `rate-limit` and `quota-exhausted` onto the breaker's vocabulary verbatim
 * (`failureSignalOf` accepts both the engine error and a `WebError` wrapper).
 */
export declare function anysearchBreakerSignal(error: unknown): BreakerSignal | undefined;
/**
 * One engine leg of the dynamic path. `extract` resolves a normalized
 * {@link WebFetchResult} (engine mapping already closed-union); `signalOf`
 * optionally classifies a thrown error into a breaker signal.
 */
export interface FetchEngineLeg {
    readonly engineId: string;
    extract(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
    signalOf?(error: unknown): BreakerSignal | undefined;
}
/** Minimal logger surface the pipeline needs; `ctx.logger` satisfies it. */
export interface FetchPipelineLogger {
    info(message: string): void;
    warn(message: string): void;
}
/** Inputs of {@link aggregateDynamicFetch}. */
export interface AggregateDynamicFetchOptions {
    readonly mode?: 'organize' | 'select';
    readonly maxOutputChars?: number;
    readonly url: string;
    readonly legs: readonly FetchEngineLeg[];
    readonly signal?: AbortSignal;
    readonly breaker?: CircuitBreaker;
    readonly logger?: FetchPipelineLogger;
    /** Per-engine deadline; defaults to {@link DEFAULT_FETCH_ENGINE_TIMEOUT_MS}. */
    readonly perEngineTimeoutMs?: number;
    /** Engine-weight overrides for selection; missing entries keep defaults. */
    readonly engineWeights?: Partial<Record<string, number>>;
}
/**
 * Run the dynamic path for one URL: dispatch every non-broken engine
 * concurrently (each with its own deadline), forward breaker signals, pick the
 * best usable body (择优), log consistency signals for the losers, and only
 * throw after every engine lost — with the most specific error code observed.
 */
export declare function aggregateDynamicFetch(options: AggregateDynamicFetchOptions): Promise<WebFetchResult>;
