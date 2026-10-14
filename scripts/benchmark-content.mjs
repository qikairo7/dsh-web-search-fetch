import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { aggregateDynamicFetch } from '../lib/fetch-aggregate.js';

// Synthetic, fixed extracts: no network, credentials or external quality claims.
const fixtures = [
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
const rows = [];
for (const fixture of fixtures) {
  const url = 'https://example.com/offline-fixture';
  const legs = fixture.bodies.map((content, index) => ({ engineId: ['firecrawl', 'anysearch', 'tavily'][index],
    extract: async () => ({ url, statusCode: 200, body: { kind: 'text', content }, truncated: false }) }));
  for (const mode of ['first', 'select', 'organize']) {
    const times = [];
    let output;
    for (let run = 0; run < 20; run++) {
      const start = performance.now();
      output = mode === 'first' ? await legs[0].extract() : await aggregateDynamicFetch({ url, legs, mode });
      times.push(performance.now() - start);
    }
    const content = output.body.content;
    const retained = fixture.markers.filter(marker => content.includes(marker)).length;
    const sharedOccurrences = content.split(fixture.shared).length - 1;
    if (mode === 'organize') {
      assert.equal(retained, fixture.markers.length, fixture.name);
      assert.equal(sharedOccurrences, 1, fixture.name);
      assert.match(content, /提取来源与处理说明/);
    }
    rows.push({ fixture: fixture.name, mode, retained: `${retained}/${fixture.markers.length}`, sharedOccurrences,
      medianMs: Number(times.sort((a, b) => a - b)[10].toFixed(3)), chars: content.length });
  }
}
console.log(JSON.stringify({ scope: 'synthetic offline extracts; no competitor or live API evaluation', rows }, null, 2));
