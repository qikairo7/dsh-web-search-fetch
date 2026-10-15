import type { DecisionChoice, DecisionDepth, DecisionProvider } from './types.js';

export const DECISION_MODEL_PROVIDER: Readonly<Record<string, DecisionProvider>> = {
  'Kev-4b': 'siliconflow',
  SemIf: 'siliconflow',
  diffusiongemma: 'siliconflow',
  'decision-model-preview': 'alibaba',
  'jev-latest': 'typesafe',
};

export function buildDecisionRequest(model: string, request: 'search' | 'fetch', text: string): object {
  return {
    model,
    state: { request, text },
    questions: {
      depth: {
        type: 'choice',
        instructions: '决定本次搜索或网页提取的并发覆盖范围。',
        criteria: {
          fast: '普通、简单、时效性弱的请求；优先速度和额度。',
          balanced: '文档、代码或一般资料请求；兼顾速度和覆盖。',
          deep: '对比、调研、核验、反爬风险高或信息重要的请求；优先覆盖和可靠性。',
        },
      },
    },
  };
}

export function parseDecisionDepth(payload: unknown): { depth: DecisionDepth; model: string; confidence: number | undefined } | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const response = payload as { model?: unknown; answers?: unknown };
  const answers = response.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  const answer = (answers as Record<string, unknown>).depth;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
  const choice = (answer as DecisionChoice).choice;
  if (choice !== 'fast' && choice !== 'balanced' && choice !== 'deep') return undefined;
  const confidence = (answer as DecisionChoice).confidence;
  return {
    depth: choice,
    model: typeof response.model === 'string' && response.model ? response.model : 'unknown',
    confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : undefined,
  };
}
