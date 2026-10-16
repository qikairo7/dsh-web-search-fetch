import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

// pnpm 12 stores package-manager and project locks as separate YAML documents.
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const documents = parseAllDocuments(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'));
for (const document of documents) {
  if (document.errors.length) throw document.errors[0];
}
const projectLocks = documents.map(document => document.toJSON()).filter(value => value?.importers?.['.']?.dependencies && value.snapshots);
if (projectLocks.length !== 1) throw new Error(`Expected one project dependency lock, found ${projectLocks.length}`);
const lock = projectLocks[0];
const direct = lock.importers['.'].dependencies;
for (const [name, version] of Object.entries(pkg.dependencies)) {
  if (direct[name]?.specifier !== version) throw new Error(`Manifest/lock mismatch: ${name}`);
}

const queue = Object.entries(pkg.dependencies).map(([name]) => [name, direct[name].version]);
const packages = new Map();
while (queue.length) {
  const [name, resolution] = queue.shift();
  const key = `${name}@${resolution}`;
  if (packages.has(key)) continue;
  const snapshot = lock.snapshots[key];
  if (!snapshot) throw new Error(`Missing locked snapshot: ${key}`);
  const version = resolution.split('(')[0];
  const integrity = lock.packages[`${name}@${version}`]?.resolution.integrity;
  if (!integrity) throw new Error(`Missing integrity: ${key}`);
  packages.set(key, { name, version, direct: Object.hasOwn(pkg.dependencies, name), integrity });
  queue.push(...Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies }));
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Registry returned ${response.status}: ${url}`);
  return response.json();
}

const inventory = await Promise.all([...packages.values()].map(async entry => {
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${entry.version}`;
  const metadata = await json(metadataUrl);
  if (metadata.name !== entry.name || metadata.version !== entry.version || metadata.dist?.integrity !== entry.integrity) {
    throw new Error(`Registry identity/integrity mismatch: ${entry.name}@${entry.version}`);
  }
  return {
    ...entry, metadataUrl, license: metadata.license ?? null, repository: metadata.repository ?? null,
    tarball: metadata.dist.tarball, engines: metadata.engines ?? {},
    installScripts: Object.fromEntries(['preinstall', 'install', 'postinstall'].filter(name => metadata.scripts?.[name]).map(name => [name, metadata.scripts[name]])),
    sourceBuildScripts: Object.fromEntries(['prepare', 'prepack', 'postpack'].filter(name => metadata.scripts?.[name]).map(name => [name, metadata.scripts[name]])),
    attestations: metadata.dist.attestations ?? null,
    dependencies: metadata.dependencies ?? {},
  };
}));
const versions = {};
for (const { name, version } of inventory) versions[name] = [...new Set([...(versions[name] ?? []), version])];
const advisoryEndpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const advisories = await json(advisoryEndpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(versions),
});
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), packageName: pkg.name, packageVersion: pkg.version,
  method: 'Author-provided registry metadata, lock integrity comparison and npm advisory lookup; not an independent security approval.',
  scope: 'Direct runtime dependencies and their locked transitive closure; host peer dependencies and development dependencies excluded.',
  advisoryEndpoint, packages: inventory, advisories,
}, null, 2));
if (Object.keys(advisories).length) process.exitCode = 1;
