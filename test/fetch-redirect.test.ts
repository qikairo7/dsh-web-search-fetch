import { expect, it } from 'vitest';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { organizeDocuments } from '../src/fetch-document/organize.js';

const request = 'http://example.com';
const result = (url = 'https://example.com/', content = '# Example Domain\n\nPublic example content.'): WebFetchResult => ({
  url, statusCode: 200, body: { kind: 'text', content }, truncated: false,
});

it('accepts the generic same-host HTTPS upgrade and returns the final URL', () => {
  const output = organizeDocuments(request, [{ engineId: 'engine-a', result: result() }]);
  expect(output.url).toBe('https://example.com/');
  expect(output.body.content).toContain('Public example content.');
  // A single extract names its one source in the compact footer; an inline
  // per-block marker would only repeat it (see organize.ts).
  expect(output.body.content).toContain('F1: engine-a 200');
  expect(output.body.content).not.toContain('提取来源：');
});

it('does not merge an original HTTP document into the upgraded HTTPS main body', () => {
  const output = organizeDocuments(request, [
    { engineId: 'original', result: result('http://example.com/', '# Example Domain\n\nInsecure origin content.') },
    { engineId: 'engine-a', result: result() },
  ]);
  expect(output.url).toBe('https://example.com/');
  const main = output.body.content.split('## 补充片段')[0]!;
  expect(main).toContain('Public example content.');
  expect(main).not.toContain('Insecure origin content.');
  expect(output.body.content).toContain('返回页面目标不同');
});

it.each([
  ['https://example.com', 'http://example.com/'],
  [request, 'https://other.test/'],
  [request, 'https://example.com/other'],
  [request, 'https://example.com/?other=1'],
  ['http://example.com:8080', 'https://example.com/'],
  [request, 'https://example.com:8443/'],
  [request, 'https://user:password@example.com/'],
])('continues rejecting a different or unsafe target: %s -> %s', (input, returned) => {
  expect(() => organizeDocuments(input, [{ engineId: 'engine-a', result: result(returned) }])).toThrow('没有可整理');
});

it('preserves structured content and its final URL on an HTTPS upgrade', () => {
  const fetched = result('https://example.com/', '{"items":[]}');
  expect(organizeDocuments(request, [{ engineId: 'engine-a', result: fetched }])).toEqual(fetched);
});

it('preserves a non-2xx body and final URL on an allowed HTTPS upgrade', () => {
  const fetched = { ...result(), statusCode: 404 };
  const output = organizeDocuments(request, [{ engineId: 'engine-a', result: fetched }]);
  expect(output.url).toBe('https://example.com/');
  expect(output.statusCode).toBe(404);
  expect(output.body.content).toContain('Public example content.');
});

it('does not let an upgraded challenge hide a usable original document', () => {
  const output = organizeDocuments(request, [
    { engineId: 'blocked', result: result('https://example.com/', 'Just a moment...') },
    { engineId: 'original', result: result('http://example.com/') },
  ]);
  expect(output.url).toBe('http://example.com/');
  expect(output.body.content).toContain('Public example content.');
});

it('identifies the rejected engine and reason without exposing URL credentials', () => {
  try {
    organizeDocuments('https://example.com', [{ engineId: 'engine-a', result: result('https://other.test/?secret=private-value') }]);
    throw new Error('expected rejection');
  } catch (error) {
    expect(String(error)).toContain('engine-a: target-mismatch');
    expect(String(error)).not.toContain('private-value');
    expect(String(error)).not.toContain('other.test');
  }
});
