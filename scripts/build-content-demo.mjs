import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { aggregateDynamicFetch } from '../lib/fetch-aggregate.js';
import { fixtures } from './content-fixtures.mjs';

// The live capture is optional and supplied explicitly. This generator makes no network requests.
const liveIndex = process.argv.indexOf('--live-capture');
const scenarios = fixtures.map(fixture => ({
  name: fixture.name, kind: '合成规则示例', url: 'https://example.com/offline-fixture',
  inputs: fixture.bodies.map((content, index) => ({ service: ['firecrawl', 'anysearch', 'tavily'][index], content })),
  markers: fixture.markers, shared: fixture.shared,
}));
if (liveIndex >= 0) {
  const capture = JSON.parse(await readFile(process.argv[liveIndex + 1], 'utf8'));
  // Publish only the small illustrative Example Domain page, never arbitrary captured pages or headers.
  assert.equal(capture.url, 'https://example.com/');
  assert(capture.inputs.length >= 2);
  for (const input of capture.inputs) {
    assert(['firecrawl', 'tavily', 'exa'].includes(input.service));
    assert(typeof input.content === 'string' && input.content.length < 4_000);
    assert.equal(input.statusCode, 200);
    assert.equal(input.url, capture.url);
  }
  scenarios.unshift({ name: 'Example Domain 实际提取', kind: '真实接口采集', url: capture.url,
    capturedAt: capture.capturedAt, note: 'Firecrawl 无标题且包含多语言内容；Tavily 与 Exa 的共同正文合并来源。不同章节中满足规则的相同长段落也会去重，其他语言内容保留。输出的接收时间与请求数属于离线重放，不代表接口采集耗时或请求数。',
    inputs: capture.inputs.map(({ service, content }) => ({ service, content })) });
}
for (const scenario of scenarios) {
  const legs = scenario.inputs.map(input => ({ engineId: input.service,
    extract: async () => ({ url: scenario.url, statusCode: 200, body: { kind: 'text', content: input.content }, truncated: false }) }));
  const organized = await aggregateDynamicFetch({ url: scenario.url, legs, mode: 'organize' });
  scenario.output = organized.body.content;
  if (scenario.markers) {
    for (const marker of scenario.markers) assert(scenario.output.includes(marker), marker);
    assert.equal(scenario.output.split(scenario.shared).length - 1, 1);
  }
  assert.match(scenario.output, /提取来源与处理说明/);
}
const json = JSON.stringify({ schemaVersion: 1, scenarios }, null, 2);
await writeFile(new URL('../docs/assets/content-demo.json', import.meta.url), json);
const embedded = json.replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>网页正文整理 · dsh-web-search-fetch</title>
<style>
*{box-sizing:border-box}body{margin:0;background:oklch(97% .008 250);color:oklch(26% .02 250);font:16px/1.6 system-ui,sans-serif}
main{--gutter:clamp(1rem,3vw,3rem);display:grid;grid-template-columns:[full-start] minmax(var(--gutter),1fr) [content-start] min(100% - var(--gutter)*2,80rem) [content-end] minmax(var(--gutter),1fr) [full-end];padding-block:2rem;gap:1rem}
main>*{grid-column:content}h1{font-size:clamp(1.7rem,2.5vw,2.4rem);line-height:1.2;margin:0}h2{font-size:1.15rem;margin:0}p{margin:0}label{display:block;font-weight:600}
select{font:inherit;min-block-size:44px;max-inline-size:100%;padding:.4rem .7rem;border:1px solid oklch(65% .02 250);border-radius:.5rem;background:oklch(100% 0 none);color:inherit}
select:active{background:oklch(91% .025 250)}:focus-visible{outline:3px solid oklch(48% .15 250);outline-offset:3px}
@media(hover:hover) and (pointer:fine){select:hover{border-color:oklch(45% .15 250)}}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,25rem),1fr));gap:1rem;align-items:start}
article{min-inline-size:0;background:oklch(100% 0 none);border:1px solid oklch(88% .018 250);border-radius:.8rem;padding:1rem;display:grid;gap:.7rem}
pre{font:14px/1.65 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-block-size:38rem;overflow:auto}
#label{color:oklch(42% .1 250);font-weight:600}small{color:oklch(45% .02 250)}
</style>
<main><h1>同一网页，整理成一份正文</h1>
<p>可对齐的共同段落只保留一次，互补内容合并，数字差异保留原文和来源。选择示例查看输入与实际整理输出。</p>
<div><label for="case">示例</label><select id="case"></select></div>
<p id="label" aria-live="polite"></p>
<p id="note"></p>
<section class="panels" aria-label="输入与整理结果"><article><h2>各服务输入</h2><pre id="input"></pre></article><article><h2>整理输出 · Markdown 原文</h2><pre id="output"></pre></article></section>
<small>真实示例来自 Example Domain 的实际接口响应。其余示例为合成输入，用于验证整理规则，不代表服务质量或竞品表现。正文整理不判断事实真伪。</small>
<noscript>交互查看需要 JavaScript；全部输入与输出也保存在同目录的 content-demo.json。</noscript></main>
<script type="application/json" id="data">${embedded}</script>
<script>
const scenarios=JSON.parse(document.querySelector('#data').textContent).scenarios;
const select=document.querySelector('#case');
scenarios.forEach((scenario,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=scenario.name;select.append(option)});
function render(){const item=scenarios[Number(select.value)];document.querySelector('#label').textContent=item.kind+' · '+item.url+(item.capturedAt?' · '+item.capturedAt:'');document.querySelector('#note').textContent=item.note??'合成输入；断言检查全部标记内容保留、可对齐的共享段落出现一次。';document.querySelector('#input').textContent=item.inputs.map(input=>'【'+input.service+'】\\n'+input.content).join('\\n\\n');document.querySelector('#output').textContent=item.output;}
select.addEventListener('change',render);render();
</script></html>`;
await writeFile(new URL('../docs/assets/content-demo.html', import.meta.url), html);
console.log(JSON.stringify({ scenarios: scenarios.map(({ name, kind }) => ({ name, kind })), validated: true }));
