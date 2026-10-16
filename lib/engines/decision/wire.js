export const DECISION_MODEL_PROVIDER = {
    'Kev-4b': 'siliconflow',
    SemIf: 'siliconflow',
    diffusiongemma: 'siliconflow',
    'decision-model-preview': 'alibaba',
    'jev-latest': 'typesafe',
};
export function buildDecisionRequest(model, request, text) {
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
export function parseDecisionDepth(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const response = payload;
    const answers = response.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers))
        return undefined;
    const answer = answers.depth;
    if (answer === null || typeof answer !== 'object' || Array.isArray(answer))
        return undefined;
    const choice = answer.choice;
    if (choice !== 'fast' && choice !== 'balanced' && choice !== 'deep')
        return undefined;
    const confidence = answer.confidence;
    return {
        depth: choice,
        model: typeof response.model === 'string' && response.model ? response.model : 'unknown',
        confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : undefined,
    };
}
