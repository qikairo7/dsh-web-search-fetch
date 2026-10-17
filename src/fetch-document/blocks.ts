import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

export interface ContentBlock {
  kind: 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'quote';
  text: string;
  key: string;
  index: number;
  level?: number;
}

/** HTML conversion uses the same converter family as DSH; it never executes scripts. */
export function markdown(content: string, kind: 'html' | 'text'): string {
  if (kind === 'text') return content.replace(/\r\n?/g, '\n');
  const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
  converter.use(gfm);
  converter.remove(['script', 'style', 'noscript', 'nav', 'select', 'button']);
  return converter.turndown(content);
}

/** Only ordinary paragraph whitespace is normalized for comparison, never for output. */
export function splitBlocks(content: string): ContentBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ContentBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.trim()) { i++; continue; }
    const start = i;
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const heading = /^(#{1,6})[ \t]+/.exec(line);
    let kind: ContentBlock['kind'] = 'paragraph';
    if (fence) {
      kind = 'code'; i++;
      const end = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      while (i < lines.length && !end.test(lines[i]!)) i++;
      if (i < lines.length) i++;
    } else if (/^(?: {4}|\t)/.test(line)) {
      kind = 'code'; i++;
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]!) || !lines[i]!.trim())) i++;
    } else if (heading) {
      kind = 'heading'; i++;
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      kind = 'table'; i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) i++;
    } else {
      kind = /^\s*[-+*]\s|^\s*\d+[.)]\s/.test(line) ? 'list' : /^\s*>/.test(line) ? 'quote' : 'paragraph';
      i++;
      while (i < lines.length && lines[i]!.trim() && !/^(?:#{1,6}\s| {0,3}`{3,}| {0,3}~{3,})/.test(lines[i]!)) i++;
    }
    const text = lines.slice(start, i).join('\n').trimEnd();
    const comparable = kind === 'heading'
      ? text.replace(/\s*\[(?:¶|#|\u200b)\]\([^\n]+\)\s*$/, '').replace(/¶\s*$/, '').trim()
      : kind === 'paragraph' ? text.replace(/(\*\*|__)([^\n]+?)\1/g, '$2').replace(/`([^`\n]+)`/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n/g, ' ').trim() : text;
    blocks.push({ kind, text, key: `${kind}:${comparable}`, index: blocks.length + 1, ...(heading ? { level: heading[1]!.length } : {}) });
  }
  return blocks;
}

/** Data rows one listing table may keep before it is trimmed as page furniture. */
export const LISTING_TABLE_MAX_ROWS = 20;

/** Characters one listing table may reach before its row list is trimmed. */
export const LISTING_TABLE_MAX_CHARS = 4_000;

/** A cell holding nothing but one Markdown link, including its optional title. */
function isPureLinkCell(cell: string): boolean {
  return /^\[[^\]]*\]\([^)]*\)$/.test(cell.trim());
}

/**
 * Whether a table is a directory/file listing rather than data.
 *
 * A listing row carries link text and blank cells only: the repository file
 * table repeats the same name in two columns and leaves the rest blank. Any
 * cell with prose, a number or a description means the row holds data, so the
 * table is left alone — a version history or an endpoint table pairs links with
 * prose and must survive intact. Empty cells are allowed, since they are the
 * listing shape itself.
 */
function listingTable(rows: readonly string[]): boolean {
  if (rows.length === 0) return false;
  const listing = rows.filter(row => {
    const cells = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    if (cells.length < 2) return false;
    const nonEmpty = cells.filter(cell => cell.length > 0);
    return nonEmpty.length > 0 && nonEmpty.every(isPureLinkCell);
  });
  return listing.length / rows.length >= 0.8;
}

/**
 * Trim an oversized listing table to its head, header row intact.
 *
 * File listings can be a fifth of a repository page and repeat the same names
 * once per row; the first screenful is all a reader needs. The trim is stated
 * in the output (the row count stays honest) instead of being silent, and
 * prose, code and data tables are untouched.
 * @param text - one table block, header line first.
 * @returns the table, optionally followed by a separate trimming note.
 */
export function compactTable(text: string): { text: string; omittedRows: number } {
  const lines = text.split('\n');
  // A Markdown table is a header line, a separator line, then data rows.
  if (lines.length <= LISTING_TABLE_MAX_ROWS + 2) return { text, omittedRows: 0 };
  const header = lines.slice(0, 2);
  const rows = lines.slice(2);
  if (!listingTable(rows)) return { text, omittedRows: 0 };
  const kept: string[] = [];
  let chars = header.join('\n').length;
  for (const row of rows) {
    if (kept.length >= LISTING_TABLE_MAX_ROWS || chars + row.length > LISTING_TABLE_MAX_CHARS) break;
    kept.push(row);
    chars += row.length + 1;
  }
  if (kept.length === rows.length) return { text, omittedRows: 0 };
  const omittedRows = rows.length - kept.length;
  const note = `（表格仅保留前 ${kept.length} 行，另有 ${omittedRows} 行未显示）`;
  return { text: `${[...header, ...kept].join('\n')}\n\n${note}`, omittedRows };
}

/** Remove explicit page furniture, never prose, code, tables or ordinary link lists. */
export function cleanBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  let navigation = false;
  const firstTitle = blocks.findIndex(block => block.kind === 'heading' && block.level === 1);
  return blocks.filter((block, index) => {
    if (block.kind === 'code' || block.kind === 'table' || block.kind === 'quote') return true;
    const label = block.text.replace(/^#{1,6}\s+/, '').trim();
    if (block.kind === 'heading') {
      const next = blocks[index + 1];
      const beforeTitle = firstTitle >= 0 && index < firstTitle;
      navigation = /^(?:navigation|site navigation|on this page|table of contents|quick search|导航|本页目录|目录)$/i.test(label)
        && (beforeTitle || block.level !== 1 && next?.kind === 'list' && /\[[^\]]+\]\(/.test(next.text));
      return !navigation;
    }
    const prefix = firstTitle >= 0 && index < firstTitle;
    const linksOnly = block.kind === 'list' && block.text.split('\n').filter(line => line.trim()).every(line => /^\s*[-*+]\s+(?:!?\[[^\]]*\]\([^\n]+\)|[\\|»\s])+\s*$/.test(line)
      || /^\s*[-*+]\s+.*(?:English.*(?:Spanish|French)|Deutsch.*Ελληνικά)/.test(line));
    const controls = block.kind === 'list' && /\[(?:index|modules)\]/i.test(block.text) && /\[(?:next|previous)\]/i.test(block.text);
    if ((navigation || prefix) && (controls || /^\s*[-*+]\s+Theme\b[\s\S]*Auto\s*Light\s*Dark/i.test(block.text))) return false;
    if ((navigation || prefix && /\[(?:index|modules|next|previous|home)\]/i.test(block.text)) && linksOnly) return false;
    if ((navigation || prefix) && /^(?:theme\s*(?:auto\s*light\s*dark|auto|light|dark)(?:\s*\|)?|dev\s*\([\d.]+\)[\d.\s()]+|(?:skip to|跳转到)\s*(?:main )?(?:content|正文))$/i.test(label)) return false;
    if (navigation && block.kind === 'paragraph') navigation = false;
    return true;
  });
}

export function challengeBlocks(blocks: readonly ContentBlock[]): boolean {
  return /^(?:#{1,6}\s*)?(?:403 Forbidden|Access Denied|Login required|Just a moment[.!…]*|Attention Required!?\s*\|\s*Cloudflare|请先登录|请输入验证码)\s*$/i.test(blocks[0]?.text ?? '');
}

/** Total characters of the ordinary paragraphs: the body a reader would get. */
export function paragraphChars(blocks: readonly ContentBlock[]): number {
  return blocks
    .filter(block => block.kind === 'paragraph')
    .map(block => block.text.replace(/\s+/g, ' ').trim())
    .join(' ').length;
}

export function structured(content: string): boolean {
  try { const value: unknown = JSON.parse(content); return value !== null && typeof value === 'object'; } catch { /* ordinary prose */ }
  return /^\s*(?:<\?xml\b|<(?:rss|feed|svg)\b)/i.test(content);
}
