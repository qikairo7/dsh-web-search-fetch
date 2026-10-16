export type DecisionDepth = 'fast' | 'balanced' | 'deep';
export type DecisionProvider = 'siliconflow' | 'alibaba' | 'typesafe';
export type DecisionModelId = 'Kev-4b' | 'SemIf' | 'diffusiongemma' | 'decision-model-preview' | 'jev-latest';
export interface DecisionChoice {
    readonly type?: unknown;
    readonly choice?: unknown;
    readonly confidence?: unknown;
}
export interface DecisionResponse {
    readonly model?: unknown;
    readonly answers?: unknown;
    readonly usage?: unknown;
}
