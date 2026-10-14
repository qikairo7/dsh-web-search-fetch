import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import yaml from 'yaml';
import { createAdditionalEngines } from '../lib/engines/additional/index.js';
import { createAggregatedSearchProvider } from '../lib/search-pipeline.js';
import { AggregatedFetchProvider, createExtractionLegs } from '../lib/fetch-pipeline.js';
import { FirecrawlClient } from '../lib/engines/firecrawl/client.js';
import { AnySearchEngine } from '../lib/engines/anysearch/engine.js';
import { budgetedFetch } from '../lib/request-budget.js';

// Both core pipelines run in this Node process. No production profile is mounted.
if (!process.argv.includes('--live')) throw new Error('--live is required: this benchmark consumes service quotas');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const modDirectory = option('--modsearch-source');
const outputFile = option('--output');
if (!modDirectory || !outputFile) throw new Error('provide --modsearch-source and --output');
const modPackage = JSON.parse(await readFile(join(modDirectory, 'package.json'), 'utf8'));
assert.equal(modPackage.name, '@liustack/modsearch');
assert.equal(modPackage.version, '5.10.6', 'comparison is pinned to ModSearch 5.10.6');
const { runSearch } = await import(pathToFileURL(resolve(modDirectory, 'src/search.ts')).href);
const repeats = Number(option('--repeats') ?? 2);
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
const cases = [
  { id: 'node-esm', query: 'Node.js ECMAScript modules official documentation', domains: ['nodejs.org'] },
  { id: 'python-taskgroup', query: 'Python asyncio TaskGroup official documentation', domains: ['docs.python.org'] },
  { id: 'typescript-satisfies', query: 'TypeScript satisfies operator official documentation', domains: ['typescriptlang.org'] },
  { id: 'node-page', url: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs', markers: ['JavaScript', 'V8', 'asynchronous'] },
  { id: 'python-page', url: 'https://docs.python.org/3/library/asyncio-task.html', markers: ['TaskGroup', 'create_task', 'timeout'] },
  { id: 'typescript-page', url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html', markers: ['Union Types', 'Type Aliases', 'Interfaces'] },
];
const keys = {};
if (process.argv.includes('--with-credentials')) {
  const refs = ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY'];
  let vault;
  if (refs.some(ref => !process.env[ref]?.trim())) {
    const content = await readFile(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    vault = yaml.parse(content);
  }
  for (const ref of refs) {
    const value = process.env[ref]?.trim() || vault?.refs?.[ref];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`research cohort requires ${ref}`);
    keys[ref] = value.trim();
  }
}
const cohorts = process.argv.includes('--with-credentials') ? ['anonymous', 'research'] : ['anonymous'];
const nativeFetch = globalThis.fetch;
let counter;
globalThis.fetch = (input, init) => { if (counter) counter.requests++; return nativeFetch(input, init); };
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, modsearchVersion: modPackage.version,
  modsearchCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: modDirectory, encoding: 'utf8' }).trim(),
  settings: { maxResults: 5, maxOutputChars: 50_000, searchDeadlineMs: 15_000, fetchDeadlineMs: 50_000, rerank: false },
  scope: 'live core API pipelines; no model, CLI startup or UI overhead; fetch invocations exclude transparent redirects and vendor-internal fetches',
  repeats, cases, rows: [], credentialNames: Object.keys(keys),
};
function ours(cohort) {
  const resolveCredential = async ref => cohort === 'research' ? keys[String(ref)] : undefined;
  const settings = cohort === 'research' ? { firecrawl: {}, tavily: {}, exa: {} } : { firecrawl: {}, bing: {} };
  const searchServices = Object.keys(settings);
  const fetchServices = cohort === 'research' ? ['firecrawl', 'tavily', 'exa'] : ['firecrawl'];
  const controls = { searchServices, fetchServices, maxSearchServices: 3, maxFetchServices: 3, maxRequests: 8,
    searchDeadlineMs: 15_000, fetchDeadlineMs: 50_000, maxOutputChars: 50_000, mode: 'organize' };
  const additionalEngines = createAdditionalEngines(settings, resolveCredential, { searchTimeoutMs: 10_000, fetchTimeoutMs: 45_000 });
  const search = createAggregatedSearchProvider({ resolveCredential, additionalEngines, resolveControls: () => controls,
    rerank: false, zhihuQuotaCheck: false, maxFanoutMs: 10_000 });
  const fetch = new AggregatedFetchProvider({ additionalEngines, resolveControls: () => controls, legs: createExtractionLegs({
    firecrawl: new FirecrawlClient({ resolveApiKey: () => resolveCredential('FIRECRAWL_API_KEY'), credentialName: 'FIRECRAWL_API_KEY', fetchImpl: budgetedFetch() }),
    anysearch: new AnySearchEngine({ resolveApiKey: async () => undefined, credentialName: 'UNCONFIGURED' }),
  }) });
  return async item => item.url ? fetch.fetch({ url: item.url }) : search.search({ query: item.query, maxResults: 5 });
}
function competitor(cohort) {
  const config = { engines: { 'antigravity-cli': { enabled: false }, 'grok-cli': { enabled: false },
    tavily: { enabled: cohort === 'research' }, exa: { enabled: cohort === 'research' }, firecrawl: { enabled: true }, local: { enabled: true } } };
  const env = cohort === 'research' ? keys : {};
  return item => runSearch({ ...(item.url ? { url: item.url } : { query: item.query }), sources: 'web', config, env,
    maxResults: 5, timeoutMs: item.url ? 45_000 : 10_000, deadlineMs: item.url ? 50_000 : 15_000 });
}
const normalizedUrl = raw => {
  try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) return undefined; url.hash = ''; return url.href; }
  catch { return undefined; }
};
async function trial(product, cohort, item, repeat, invoke) {
  counter = { requests: 0 };
  const started = performance.now();
  const row = { product, cohort, case: item.id, repeat, ok: false };
  try {
    const result = await invoke(item);
    const entry = product === 'modsearch' ? result.results?.[0] : result;
    const sources = product === 'modsearch' ? entry?.items ?? [] : result.sources ?? [];
    const content = product === 'modsearch' ? entry?.content ?? '' : result.body?.content ?? '';
    row.ok = product === 'modsearch' ? entry?.status === 'ok' : item.url ? result.statusCode >= 200 && result.statusCode < 300 : sources.length > 0;
    row.outputChars = JSON.stringify(result).length;
    if (item.url) {
      row.bodyChars = content.length;
      row.markerHits = item.markers.filter(marker => content.toLowerCase().includes(marker.toLowerCase())).length;
      row.markerTotal = item.markers.length;
      row.truncated = product === 'modsearch' ? null : result.truncated;
    } else {
      const urls = [...new Set(sources.map(source => normalizedUrl(source.url)).filter(Boolean))];
      row.sourceCount = urls.length;
      row.domainCount = new Set(urls.map(url => new URL(url).hostname)).size;
      row.expectedDomainHits = urls.filter(url => item.domains.some(domain => new URL(url).hostname === domain || new URL(url).hostname.endsWith('.' + domain))).length;
      row.urls = urls;
    }
    if (product === 'modsearch') {
      row.attempts = (entry?.attempts ?? []).map(attempt => ({ engine: attempt.engine, ok: attempt.ok, durationSeconds: attempt.durationSeconds,
        ...(typeof attempt.credits === 'number' ? { credits: attempt.credits } : {}), ...(typeof attempt.cost === 'number' ? { cost: attempt.cost } : {}) }));
    }
  } catch (error) { row.code = error?.code ?? error?.name ?? 'ERROR'; }
  finally { row.ms = Math.round(performance.now() - started); row.requests = counter.requests; counter = undefined; }
  report.rows.push(row);
  await writeFile(outputFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ product, cohort, case: item.id, repeat, ok: row.ok, ms: row.ms, requests: row.requests }));
}
try {
  for (const cohort of cohorts) {
    const pipelines = { ours: ours(cohort), modsearch: competitor(cohort) };
    for (let repeat = 1; repeat <= repeats; repeat++) for (const item of cases) {
      for (const product of repeat % 2 ? ['ours', 'modsearch'] : ['modsearch', 'ours']) await trial(product, cohort, item, repeat, pipelines[product]);
    }
  }
} finally { globalThis.fetch = nativeFetch; }
console.log(JSON.stringify({ completed: report.rows.length, output: outputFile }));
