/** Explicit technical-document intent maps to project-owned documentation hosts. */
export function officialHosts(query) {
    const explicit = [...query.matchAll(/\bsite:([a-z0-9.-]+)(?:\/[^\s]*)?/gi)].map(match => match[1].toLowerCase());
    if (explicit.length)
        return explicit;
    if (!/官方|文档|规范|official|documentation|\bdocs?\b|specification/i.test(query))
        return [];
    const projects = [
        [/\bpython\b|\basyncio\b/i, 'docs.python.org'],
        [/\btypescript\b/i, 'www.typescriptlang.org'],
        [/\bnode(?:\.js|js)\b/i, 'nodejs.org'],
        [/\bjavascript\b|\bpromise\.(?:all|race|any|allSettled)\b/i, 'developer.mozilla.org'],
        [/\breact\b/i, 'react.dev'], [/\brust\b/i, 'doc.rust-lang.org'],
        [/\bgolang\b|\bgo language\b/i, 'go.dev'],
    ];
    return projects.filter(([pattern]) => pattern.test(query)).map(([, host]) => host).slice(0, 2);
}
export function isOfficial(url, hosts) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return hosts.some(expected => host === expected.replace(/^www\./, ''));
    }
    catch {
        return false;
    }
}
/** Topic matching prevents an unrelated official API page from winning by hostname alone. */
export function topicMatches(query, candidate) {
    const identifiers = query.match(/\b[a-z_]\w*(?:\.\w+)+\b/gi)?.filter(term => !/^(?:node\.js|docs?\.|www\.)/i.test(term)) ?? [];
    const text = `${candidate.title ?? ''} ${candidate.snippet ?? ''} ${candidate.url}`.toLowerCase();
    if (identifiers.length) {
        const subject = `${candidate.title ?? ''} ${candidate.url}`.toLowerCase().replace(/[/.()]+/g, ' ');
        return identifiers.some(term => new RegExp(`\\b${term.toLowerCase().replace(/\./g, ' ')}\\b`).test(subject));
    }
    const terms = query.toLowerCase().match(/[a-z][a-z0-9_+-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
    const useful = terms.filter(term => !['official', 'documentation', 'document', 'docs', 'site', 'https', 'http', 'www', 'org', 'com', 'the', 'and', 'for', 'with', 'versus'].includes(term));
    return !useful.length || useful.filter(term => text.includes(term)).length >= Math.min(2, useful.length);
}
export function preferOfficial(query, candidates) {
    const hosts = officialHosts(query);
    if (!hosts.length)
        return [...candidates];
    const priority = (candidate) => {
        if (!isOfficial(candidate.url, hosts) || !topicMatches(query, candidate))
            return 0;
        const path = new URL(candidate.url).pathname;
        if (path === '/' && !/官网|网站|website|homepage/i.test(query))
            return 0;
        const chinese = /[\u3400-\u9fff]/.test(query);
        const foreign = /^\/(?:es|fr|de|id|ja|ko|pt-br|ru)(?:\/|$)/i.test(path);
        if (chinese && /^\/(?:zh-CN|zh-cn|zh|zh-TW)(?:\/|$)/i.test(path))
            return 3;
        return foreign ? 1 : 2;
    };
    return [...candidates].sort((a, b) => priority(b) - priority(a));
}
/** Only merge slash variants when title and substantive snippet are identical. */
export function contentVariantKey(url, title, snippet) {
    if (!title || !snippet || snippet.trim().length < 80)
        return url;
    try {
        const parsed = new URL(url);
        parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
        return `${parsed.href}\n${title.trim().toLowerCase().replace(/\s+/g, ' ')}\n${snippet.trim().replace(/\s+/g, ' ')}`;
    }
    catch {
        return url;
    }
}
