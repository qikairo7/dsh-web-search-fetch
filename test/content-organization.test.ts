import { expect, it } from 'vitest';
import { aggregateDynamicFetch } from '../src/fetch-aggregate.js';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { organizeDocuments } from '../src/fetch-document/organize.js';
import { splitBlocks } from '../src/fetch-document/blocks.js';

const url = 'https://example.com/guide';
function result(content: string): WebFetchResult {
  return { url, statusCode: 200, body: { kind: 'text', content }, truncated: false };
}
it('organizes complementary extracts instead of discarding one complete body', async () => {
  const output = await aggregateDynamicFetch({
    url, mode: 'organize', legs: [
      { engineId: 'firecrawl', extract: async () => result('# Guide\n\nShared introduction.\n\n## Details\n\nThe explanation is retained.') },
      { engineId: 'anysearch', extract: async () => result('# Guide\n\nShared introduction.\n\n## Details\n\n| Item | Value |\n| --- | --- |\n| A | 100 |') },
    ],
  } as Parameters<typeof aggregateDynamicFetch>[0]);
  expect(output.body.content).toContain('The explanation is retained.');
  expect(output.body.content).toContain('| A | 100 |');
  expect(output.body.content.match(/Shared introduction\./g)).toHaveLength(1);
  expect(output.body.content).toContain('firecrawl');
  expect(output.body.content).toContain('anysearch');
});

