import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('质量指标对缺失排名、未知链接和重复链接不给分，保留率不使用输出长度冒充', () => {
  const helpers = new URL('../scripts/quality-cases.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { relevance, retention } from ${JSON.stringify(helpers)};
    const docs = [{url:'https://a.test',grade:3},{url:'https://b.test',grade:2}];
    const ideal = relevance(docs, docs);
    assert.equal(ideal.precisionAt5, 0.4);
    assert.equal(ideal.ndcgAt5, 1);
    const duplicates = relevance([docs[0],docs[0],{url:'https://unknown.test'}], docs);
    assert.equal(duplicates.precisionAt5, 0.2);
    assert(duplicates.ndcgAt5 < 1);
    assert.equal(relevance([], docs).ndcgAt5, 0);
    assert.equal(relevance([], []).ndcgAt5, null);
    assert.deepEqual(retention('甲正文'.repeat(500), ['甲正文','乙正文']), {markerHits:1,markerTotal:2,markerRecall:0.5});
  `], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
});
