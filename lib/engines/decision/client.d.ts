import type { DecisionProvider } from './types.js';
export type DecisionFailureReason = 'credential-missing' | 'credential-error' | 'timeout' | 'http-error' | 'unreadable-body' | 'unusable-results' | 'transport-error';
export interface DecisionClientOptions {
    readonly model: string;
    readonly provider: DecisionProvider;
    readonly resolveApiKey: () => Promise<string | undefined>;
    readonly credentialName: string;
    readonly baseURL?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
    readonly onFailure?: (reason: DecisionFailureReason, detail: string) => void;
}
export interface DecisionOutcome {
    readonly depth: 'fast' | 'balanced' | 'deep';
    readonly model: string;
    readonly confidence: number | undefined;
}
export declare class DecisionClient {
    private readonly options;
    failureReason?: DecisionFailureReason;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: DecisionClientOptions);
    decide(request: 'search' | 'fetch', text: string, signal?: AbortSignal): Promise<DecisionOutcome | null>;
    private endpoint;
    private fail;
}
export declare const decisionFetch: typeof fetch;
