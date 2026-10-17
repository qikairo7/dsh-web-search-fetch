import { describe, expect, it } from 'vitest';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { AggregatedFetchProvider } from '../src/fetch-pipeline.js';
import { probeVerdict, PROBE_MIN_PARAGRAPH_CHARS } from '../src/fetch-aggregate.js';
import { organizeDocuments, SUPPLEMENT_ENTRY_BUDGET_CHARS, SUPPLEMENT_TOTAL_BUDGET_CHARS, THIN_BODY_PARAGRAPH_CHARS } from '../src/fetch-document/organize.js';

const url = 'https://example.com/guide';

function page(content: string, extra: Partial<WebFetchResult> = {}): WebFetchResult {
  return { url, statusCode: 200, body: { kind: 'text', content }, truncated: false, ...extra };
}

/** A body whose paragraphs reach `chars` characters. */
function body(chars: number, title = '# Guide'): string {
  const paragraph = 'A documented sentence with stable content and a concrete explanation. ';
  return `${title}\n\n${paragraph.repeat(Math.ceil(chars / paragraph.length))}`;
}

interface Counted {
  readonly engineId: string;
  readonly calls: () => number;
  readonly leg: { engineId: string; extract: (url: string, signal?: AbortSignal) => Promise<WebFetchResult> };
}

function countedLeg(engineId: string, extract: (url: string) => Promise<WebFetchResult>): Counted {
  let calls = 0;
  return {
    engineId,
    calls: () => calls,
    leg: {
      engineId,
      async extract(target) {
        calls += 1;
        return await extract(target);
      },
    },
  };
}

describe('probeVerdict', () => {
  it('2xx + 同目标 + 足够段落 → 可直接返回原文', () => {
    expect(probeVerdict(url, page(body(PROBE_MIN_PARAGRAPH_CHARS)))).toEqual({ sufficient: true });
  });

  it('段落不足、非 2xx、目标不同、挑战页都要升级', () => {
    expect(probeVerdict(url, page(body(120)))).toMatchObject({ sufficient: false, reason: 'body-thin' });
    expect(probeVerdict(url, page(body(2000), { statusCode: 404 }))).toMatchObject({ sufficient: false, reason: 'non-2xx' });
    expect(probeVerdict(url, page(body(2000), { url: 'https://other.test/guide' }))).toMatchObject({ sufficient: false, reason: 'target-mismatch' });
    expect(probeVerdict(url, page('Just a moment...'))).toMatchObject({ sufficient: false, reason: 'challenge' });
  });

  it('同资源 HTTPS 升级仍算同一目标', () => {
    expect(probeVerdict('http://example.com/guide', page(body(600), { url: 'https://example.com/guide' }))).toEqual({ sufficient: true });
  });
});

