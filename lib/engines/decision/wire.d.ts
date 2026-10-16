import type { DecisionDepth, DecisionProvider } from './types.js';
export declare const DECISION_MODEL_PROVIDER: Readonly<Record<string, DecisionProvider>>;
export declare function buildDecisionRequest(model: string, request: 'search' | 'fetch', text: string): object;
export declare function parseDecisionDepth(payload: unknown): {
    depth: DecisionDepth;
    model: string;
    confidence: number | undefined;
} | undefined;
