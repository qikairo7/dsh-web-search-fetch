import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = new Set([pkg.main, pkg.types, pkg.dsh.bundle.patch.replace(/^\.\//, ''), 'client/index.js', 'LICENSE', 'NOTICE']);

function outputs(dir = 'src') {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) outputs(path);
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      const base = path.replace(/^src\//, 'lib/').slice(0, -3);
      required.add(`${base}.js`);
      required.add(`${base}.d.ts`);
    }
  }
}
outputs();

const missing = [...required].filter(path => !tracked.has(path) || !existsSync(join(root, path)));
if (missing.length) {
  for (const path of missing) console.error(`Missing Git distribution file: ${path}`);
  process.exitCode = 1;
} else {
  console.log(`Git distribution check passed (${required.size} required files, including all compiled modules).`);
}
