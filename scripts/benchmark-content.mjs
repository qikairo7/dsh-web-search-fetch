import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { aggregateDynamicFetch } from '../lib/fetch-aggregate.js';

// Synthetic, fixed extracts: no network, credentials or external quality claims.
import { fixtures } from './content-fixtures.mjs';

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