describe('两段式抓取', () => {
  it('首路正文够用 → 只派发一路，返回原文，不加溯源标记', async () => {
    const first = countedLeg('firecrawl', async target => page(body(900), { url: target }));
    const second = countedLeg('anysearch', async target => page(body(900), { url: target }));
    const provider = new AggregatedFetchProvider({ legs: [first.leg, second.leg], resolveControls: () => ({ preset: 'auto', mode: 'organize' }) });
    const output = await provider.fetch({ url });
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
    expect(output.body.content).toBe(body(900));
    expect(output.body.content).not.toContain('提取来源');
    expect(output.body.content).not.toContain('补充片段');
    expect(output.body.content).not.toContain('## 提取来源与处理说明');
  });

  it('首路正文不足 → 升级为多路整理，标记与尾注随之出现', async () => {
    const first = countedLeg('firecrawl', async target => page('# Stub\n\nshort.', { url: target }));
    const second = countedLeg('anysearch', async target => page(body(900), { url: target }));
    const provider = new AggregatedFetchProvider({ legs: [first.leg, second.leg], resolveControls: () => ({ preset: 'auto', mode: 'organize' }) });
    const output = await provider.fetch({ url });
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    expect(output.body.content).toContain('## 提取来源与处理说明');
    expect(output.body.content).toContain('提取来源：');
  });

  it('首路抛错也升级，不把探测失败当成整体失败', async () => {
    const first = countedLeg('firecrawl', async () => { throw new Error('engine down'); });
    const second = countedLeg('anysearch', async target => page(body(900), { url: target }));
    const provider = new AggregatedFetchProvider({ legs: [first.leg, second.leg], resolveControls: () => ({ preset: 'auto', mode: 'organize' }) });
    const output = await provider.fetch({ url });
    expect(output.body.content).toContain('A documented sentence');
  });

  it('single 预设只派发一路；未开启升级时正文再薄也原样返回', async () => {
    const first = countedLeg('firecrawl', async target => page('# Stub\n\nshort.', { url: target }));
    const second = countedLeg('anysearch', async target => page(body(900), { url: target }));
    const provider = new AggregatedFetchProvider({ legs: [first.leg, second.leg], resolveControls: () => ({ preset: 'single', mode: 'organize' }) });
    const output = await provider.fetch({ url });
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
    expect(output.body.content).toBe('# Stub\n\nshort.');
  });

  it('single 预设不裁剪长正文：输出等于该通道返回的原文', async () => {
    // The single channel's contract is "serve that one channel's own text".
    // Cutting it to a fixed size would silently damage the page itself, so the
    // length of a single-channel result is the channel's representation, not a
    // plugin budget; see the acceptance record for how criterion 1 is measured.
    const long = body(5_000);
    const first = countedLeg('firecrawl', async target => page(long, { url: target }));
    const provider = new AggregatedFetchProvider({ legs: [first.leg], resolveControls: () => ({ preset: 'single', mode: 'organize' }) });
    const output = await provider.fetch({ url });
    expect(output.body.content).toBe(long);
    expect(output.body.content.length).toBeGreaterThan(800);
  });

  it('singleChannelEscalate 打开后，单通道正文不足改走多路整理', async () => {
    const first = countedLeg('firecrawl', async target => page('# Stub\n\nshort.', { url: target }));
    const second = countedLeg('anysearch', async target => page(body(900), { url: target }));
    const provider = new AggregatedFetchProvider({
      legs: [first.leg, second.leg],
      singleChannelEscalate: true,
      resolveControls: () => ({ preset: 'single', mode: 'organize' }),
    });
    const output = await provider.fetch({ url });
    expect(second.calls()).toBe(1);
    expect(output.body.content).toContain('## 提取来源与处理说明');
  });
});

