import { expect, it } from 'vitest';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { organizeDocuments } from '../src/fetch-document/organize.js';

const request = 'http://example.com';
const result = (url = 'https://example.com/', content = '# Example Domain\n\nPublic example content.'): WebFetchResult => ({
  url, statusCode: 200, body: { kind: 'text', content }, truncated: false,
});

it('accepts the observed Doubao same-host HTTPS upgrade and returns the final URL', () => {
  const output = organizeDocuments(request, [{ engineId: 'doubao', result: result() }]);
  expect(output.url).toBe('https://example.com/');
  expect(output.body.content).toContain('Public example content.');
  expect(output.body.content).toContain('F1:B2');
});

it('does not merge an original HTTP document into the upgraded HTTPS main body', () => {
  const output = organizeDocuments(request, [
    { engineId: 'original', result: result('http://example.com/', '# Example Domain\n\nInsecure origin content.') },
    { engineId: 'doubao', result: result() },
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
  expect(() => organizeDocuments(input, [{ engineId: 'doubao', result: result(returned) }])).toThrow('没有可整理');
});

it('preserves structured content and its final URL on an HTTPS upgrade', () => {
  const fetched = result('https://example.com/', '{"items":[]}');
  expect(organizeDocuments(request, [{ engineId: 'doubao', result: fetched }])).toEqual(fetched);
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
    organizeDocuments('https://example.com', [{ engineId: 'doubao', result: result('https://other.test/?secret=private-value') }]);
    throw new Error('expected rejection');
  } catch (error) {
    expect(String(error)).toContain('doubao: target-mismatch');
    expect(String(error)).not.toContain('private-value');
    expect(String(error)).not.toContain('other.test');
  }
});
