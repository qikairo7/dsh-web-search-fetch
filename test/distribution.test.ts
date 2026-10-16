import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it.each([
  'lib/index.js',
  'lib/index.d.ts',
  'lib/engines/decision/client.js',
  'lib/engines/decision/client.d.ts',
])('rejects an untracked distribution file even when it exists locally: %s', path => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-distribution-'));
  const index = execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: root, encoding: 'utf8' }).trim();
  const temporaryIndex = join(temporary, 'index');
  try {
    copyFileSync(resolve(root, index), temporaryIndex);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    execFileSync('git', ['update-index', '--force-remove', '--', path], { cwd: root, env });
    const result = spawnSync(process.execPath, ['scripts/check-distribution.mjs'], { cwd: root, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing Git distribution file: ${path}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
