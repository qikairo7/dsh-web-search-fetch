/** Caller-supplied overrides; every field is optional. */
export interface ZhihuEngineOptions {
    /** `global_search` endpoint. */
    baseURL?: string;
    /** Daily-quota endpoint. */
    quotaURL?: string;
    /** Per-request deadline, in milliseconds. */
    timeoutMs?: number;
    /**
     * Largest `Count` this deployment asks for. Values above the documented
     * maximum of 20 are clamped down to it, never sent through.
     */
    countMax?: number;
}
/** The same options with every value resolved; what the client stores. */
export interface ResolvedZhihuEngineOptions {
    readonly baseURL: string;
    readonly quotaURL: string;
    readonly timeoutMs: number;
    readonly countMax: number;
}
/** Effective defaults when the caller supplies nothing. */
export declare const ZHIHU_ENGINE_DEFAULTS: ResolvedZhihuEngineOptions;
/**
 * Resolve options against the defaults. `timeoutMs` falls back to the default
 * unless it is a finite positive number; `countMax` is clamped into 1–20.
 */
export declare function resolveZhihuEngineOptions(options?: ZhihuEngineOptions): ResolvedZhihuEngineOptions;
/** A configured ceiling, accepted only when it is an integer inside 1–20. */
export declare function normalizeZhihuCountMax(countMax: number | undefined): number;
