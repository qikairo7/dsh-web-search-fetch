// Synthetic extracts for deterministic rule demonstrations. No external quality claims.
export const fixtures = [
  { name: '说明、表格与代码互补', bodies: [
    '# Guide\n\nShared introduction.\n\nExplanation retained.',
    '# Guide\n\nShared introduction.\n\n| Item | Value |\n| --- | --- |\n| Table retained | 100 |',
    '# Guide\n\nShared introduction.\n\n```ts\ncodeRetained();\n```',
  ], markers: ['Explanation retained.', 'Table retained', 'codeRetained();'], shared: 'Shared introduction.' },
  { name: '三个价格变体', bodies: [100, 120, 140].map(price => `# Price\n\nCommon anchor.\n\nPrice: ${price} yuan.`),
    markers: [100, 120, 140].map(price => `Price: ${price} yuan.`), shared: 'Common anchor.' },
  { name: '长文独有章节', bodies: ['A', 'B', 'C'].map(id => '# Manual\n\nCommon overview.\n\n'
    + Array.from({ length: 80 }, (_, index) => `## Shared ${index}\n\nStable block ${index}.`).join('\n\n')
    + `\n\n## Appendix ${id}\n\nUnique appendix ${id}.`),
    markers: ['A', 'B', 'C'].map(id => `Unique appendix ${id}.`), shared: 'Common overview.' },
];