function organize(...bodies: string[]) {
  return organizeDocuments(url, bodies.map((body, index) => ({ engineId: `service${index}`, result: result(body) })));
}
it('preserves repeated warnings within an original and deduplicates across services', () => {
  const content = organize('# Guide\n\nWarning: stop.\n\nMiddle.\n\nWarning: stop.', '# Guide\n\nWarning: stop.\n\nMiddle.\n\nWarning: stop.').body.content;
  expect(content.match(/Warning: stop\./g)).toHaveLength(2);
  expect(content).toContain('F1:B2, F2:B2');
});
it('keeps contradictory prices as sourced variants instead of choosing or averaging', () => {
  const content = organize('# Guide\n\nPrice: 100 yuan.\n\nSame end.', '# Guide\n\nPrice: 120 yuan.\n\nSame end.').body.content;
  expect(content).toContain('## 文本差异');
  expect(content).toContain('Price: 100 yuan.');
  expect(content).toContain('Price: 120 yuan.');
  expect(content).not.toContain('Price: 110');
});
it('keeps three differing prices together in the variant appendix', () => {
  const content = organize('# Guide\n\nPrice: 100 yuan.', '# Guide\n\nPrice: 120 yuan.', '# Guide\n\nPrice: 140 yuan.').body.content;
  const main = content.split('## 文本差异')[0]!;
  expect(main).not.toMatch(/Price:/);
  for (const price of [100, 120, 140]) expect(content).toContain(`Price: ${price} yuan.`);
});
it('retains a fully reordered extract as a sourced difference even without unique blocks', () => {
  const content = organize('# Guide\n\nFirst.\n\nSecond.', '# Guide\n\nSecond.\n\nFirst.').body.content;
  expect(content).toContain('段落顺序不同');
  const appendix = content.split('## 文本差异')[1]!;
  expect(appendix.indexOf('Second.')).toBeLessThan(appendix.indexOf('First.'));
  expect(appendix).toContain('F2:B2');
});
it('deduplicates paragraph whitespace without deleting different-language extracts', () => {
  const whitespace = organize('# Guide\n\nA   shared\nparagraph.', '# Guide\n\nA shared paragraph.').body.content;
  expect(whitespace).toContain('F1:B2, F2:B2');
  const bilingual = organize('# Guide\n\n' + '这是同一网页的中文版本，保留原文以便读者核对。'.repeat(4), '# Guide\n\n' + 'This is the English version of the same page for comparison. '.repeat(4)).body.content;
  expect(bilingual).toContain('语言不同');
  expect(bilingual).toContain('English version');
  expect(bilingual).toContain('中文版本');
});
it('preserves aligned negation variants without declaring either true', () => {
  const content = organize('# Guide\n\nDeployment is permitted.', '# Guide\n\nDeployment is not permitted.').body.content;
  expect(content).toContain('## 文本差异');
  expect(content).toContain('Deployment is permitted.');
  expect(content).toContain('Deployment is not permitted.');
});
it('preserves exact fenced code, tables, links and footnotes', () => {
  const body = '# Guide\n\n```ts\nconst n = 100;\n\n  keepIndent();\n```\n\n| Amount | Unit |\n| --- | --- |\n| 100 | 元 |\n\n[link](https://example.com/a?q=1) [^1]\n\n[^1]: original';
  const content = organize(body, body).body.content;
  expect(content).toContain('```ts\nconst n = 100;\n\n  keepIndent();\n```');
  expect(content).toContain('| Amount | Unit |\n| --- | --- |\n| 100 | 元 |');
  expect(content).toContain('[link](https://example.com/a?q=1) [^1]');
  expect(content).toContain('[^1]: original');
});
it('puts unrelated titles in sourced supplements', () => {
  const content = organize('# Guide 1\n\nCommon.', '# Guide 2\n\nCommon.\n\nOther version.').body.content;
  expect(content).toContain('## 补充片段');
  expect(content).toContain('标题或版本不同');
  expect(content).toContain('Other version.');
});
it('does not silently incorporate content from a different final target', () => {
  const output = organizeDocuments(url, [
    { engineId: 'wrong', result: { ...result('# Wrong\n\nforeign'), url: 'https://other.test/page' } },
    { engineId: 'right', result: result('# Guide\n\ncorrect') },
  ]);
  expect(output.body.content.indexOf('correct')).toBeLessThan(output.body.content.indexOf('foreign'));
  expect(output.body.content).toContain('返回页面目标不同');
});
it('does not mix a non-2xx body into a successful document', () => {
  const output = organizeDocuments(url, [
    { engineId: 'error', result: { ...result('# Guide\n\nNot found'), statusCode: 404 } },
    { engineId: 'ok', result: result('# Guide\n\nActual content') },
  ]);
  expect(output.statusCode).toBe(200);
  expect(output.body.content).toContain('非成功状态');
  const failed = { engineId: 'error', result: { ...result('Readable error'), statusCode: 404 } };
  expect(organizeDocuments(url, [failed])).toMatchObject({ statusCode: 404 });
  expect(organizeDocuments(url, [failed]).body.content).toContain('Readable error');
});
it('leaves structured JSON unchanged and rejects oversized structured results', () => {
  const candidate = { engineId: 'api', result: result('{"cursor":"next","items":[]}') };
  expect(organizeDocuments(url, [candidate])).toEqual(candidate.result);
  expect(() => organizeDocuments(url, [candidate], 5)).toThrow('structured response too large');
});
it('omits an oversized complete code block instead of returning a broken fence', () => {
  const candidate = { engineId: 'a', result: result('# Guide\n\n```ts\n' + 'x'.repeat(2000) + '\n```\n\nLast.') };
  const output = organizeDocuments(url, [candidate], 1000);
  expect(output.body.content).not.toContain('```');
  expect(output.body.content).toContain('已省略');
  expect(output.body.content.length).toBeLessThanOrEqual(1000);
  expect(output.truncated).toBe(true);
});
it('converts HTML without executing scripts and retains a table', () => {
  const candidate = { engineId: 'html', result: { ...result('<h1>Guide</h1><p>Text</p><script>bad()</script><table><tr><th>A</th></tr><tr><td>100</td></tr></table>'), body: { kind: 'html' as const, content: '<h1>Guide</h1><p>Text</p><script>bad()</script><table><tr><th>A</th></tr><tr><td>100</td></tr></table>' } } };
  const output = organizeDocuments(url, [candidate]);
  expect(output.body.content).toContain('100');
  expect(output.body.content).not.toContain('bad()');
});
it('splits fenced content without treating embedded headings as sections', () => {
  expect(splitBlocks('# Title\n\n~~~txt\n## literal\n~~~').map(block => block.kind)).toEqual(['heading', 'code']);
});
it('rejects challenge-only, unrelated-target and oversized candidate sets', () => {
  expect(() => organize('Just a moment...')).toThrow('没有可整理');
  expect(() => organizeDocuments(url, [{ engineId: 'wrong', result: { ...result('foreign'), url: 'https://other.test/' } }])).toThrow('没有可整理');
  expect(() => organize('x'.repeat(1_000_001))).toThrow('input too large');
  expect(() => organize(Array.from({ length: 2001 }, (_, i) => `Block ${i}`).join('\n\n'))).toThrow('too many extraction blocks');
});
it('is stable when completion order differs', async () => {
  const run = (delay: number) => aggregateDynamicFetch({ url, mode: 'organize', legs: [
    { engineId: 'a', extract: async () => { await new Promise(resolve => setTimeout(resolve, delay)); return result('# Guide\n\nShared.\n\nExtra A.'); } },
    { engineId: 'b', extract: async () => result('# Guide\n\nShared.\n\nExtra B.') },
  ] });
  const withoutTimestamps = (value: string) => value.replace(/接收时间：[^;]+/g, '接收时间：TIME');
  expect(withoutTimestamps((await run(10)).body.content)).toBe(withoutTimestamps((await run(0)).body.content));
});
