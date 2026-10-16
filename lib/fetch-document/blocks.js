import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';
/** HTML conversion uses the same converter family as DSH; it never executes scripts. */
export function markdown(content, kind) {
    if (kind === 'text')
        return content.replace(/\r\n?/g, '\n');
    const converter = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', preformattedCode: true });
    converter.use(gfm);
    converter.remove(['script', 'style', 'noscript']);
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
        const comparable = kind === 'paragraph' ? text.replace(/[ \t]+/g, ' ').replace(/\n/g, ' ').trim() : text;
        blocks.push({ kind, text, key: `${kind}:${comparable}`, index: blocks.length + 1, ...(heading ? { level: heading[1].length } : {}) });
    }
    return blocks;
}
export function structured(content) {
    try {
        const value = JSON.parse(content);
        return value !== null && typeof value === 'object';
    }
    catch { /* ordinary prose */ }
    return /^\s*(?:<\?xml\b|<(?:rss|feed|svg)\b)/i.test(content);
}
