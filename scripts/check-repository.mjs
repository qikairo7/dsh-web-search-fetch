import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['.git', 'node_modules', 'lib', '.scratch', 'coverage', 'AGENTS.md', 'CLAUDE.md']);
const errors = [];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`Symlink is not allowed in the public source: ${relative(root, path)}`);
    } else if (entry.isDirectory()) {
      walk(path);
    } else {
      files.push(path);
    }
  }
}
walk(root);

function prose(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
}

function anchors(text) {
  const counts = new Map();
  const result = new Set();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = match[1].trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    result.add(count === 0 ? slug : `${slug}-${count}`);
    counts.set(slug, count + 1);
  }
  return result;
}

for (const path of files) {
  const name = relative(root, path).split(sep).join('/');
  if (name !== '.env.example' && /^(docs\/(agents|adr)\/)|(^|\/)(\.env(?:\..*)?|\.credentials\.ya?ml|.*\.(log|tgz))$/.test(name)) {
    errors.push(`Private or generated file in public source: ${name}`);
  }
  if (!/\.(md|ts|js|mjs|json|ya?ml)$/.test(path) || name === 'scripts/check-repository.mjs') continue;
  const text = readFileSync(path, 'utf8');
  if (/(?:[A-Za-z]:[\\/]Users[\\/]|待.{0,10}终审|grilling 会话|三任接力)/.test(text)) {
    errors.push(`Local development detail in public source: ${name}`);
  }
  if (!path.endsWith('.md')) continue;
  const body = prose(text);
  let level = 0;
  for (const heading of body.matchAll(/^(#{1,6})\s+/gm)) {
    const next = heading[1].length;
    if (next > level + 1) errors.push(`Skipped heading level: ${name}`);
    level = next;
  }
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const [file, fragment] = target.split('#');
    const dest = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
    if (!existsSync(dest)) {
      errors.push(`Broken link in ${name}: ${target}`);
    } else if (fragment && dest.endsWith('.md') && !anchors(readFileSync(dest, 'utf8')).has(decodeURIComponent(fragment))) {
      errors.push(`Missing heading in ${name}: ${target}`);
    }
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const entry of [pkg.main, pkg.types, pkg.dsh.bundle.patch, 'client/index.js', 'LICENSE', 'NOTICE']) {
  if (!existsSync(join(root, entry))) errors.push(`Missing package entry: ${entry}`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Repository check passed (${files.length} files; documentation links, headings and package entries).`);
}
