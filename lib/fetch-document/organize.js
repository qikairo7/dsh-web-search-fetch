import { WebError } from '@deepseek-ai/dsh-web';
import { markdown, splitBlocks, cleanBlocks, challengeBlocks, structured } from './blocks.js';
function titleBlock(blocks) {
    return blocks.find(block => block.kind === 'heading');
}
function normalizeHeading(text) {
    return text.toLowerCase().replace(/^heading:/, '').replace(/[#*]/g, '').replace(/[\s\u00b7/-]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}
function sameHeading(a, b) {
    if (!a || !b)
        return true;
    const left = new Set(normalizeHeading(a).split(' '));
    const right = new Set(normalizeHeading(b).split(' '));
    const shared = [...left].filter(word => right.has(word)).length;
    return shared >= Math.ceil(Math.min(left.size, right.size) * 0.8);
}
function sections(blocks, id) {
    const result = [{ key: '', nodes: [] }];
    const stack = [];
    const occurrences = new Map();
    for (const block of blocks) {
        if (block.kind === 'heading') {
            stack.length = block.level - 1;
            stack.push(normalizeHeading(block.key));
            const path = stack.join('/');
            const occurrence = (occurrences.get(path) ?? 0) + 1;
            occurrences.set(path, occurrence);
            result.push({ key: `${path}@${occurrence}`, nodes: [] });
        }
        result.at(-1).nodes.push({ block, refs: [`${id}:B${block.index}`] });
    }
    return result;
}
function target(raw) {
    try {
        const value = new URL(raw);
        value.hash = '';
        return value.href;
    }
    catch {
        return raw;
    }
}
function language(blocks) {
    const text = blocks.filter(block => block.kind === 'paragraph').map(block => block.text).join('');
    const cjk = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    const latin = text.match(/[a-z]/ig)?.length ?? 0;
    return cjk > 20 && cjk > latin ? 'cjk' : latin > 40 && latin > cjk * 2 ? 'latin' : '';
}
function version(doc) {
    return doc.blocks.filter(block => block.kind === 'paragraph')
        .flatMap(block => block.text.match(/^(?:version|版本|文档版本)\s*[:：]\s*[^\n]+/gim) ?? [])
        .join('\n').toLowerCase() || undefined;
}
/** Keep reference links and footnotes within one document's Markdown scope. */
function originalMarkdown(doc) {
    let fenceLength = 3;
    for (const match of doc.content.matchAll(/`+/g))
        fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = '`'.repeat(fenceLength);
    const text = `${fence}markdown\n${doc.content}\n${fence}`;
    return { block: { kind: 'code', text, key: `code:${text}`, index: 1 }, refs: doc.blocks.map(block => `${doc.id}:B${block.index}`) };
}
/** Aligned number/negation variants are retained, never adjudicated or averaged. */
function variantKey(block) {
    if (!['paragraph', 'table', 'list', 'quote'].includes(block.kind))
        return undefined;
    return block.key.replace(/\d+(?:[.,]\d+)*/g, '{number}').replace(/\bnot\s+|不|未|禁止/g, '');
}
/** Cross-service dedup preserves repeated occurrences within each original document. */
function mergeSection(destination, incoming, differences) {
    const queues = new Map();
    for (const node of destination.nodes) {
        const queue = queues.get(node.block.key) ?? [];
        queue.push(node);
        queues.set(node.block.key, queue);
    }
    const matches = new Map();
    for (const node of incoming.nodes) {
        const match = queues.get(node.block.key)?.shift();
        if (match)
            matches.set(node, match);
    }
    const anchorPositions = incoming.nodes.flatMap(node => matches.has(node) ? [destination.nodes.indexOf(matches.get(node))] : []);
    const reversed = anchorPositions.some((position, i) => i > 0 && position < anchorPositions[i - 1]);
    if (reversed) {
        differences.push({ section: `${destination.key}（段落顺序不同）`, variants: incoming.nodes });
        return;
    }
    for (const [node, match] of matches)
        match.refs.push(...node.refs);
    let previous;
    for (let i = 0; i < incoming.nodes.length; i++) {
        const node = incoming.nodes[i];
        const matched = matches.get(node);
        if (matched) {
            previous = matched;
            continue;
        }
        const next = incoming.nodes.slice(i + 1).map(item => matches.get(item)).find(Boolean);
        const start = previous ? destination.nodes.indexOf(previous) + 1 : 0;
        const end = next ? destination.nodes.indexOf(next) : destination.nodes.length;
        const key = variantKey(node.block);
        const variants = key ? destination.nodes.slice(start, end).filter(item => item.block.key !== node.block.key && variantKey(item.block) === key) : [];
        const existing = differences.find(item => variants.length > 0 && variants.every(variant => item.variants.includes(variant)));
        if (variants.length === 1 || existing) {
            const old = variants[0];
            old.removed = true;
            let difference = existing ?? differences.find(item => item.variants.includes(old));
            if (!difference) {
                difference = { section: destination.key, variants: [old] };
                differences.push(difference);
            }
            difference.variants.push(node);
            destination.nodes.splice(end, 0, node);
            node.removed = true;
        }
        else {
            destination.nodes.splice(end, 0, node);
            previous = node;
        }
    }
}
/** Deterministic union of a single page's extracts; this never calls a language model. */
export function organizeDocuments(url, candidates, maxChars = 100_000, notes = []) {
    if (!candidates.length)
        throw new WebError('no extraction candidates', 'WEB_PROVIDER_ERROR');
    // Bound synchronous conversion and alignment work independently of output size.
    if (candidates.some(candidate => candidate.result.body.content.length > 1_000_000))
        throw new WebError('extraction input too large', 'WEB_FETCH_TOO_LARGE');
    const raw = candidates.find(candidate => candidate.result.statusCode >= 200 && candidate.result.statusCode < 300 && target(candidate.result.url) === target(url) && structured(candidate.result.body.content));
    if (raw) {
        if (raw.result.body.content.length > maxChars)
            throw new WebError('structured response too large', 'WEB_FETCH_TOO_LARGE');
        return raw.result;
    }
    let removedNoise = 0;
    const documents = candidates.map((candidate, index) => {
        const original = splitBlocks(markdown(candidate.result.body.content, candidate.result.body.kind));
        if (original.length > 2000)
            throw new WebError('too many extraction blocks', 'WEB_FETCH_TOO_LARGE');
        const blocks = cleanBlocks(original);
        removedNoise += original.length - blocks.length;
        const content = blocks.map(block => block.text).join('\n\n');
        return { candidate, id: `F${index + 1}`, blocks, sections: sections(blocks, `F${index + 1}`), content };
    });
    const challenge = (doc) => challengeBlocks(doc.blocks);
    const successful = documents.filter(doc => target(doc.candidate.result.url) === target(url) && doc.candidate.result.statusCode >= 200 && doc.candidate.result.statusCode < 300 && !challenge(doc));
    const firstHeading = successful[0] && titleBlock(successful[0].blocks)?.key;
    const firstVersion = successful[0] && version(successful[0]);
    const compatible = successful.filter(doc => (!firstHeading || !doc.blocks.some(block => block.kind === 'heading') || sameHeading(firstHeading, titleBlock(doc.blocks)?.key))
        && (!firstVersion || !version(doc) || version(doc) === firstVersion));
    const errors = documents.filter(doc => target(doc.candidate.result.url) === target(url) && !challenge(doc) && (doc.candidate.result.statusCode < 200 || doc.candidate.result.statusCode >= 300));
    const usable = compatible.length ? compatible : errors;
    if (!usable.length) {
        throw new WebError('没有可整理的目标网页正文：返回目标不同或属于登录、挑战页面', 'WEB_PROVIDER_ERROR');
    }
    const reference = [...usable].sort((a, b) => b.sections.length - a.sections.length || b.blocks.length - a.blocks.length)[0];
    const referenceDefinitions = documents.some(doc => !challenge(doc) && doc.blocks.some(block => block.kind !== 'code' && /^ {0,3}\[[^\]\n]+\]:/m.test(block.text)));
    const main = referenceDefinitions ? [{ key: '', nodes: [originalMarkdown(reference)] }] : reference.sections;
    const additions = [];
    const supplementalSections = new Map();
    const differences = [];
    const heading = titleBlock(reference.blocks)?.key;
    const referenceLanguage = language(reference.blocks);
    const referenceVersion = version(reference);
    const referenceKeys = new Set(reference.blocks.map(block => block.key));
    for (const doc of documents) {
        if (doc === reference)
            continue;
        const otherHeading = titleBlock(doc.blocks)?.key;
        const otherLanguage = language(doc.blocks);
        const shared = doc.blocks.some(block => referenceKeys.has(block.key));
        const reason = challenge(doc) ? '登录或挑战页面，未加入主正文'
            : doc.candidate.result.statusCode < 200 || doc.candidate.result.statusCode >= 300 ? '非成功状态，未加入主正文'
                : target(doc.candidate.result.url) !== target(url) ? '返回页面目标不同，未加入主正文'
                    : heading && otherHeading && !sameHeading(heading, otherHeading) ? '标题或版本不同，未加入主正文'
                        : referenceVersion && version(doc) && version(doc) !== referenceVersion ? '版本标记不同，未加入主正文'
                            : referenceLanguage && otherLanguage && referenceLanguage !== otherLanguage ? '语言不同，未加入主正文'
                                : !shared ? '缺少共同段落锚点，保留独立片段' : '';
        if (referenceDefinitions) {
            const node = originalMarkdown(doc);
            if (!reason && node.block.key === main[0].nodes[0].block.key)
                main[0].nodes[0].refs.push(...node.refs);
            else
                additions.push({ doc, reason: reason || '引用定义按来源隔离，保留完整原始 Markdown', nodes: challenge(doc) ? [] : [node] });
            continue;
        }
        if (reason) {
            additions.push({ doc, reason, nodes: challenge(doc) ? [] : doc.sections.flatMap(section => section.nodes) });
            continue;
        }
        for (const section of doc.sections) {
            const found = main.find(item => item.key === section.key);
            if (found)
                mergeSection(found, section, differences);
            else {
                const supplementary = supplementalSections.get(section.key);
                if (supplementary)
                    mergeSection(supplementary, section, differences);
                else {
                    supplementalSections.set(section.key, section);
                    additions.push({ doc, reason: '独有章节，保留原有顺序', nodes: section.nodes });
                }
            }
        }
    }
    const chunks = [];
    // Different extractors can disagree about section levels. Merge substantial
    // identical blocks across those sections, while retaining every occurrence
    // that appears more than once within any one original extraction.
    const seenBlocks = new Map();
    for (const node of [...main.flatMap(section => section.nodes), ...additions.flatMap(addition => addition.nodes)]) {
        if (node.removed || node.block.kind === 'heading' || node.block.text.length < 32)
            continue;
        const previous = seenBlocks.get(node.block.key) ?? [];
        const origins = new Set(node.refs.map(ref => ref.split(':')[0]));
        const match = previous.find(item => item.refs.every(ref => !origins.has(ref.split(':')[0])));
        if (match) {
            match.refs.push(...node.refs);
            node.removed = true;
        }
        else {
            previous.push(node);
            seenBlocks.set(node.block.key, previous);
        }
    }
    let length = 0;
    let omitted = 0;
    const footer = '\n\n## 提取来源与处理说明\n\n' + documents.map(doc => `${doc.id}: ${doc.candidate.engineId}; 状态 ${doc.candidate.result.statusCode}; ${doc.candidate.result.truncated ? '上游已截断' : '上游未标记截断'}; 接收时间：${doc.candidate.receivedAt ?? '未提供'}; 返回 URL：${JSON.stringify(doc.candidate.result.url)}`).join('\n\n')
        + '\n\n来源标记 F#:B# 对应提取服务及原始内容块；多份提取不是独立事实佐证。'
        + (removedNoise ? `\n\n已移除 ${removedNoise} 个明确的导航或页面控件内容块。` : '')
        + (referenceDefinitions ? '\n\n检测到引用定义：按来源分别展示原始 Markdown，避免链接或脚注串用。' : '')
        + (notes.length ? `\n\n${notes.join('\n')}` : '');
    const room = Math.max(0, maxChars - footer.length - 100);
    const append = (text, count = 1) => {
        if (length + text.length + 2 > room) {
            omitted += count;
            return false;
        }
        chunks.push(text);
        length += text.length + 2;
        return true;
    };
    const render = (node) => `${node.block.text}\n\n提取来源：${node.refs.join(', ')}`;
    for (const section of main)
        for (const node of section.nodes)
            if (!node.removed)
                append(render(node));
    if (additions.length) {
        const incompatible = additions.filter(addition => addition.nodes.length > 0
            && /^(标题或版本不同|语言不同)/.test(addition.reason));
        const incompatibleBlocks = incompatible.reduce((count, addition) => count + addition.nodes.length, 0);
        const summarize = incompatible.length > 1 || incompatibleBlocks > 20;
        const grouped = summarize ? additions.filter(addition => !incompatible.includes(addition)) : additions;
        if (summarize) {
            grouped.push({
                doc: incompatible[0].doc,
                reason: `${incompatible.length} 路提取因标题、版本或语言不同，未加入主正文；仅保留摘要以避免重复正文噪声`,
                summaryOnly: true,
                nodes: incompatible.map(addition => ({
                    block: { ...addition.nodes[0].block, text: `${addition.doc.id}: ${addition.doc.candidate.engineId}，${addition.nodes.length} 个内容块` },
                    refs: addition.nodes[0].refs,
                })),
            });
        }
        if (append('## 补充片段')) {
            for (const addition of grouped) {
                const label = `${addition.doc.id}：${addition.reason}`;
                if (!addition.nodes.length)
                    append(label);
                if (addition.summaryOnly)
                    append(`${label}\n\n${addition.nodes.map(node => node.block.text).join('\n')}`);
                else
                    for (const node of addition.nodes)
                        if (!node.removed)
                            append(`${label}\n\n${render(node)}`);
            }
        }
        else
            omitted += additions.reduce((count, addition) => count + addition.nodes.length, 0);
    }
    if (differences.length) {
        if (append('## 文本差异')) {
            for (const difference of differences)
                append(`位置：${difference.section.replace(/heading:/g, '')}；保留原文变体，未判断哪份正确。\n\n${difference.variants.map(render).join('\n\n')}`, difference.variants.length);
        }
        else
            omitted += differences.reduce((count, difference) => count + difference.variants.length, 0);
    }
    const content = chunks.join('\n\n') + footer + (omitted ? `\n\n输出预算不足，已省略 ${omitted} 个完整内容块或说明。` : '');
    if (content.length > maxChars)
        throw new WebError('正文输出预算不足以容纳来源说明', 'WEB_FETCH_TOO_LARGE');
    return { url, statusCode: reference.candidate.result.statusCode, body: { kind: 'text', content }, truncated: omitted > 0 || documents.some(doc => !challenge(doc) && doc.candidate.result.truncated) };
}
