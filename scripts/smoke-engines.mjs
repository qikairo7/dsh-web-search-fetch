import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';
import { Context, Service } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolWeb from '@deepseek-ai/dsh-tool-web';
import WebRuntime from '@deepseek-ai/dsh-web';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import * as plugin from '../lib/index.js';
import { createAdditionalEngines } from '../lib/engines/additional/index.js';
import { RerankClient } from '../lib/engines/rerank/client.js';

// Real requests consume the configured services' quotas. Never print request headers or raw failures.
if (!process.argv.includes('--live')) throw new Error('pass --live to authorize real API requests');
const fetchOnly = process.argv.includes('--fetch-only');
const vaultPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml');
async function resolveCredential(ref) {
  const vault = yaml.parseDocument(await readFile(vaultPath, 'utf8'), { logLevel: 'silent' }).toJS();
  const value = process.env[ref]?.trim() || vault.refs?.[ref];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
class ReadOnlyCredentials extends Service {
  constructor(ctx) { super(ctx, 'credentials'); }
  async resolve(ref) { const value = await resolveCredential(ref); return value === undefined ? undefined : { value, source: 'smoke-vault' }; }
}

const ctx = new Context();
const fibers = [];
const report = { checks: [], searchEngines: [], extractionEngines: [] };
report.pipeline = { searchSucceeded: [], searchFailed: [], extractionSucceeded: [], extractionFailed: [] };
const stopExport = ctx.logger.exporter({ levels: { default: 3 }, export(message) {
  const line = typeof message.args[0] === 'string' ? message.args[0] : '';
  const search = /^\[搜索\] (?:服务|引擎) ([a-z0-9-]+) (成功|失败|超时)/.exec(line);
  const extraction = /^\[提取\] (?:服务|引擎) ([a-z0-9-]+) (成功|失败|超时|返回空正文)/.exec(line);
  if (search) report.pipeline[search[2] === '成功' ? 'searchSucceeded' : 'searchFailed'].push(search[1]);
  if (extraction) report.pipeline[extraction[2] === '成功' ? 'extractionSucceeded' : 'extractionFailed'].push(extraction[1]);
} });
let sequence = 0;
async function call(name, args) {
  const started = Date.now();
  const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`smoke-${++sequence}`), signal: AbortSignal.timeout(90_000) });
  report.checks.push({ name, ok: !result.isError, ms: Date.now() - started,
    ...(name === 'web_search' ? { sources: result.meta?.sources?.length ?? 0 } : {}),
  });
  return result;
}

try {
  fibers.push(await ctx.plugin(SystemPrompt));
  fibers.push(await ctx.plugin(ToolRuntime));
  fibers.push(await ctx.plugin(WebRuntime, { searchProvider: 'aggregated', fetchProvider: 'aggregated' }));
  fibers.push(await ctx.plugin(ReadOnlyCredentials));
  const bundle = yaml.parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const config = bundle.find(entry => entry.insert)?.insert.find(entry => entry.id === 'web-search-fetch').config;
  // A fresh local Cordis runtime exercises this checkout; it does not reload the live DSH profile.
  fibers.push(await ctx.plugin(plugin, config));
  fibers.push(await ctx.plugin(ToolWeb, { search: true, fetch: true, searchMaxResults: 8, searchTimeoutMs: 60000, fetchTimeoutMs: 90000 }));
  if (!fetchOnly) {
    const native = await call('web_search', { queries: ['DeepSeek Harness'] });
    if (native.isError || !native.meta?.sources?.length) throw new Error('native search failed');
  }
  const fetched = await call('web_fetch', { url: 'https://example.com' });
  if (fetched.isError) throw new Error('native fetch failed');
  if ([...report.pipeline.extractionSucceeded, ...report.pipeline.extractionFailed].includes('zhipu-reader')) throw new Error('removed reader was dispatched');
  if (!fetchOnly) {
    const extra = createAdditionalEngines(config.engines, resolveCredential, { searchTimeoutMs: 10000, fetchTimeoutMs: 45000 });
    await Promise.all(extra.map(async engine => {
      const started = Date.now();
      try { const result = await engine.search({ query: engine.id === 'aihot' ? 'DeepSeek' : 'DeepSeek Harness', maxResults: 2 }); report.searchEngines.push({ id: engine.id, ok: result.sources.length > 0, sources: result.sources.length, ms: Date.now() - started }); }
      catch(error) { report.searchEngines.push({ id: engine.id, ok: false, code: error.code ?? 'ERROR', ms: Date.now() - started }); }
    }));
    await Promise.all(extra.filter(engine => engine.extract).map(async engine => {
      const url = engine.id === 'github' ? 'https://github.com/deepseek-ai/deepseek-harness' : 'https://example.com';
      const started = Date.now();
      try { const result = await engine.extract(url); report.extractionEngines.push({ id: engine.id, ok: result.body.content.trim().length > 0, chars: result.body.content.length, status: result.statusCode, ms: Date.now() - started }); }
      catch(error) { report.extractionEngines.push({ id: engine.id, ok: false, code: error.code ?? 'ERROR', ms: Date.now() - started }); }
    }));
    const rerank = new RerankClient({ resolveApiKey: () => resolveCredential('SILICONFLOW_API_KEY'), credentialName: 'SILICONFLOW_API_KEY' });
    const order = await rerank.rerank('DeepSeek Harness', ['DeepSeek Harness agent framework', 'Recipes'], 2);
    report.checks.push({ name: 'siliconflow-rerank', ok: Array.isArray(order) && order.length === 2 });
  }
  const assembly = await ctx.systemPrompt.assemble();
  report.tools = assembly.tools.map(tool => tool.name);
  if (JSON.stringify([...report.tools].sort()) !== JSON.stringify(['web_fetch', 'web_search'])) throw new Error('unexpected tool surface');
  if (report.checks.some(check => !check.ok) || report.searchEngines.some(check => !check.ok) || report.extractionEngines.some(check => !check.ok)) process.exitCode = 1;
} catch {
  report.fatal = 'smoke_failed'; process.exitCode = 1;
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await stopExport();
  console.log(JSON.stringify(report, null, 2));
}