describe('标记收敛与预算', () => {
  it('单源不内联提取来源，多源才内联', () => {
    const single = organizeDocuments(url, [{ engineId: 'a', result: page(body(600)) }]).body.content;
    expect(single).not.toContain('提取来源：');
    const multi = organizeDocuments(url, [
      { engineId: 'a', result: page(body(600)) },
      { engineId: 'b', result: page(`${body(600, '# Guide')}\n\n## Extra\n\nDistinct.`) },
    ]).body.content;
    expect(multi).toContain('提取来源：');
  });

  it('尾注压缩为一行一路，不再逐块列 URL 与时间', () => {
    const content = organizeDocuments(url, [{ engineId: 'a', result: page(body(600)) }]).body.content;
    const footer = content.slice(content.indexOf('## 提取来源与处理说明'));
    expect(footer).toContain('F1: a 200');
    expect(footer).not.toContain('接收时间');
    expect(footer).not.toContain('返回 URL');
  });

  it('参照正文过薄时给出 body-thin 说明', () => {
    const thin = organizeDocuments(url, [{ engineId: 'a', result: page('# Guide\n\nShort body.') }]).body.content;
    expect(thin).toContain('body-thin');
    expect(thin).toContain(String(THIN_BODY_PARAGRAPH_CHARS));
    const substantial = organizeDocuments(url, [{ engineId: 'a', result: page(body(900)) }]).body.content;
    expect(substantial).not.toContain('body-thin');
  });

  it('参照文档按段落字符数选择，而不是章节数', () => {
    const headingHeavy = '# Guide\n\n' + Array.from({ length: 12 }, (_, index) => `## Part ${index}\n\nTiny.`).join('\n\n');
    const prose = body(900);
    const content = organizeDocuments(url, [
      { engineId: 'headings', result: page(headingHeavy) },
      { engineId: 'prose', result: page(prose) },
    ]).body.content;
    // The prose document is the reference: its paragraph survives verbatim.
    expect(content).toContain(prose.split('\n\n')[1]!.slice(0, 60));
    expect(content.indexOf(prose.split('\n\n')[1]!.slice(0, 60))).toBeLessThan(content.indexOf('## Part 0'));
  });

  it('补充片段总预算 4000 字符、单条 1200 字符', () => {
    const blocks = Array.from({ length: 12 }, (_, index) => `## 独有章节 ${index}\n\n${'Unique supplement sentence. '.repeat(80)}`);
    const content = organizeDocuments(url, [
      { engineId: 'main', result: page(body(2500)) },
      { engineId: 'other', result: page(['# Other', ...blocks].join('\n\n')) },
    ]).body.content;
    const supplementStart = content.indexOf('## 补充片段');
    expect(supplementStart).toBeGreaterThan(-1);
    const supplementEnd = content.indexOf('## 提取来源与处理说明');
    const supplement = content.slice(supplementStart, supplementEnd === -1 ? undefined : supplementEnd);
    expect(supplement.length).toBeLessThanOrEqual(SUPPLEMENT_TOTAL_BUDGET_CHARS + '## 补充片段'.length + 2);
    expect(SUPPLEMENT_ENTRY_BUDGET_CHARS).toBeLessThan(SUPPLEMENT_TOTAL_BUDGET_CHARS);
  });

  it('参照正文足够长时，不兼容的提取只记数量', () => {
    const otherText = 'A distinct alternative body that must not be repeated in full. ';
    const content = organizeDocuments(url, [
      { engineId: 'main', result: page(body(2500)) },
      { engineId: 'other', result: page(`# Different title ${'x'.repeat(40)}\n\n${otherText.repeat(30)}`) },
    ]).body.content;
    expect(content).toContain('仅保留摘要');
    expect(content).not.toContain(otherText.repeat(30));
  });

  it('同一 reason 的标签在补充片段里只出现一次', () => {
    const orphan = '# Orphan\n\n' + Array.from({ length: 6 }, (_, index) => `Unique orphan block ${index} with no shared anchor.`).join('\n\n');
    const content = organizeDocuments(url, [
      { engineId: 'main', result: page(body(600)) },
      { engineId: 'other', result: page(orphan) },
    ]).body.content;
    const supplement = content.slice(content.indexOf('## 补充片段'), content.indexOf('## 提取来源与处理说明'));
    const labels = supplement.match(/^F\d+：标题或版本不同，未加入主正文$/gm) ?? [];
    expect(labels).toHaveLength(1);
    // Every block of that extract still reaches the reader under the one label.
    for (let index = 0; index < 6; index++) expect(supplement).toContain(`Unique orphan block ${index}`);
  });

  it('补充片段的整节字符（含标题、标签与分隔符）不超过总预算', () => {
    const orphan = '# Orphan\n\n' + Array.from({ length: 24 }, (_, index) => `Unique orphan block ${index} ${'filler text '.repeat(20)}`).join('\n\n');
    const content = organizeDocuments(url, [
      { engineId: 'main', result: page(body(600)) },
      { engineId: 'other', result: page(orphan) },
    ]).body.content;
    const start = content.indexOf('## 补充片段');
    const end = content.indexOf('## 提取来源与处理说明');
    const section = content.slice(start, end === -1 ? undefined : end).trimEnd();
    expect(start).toBeGreaterThan(-1);
    expect(section.length).toBeLessThanOrEqual(SUPPLEMENT_TOTAL_BUDGET_CHARS);
  });

  it('清单类表格被裁剪到前 20 行并说明，正文段落不受影响', () => {
    const rows = Array.from({ length: 60 }, (_, index) => {
      const name = `folder-${index.toString().padStart(2, '0')}`;
      return `| [${name}](https://example.com/tree/${name} "${name}") |  | [${name}](https://example.com/tree/${name} "${name}") |  |  |`;
    });
    const listing = ['| Name |  | Name | Last commit message | Last commit date |', '|---|---|---|---|---|', ...rows].join('\n');
    const content = organizeDocuments(url, [
      { engineId: 'main', result: page(`# Guide\n\n${body(600)}\n\n## Folders and files\n\n${listing}\n\n## Readme\n\n${body(600)}`) },
    ]).body.content;
    const table = content.slice(content.indexOf('| Name |'), content.indexOf('（表格仅保留前'));
    // Header plus at most 20 data rows reaches the output.
    expect(table.split('\n').filter(line => line.startsWith('|')).length).toBeLessThanOrEqual(22);
    expect(content).toContain('另有');
    expect(content).toContain('A documented sentence');
  });

  it('数据表格不裁剪（清单规则只针对导航类表格）', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| Release ${index} | Notes for release ${index} are described in prose here. |`);
    const table = ['| Version | Notes |', '| --- | --- |', ...rows].join('\n');
    const content = organizeDocuments(url, [{ engineId: 'main', result: page(`# Guide\n\n${table}`) }]).body.content;
    expect(content).toContain('Notes for release 39');
    expect(content).not.toContain('表格仅保留前');
  });

  it('链接列 + 说明文字 + 空列的数据表不裁剪', () => {
    // Version history shape: one link cell, one prose cell, then blank cells.
    const rows = Array.from({ length: 40 }, (_, index) => `| [v${39 - index}](https://example.com/releases/${39 - index}) | Fixes the regression reported in issue ${index}. |  |  |`);
    const table = ['| Version | Notes |  |  |', '| --- | --- | --- | --- |', ...rows].join('\n');
    const content = organizeDocuments(url, [{ engineId: 'main', result: page(`# Guide\n\n${table}`) }]).body.content;
    expect(content).toContain('Fixes the regression reported in issue 39');
    expect(content).toContain('[v0](https://example.com/releases/0)');
    expect(content).not.toContain('表格仅保留前');
  });

  it('升级输出预算也不会裁掉链接型数据表', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| [v${39 - index}](https://example.com/releases/${39 - index}) | Fixes the regression reported in issue ${index}. |  |  |`);
    const table = ['| Version | Notes |  |  |', '| --- | --- | --- | --- |', ...rows].join('\n');
    const content = organizeDocuments(url, [{ engineId: 'main', result: page(`# Guide\n\n${table}`) }], 1_000_000).body.content;
    expect(content).toContain('Fixes the regression reported in issue 0');
    expect(content).not.toContain('表格仅保留前');
  });

  it('全为纯链接与空列的目录表仍被裁剪', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `| [section-${index}](https://example.com/docs/section-${index}) |  |  |`);
    const table = ['| Path |  |  |', '| --- | --- | --- |', ...rows].join('\n');
    const content = organizeDocuments(url, [{ engineId: 'main', result: page(`# Guide\n\n${table}`) }]).body.content;
    expect(content).toContain('（表格仅保留前 20 行，另有 20 行未显示）');
    expect(content).not.toContain('section-39');
  });

  it('真实 GitHub 文件清单形状（链接带 title 属性）仍被裁剪', () => {
    const rows = Array.from({ length: 30 }, (_, index) => {
      const name = index === 0 ? '.agents' : `folder-${index.toString().padStart(2, '0')}`;
      const link = `[${name}](https://github.com/deepseek-ai/deepseek-harness/tree/master/${name} "${name}")`;
      return `| ${link} |  | ${link} |  |  |`;
    });
    const table = ['| Name |  | Name | Last commit message | Last commit date |', '|---|---|---|---|---|', ...rows].join('\n');
    const content = organizeDocuments(url, [{ engineId: 'main', result: page(`# Guide\n\n## Folders and files\n\n${table}`) }]).body.content;
    // Long link rows hit the 4,000-character cap before the 20-row cap.
    expect(content).toMatch(/（表格仅保留前 \d+ 行，另有 \d+ 行未显示）/);
    expect(content).toContain('[.agents](https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents ".agents")');
    expect(content).not.toContain('folder-29');
  });
});
