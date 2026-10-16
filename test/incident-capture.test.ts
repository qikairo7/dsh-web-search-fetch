import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
const organizer = new URL('../lib/fetch-document/organize.js', import.meta.url).href;
function destination() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-incident-'));
  directories.push(directory);
  return join(directory, 'trace.jsonl');
}
function run(file: string, body: string) {
  return spawnSync(process.execPath, ['--import', new URL('../scripts/capture-fetch-rejection.mjs', import.meta.url).href, '--input-type=module', '-e', body], {
    env: { ...process.env, DSH_FETCH_TRACE_FILE: file }, encoding: 'utf8', timeout: 15_000,
  });
}
const fixture = (input: string, returned: string, content: string) => `
  import { organizeDocuments } from ${JSON.stringify(organizer)};
  try { organizeDocuments(${JSON.stringify(input)}, [{engineId:'doubao',result:{url:${JSON.stringify(returned)},statusCode:200,body:{kind:'text',content:${JSON.stringify(content)}},truncated:false}}]); }
  catch {}
`;
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('captures real organizer rejection classifications without URL credentials or body text', () => {
  const file = destination();
  const body = fixture('https://example.com', 'https://trace-user:trace-password@other.test/path?token=trace-query#trace-fragment', '# Article\n\ntrace-private-body')
    + fixture('https://example.com', 'https://example.com/', 'Just a moment...');
  // Import the real organizer once, then invoke both rejection paths in the same process.
  const script = body.replaceAll(`import { organizeDocuments } from ${JSON.stringify(organizer)};`, '');
  const result = run(file, `import { organizeDocuments } from ${JSON.stringify(organizer)};${script}`);
  expect(result.status, result.stderr).toBe(0);
  const text = readFileSync(file, 'utf8');
  for (const secret of ['trace-user', 'trace-password', 'trace-query', 'trace-fragment', 'trace-private-body']) expect(text).not.toContain(secret);
  const events = text.trim().split('\n').map(line => JSON.parse(line));
  const rejections = events.filter(event => event.phase === 'organizer-rejection');
  expect(events.some(event => event.phase === 'capture-error')).toBe(false);
  expect(rejections).toHaveLength(2);
  expect(rejections[0].documents[0]).toMatchObject({ url: { url: 'https://other.test/path', redacted: true }, status: 200, challenge: false, successful: false });
  expect(rejections[1].documents[0]).toMatchObject({ challenge: true, successful: false });
  expect(rejections.every(event => event.usable === 0)).toBe(true);
});

it('does not capture private input URLs', () => {
  const file = destination();
  const result = run(file, fixture('https://private.test/private-input', 'https://other.test/private-return', 'private-body'));
  expect(result.status, result.stderr).toBe(0);
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('private-input');
  expect(text).not.toContain('private-return');
  expect(text.trim().split('\n').map(line => JSON.parse(line).phase)).toEqual(['capture-start']);
});

it('refuses to overwrite an existing incident file', () => {
  const file = destination();
  writeFileSync(file, 'preserved evidence');
  const result = run(file, 'throw new Error("main must not run")');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('EEXIST');
  expect(readFileSync(file, 'utf8')).toBe('preserved evidence');
});

it('records an unreadable debugger result without leaking it or terminating the host', () => {
  const file = destination();
  const script = fixture('https://example.com', 'https://other.test/', 'ordinary body');
  const importLine = `import { organizeDocuments } from ${JSON.stringify(organizer)};`;
  const result = run(file, `${importLine}
    const originalStringify = JSON.stringify;
    JSON.stringify = (value, ...args) => value?.requestUrl && Array.isArray(value.documents) ? 'trace-private-result' : originalStringify(value, ...args);
    ${script.replace(importLine, '')}
    process.stdout.write('host-continued');
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('host-continued');
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('trace-private-result');
  expect(text.trim().split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ phase: 'capture-error', reason: 'decoding-failed' }));
});

it('preserves exact target spelling when the host global URL parser fails', () => {
  const file = destination();
  const importLine = `import { organizeDocuments } from ${JSON.stringify(organizer)};`;
  const script = fixture('https://example.com', 'https://example.com/', 'ordinary body');
  const result = run(file, `${importLine}
    globalThis.URL = class { constructor() { throw new Error('unavailable global parser'); } };
    ${script.replace(importLine, '')}
  `);
  expect(result.status, result.stderr).toBe(0);
  const events = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const rejection = events.find(event => event.phase === 'organizer-rejection');
  expect(rejection.requestTarget).toMatchObject({ url: 'https://example.com', redacted: false });
  expect(rejection.documents[0].target).toMatchObject({ url: 'https://example.com/', redacted: false });
});
