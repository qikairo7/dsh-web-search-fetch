import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
/** HTML conversion uses the same converter family as DSH; it never executes scripts. */
export function markdown(content, kind) {
    if (kind === 'text')
        return content.replace(/\r\n?/g, '\n');
    const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
    converter.use(gfm);
    converter.remove(['script', 'style', 'noscript', 'nav', 'select', 'button']);
    return converter.turndown(content);
}
/** Only ordinary paragraph whitespace is normalized for comparison, never for output. */
export function splitBlocks(content) {
    const lines = content.replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].trim()) {
            i++;
            continue;
        }
        const start = i;
        const line = lines[i];
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        const heading = /^(#{1,6})[ \t]+/.exec(line);
        let kind = 'paragraph';
        if (fence) {
            kind = 'code';
            i++;
            const end = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            while (i < lines.length && !end.test(lines[i]))
                i++;
            if (i < lines.length)
                i++;
        }
        else if (/^(?: {4}|\t)/.test(line)) {
            kind = 'code';
            i++;
            while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim()))
                i++;
        }
        else if (heading) {
            kind = 'heading';
            i++;
        }
        else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
            kind = 'table';
            i += 2;
            while (i < lines.length && lines[i].trim() && lines[i].includes('|'))
                i++;
        }
        else {
            kind = /^\s*[-+*]\s|^\s*\d+[.)]\s/.test(line) ? 'list' : /^\s*>/.test(line) ? 'quote' : 'paragraph';
            i++;
            while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s| {0,3}`{3,}| {0,3}~{3,})/.test(lines[i]))
                i++;
        }
        const text = lines.slice(start, i).join('\n').trimEnd();
        const comparable = kind === 'heading'
            ? text.replace(/\s*\[(?:¶|#|\u200b)\]\([^\n]+\)\s*$/, '').replace(/¶\s*$/, '').trim()
            : kind === 'paragraph' ? text.replace(/(\*\*|__)([^\n]+?)\1/g, '$2').replace(/`([^`\n]+)`/g, '$1').replace(/[ \t]+/g, ' ').replace(/\n/g, ' ').trim() : text;
        blocks.push({ kind, text, key: `${kind}:${comparable}`, index: blocks.length + 1, ...(heading ? { level: heading[1].length } : {}) });
    }
    return blocks;
}
/** Remove explicit page furniture, never prose, code, tables or ordinary link lists. */
export function cleanBlocks(blocks) {
    let navigation = false;
    const firstTitle = blocks.findIndex(block => block.kind === 'heading' && block.level === 1);
    return blocks.filter((block, index) => {
        if (block.kind === 'code' || block.kind === 'table' || block.kind === 'quote')
            return true;
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
        if ((navigation || prefix) && (controls || /^\s*[-*+]\s+Theme\b[\s\S]*Auto\s*Light\s*Dark/i.test(block.text)))
            return false;
        if ((navigation || prefix && /\[(?:index|modules|next|previous|home)\]/i.test(block.text)) && linksOnly)
            return false;
        if ((navigation || prefix) && /^(?:theme\s*(?:auto\s*light\s*dark|auto|light|dark)(?:\s*\|)?|dev\s*\([\d.]+\)[\d.\s()]+|(?:skip to|跳转到)\s*(?:main )?(?:content|正文))$/i.test(label))
            return false;
        if (navigation && block.kind === 'paragraph')
            navigation = false;
        return true;
    });
}
export function challengeBlocks(blocks) {
    return /^(?:#{1,6}\s*)?(?:403 Forbidden|Access Denied|Login required|Just a moment[.!…]*|Attention Required!?\s*\|\s*Cloudflare|请先登录|请输入验证码)\s*$/i.test(blocks[0]?.text ?? '');
}
export function structured(content) {
    try {
        const value = JSON.parse(content);
        return value !== null && typeof value === 'object';
    }
    catch { /* ordinary prose */ }
    return /^\s*(?:<\?xml\b|<(?:rss|feed|svg)\b)/i.test(content);
}
