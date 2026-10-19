import type { FusedCandidate } from './search-aggregate.js';

/** Explicit technical-document intent maps to project-owned documentation hosts. */
export function officialHosts(query: string): string[] {
  const explicit = [...query.matchAll(/\bsite:([a-z0-9.-]+)(?:\/[^\s]*)?/gi)].map(match => match[1]!.toLowerCase());
  if (explicit.length) return explicit;
  if (!/官方|文档|规范|official|documentation|\bdocs?\b|specification/i.test(query)) return [];
  const projects: [RegExp, string][] = [
    [/\bpython\b|\basyncio\b/i, 'docs.python.org'],
    [/\btypescript\b/i, 'www.typescriptlang.org'],
    [/\bnode(?:\.js|js)\b/i, 'nodejs.org'],
    [/\bjavascript\b|\bpromise\.(?:all|race|any|allSettled)\b/i, 'developer.mozilla.org'],
    [/\breact\b/i, 'react.dev'], [/\brust\b/i, 'doc.rust-lang.org'],
    [/\bgolang\b|\bgo language\b/i, 'go.dev'],
  ];
  return projects.filter(([pattern]) => pattern.test(query)).map(([, host]) => host).slice(0, 2);
}

export function isOfficial(url: string, hosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return hosts.some(expected => host === expected.replace(/^www\./, ''));
  } catch { return false; }
}

/** Words that carry no topic on their own; excluded from every term test. */
const GENERIC_TERMS: ReadonlySet<string> = new Set([
  'official', 'documentation', 'document', 'docs', 'site', 'https', 'http', 'www', 'org', 'com', 'the', 'and', 'for', 'with', 'versus',
]);

/**
 * Recency qualifiers: whole terms that only say *when*, carrying no topic.
 *
 * A Chinese query routinely leads with one (`最近的 AI 芯片新闻`), and a real
 * candidate pool writes that idea as a date or as `最新` rather than repeating
 * the query's wording. Keeping such a term in the hard filter therefore tests
 * punctuation, not relevance.
 */
const RECENCY_TERMS: readonly RegExp[] = [
  /^(?:最近|最新|近期|近日|目前|当前|今天|今日|今年|明年|去年|本周|上周|本月|上月|实时|即时|现在)(?:的)?$/,
];

/** The query's usable terms, in query order (English words and CJK runs). */
export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z][a-z0-9_+-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  return terms.filter(term => !GENERIC_TERMS.has(term));
}

/**
 * Whether one query term matches a candidate's text.
 *
 * English terms are words and must appear as written. A Chinese run is not a
 * word: `芯片新闻` is `芯片` + `新闻`, and pages write it as `芯片…新闻`,
 * `AI芯片最新资讯`. Requiring the literal whole run made every such pool look
 * unrelated (P1-4). Runs of three or more characters therefore also match when
 * at least two thirds of their characters appear — enough to keep a real
 * subject (`芯片`, `新闻`) and still reject a page that merely shares one
 * character. Two-character runs stay literal: they are usually one word.
 * @param term - one usable query term, already lower-cased.
 * @param text - the candidate's lower-cased title, snippet and URL.
 */
export function termMatches(term: string, text: string): boolean {
  if (text.includes(term)) return true;
  const characters = [...new Set([...term].filter(character => /[\u3400-\u9fff]/.test(character)))];
  if (characters.length < 3) return false;
  return characters.filter(character => text.includes(character)).length * 3 >= characters.length * 2;
}

/** The terms that carry the topic, i.e. with recency qualifiers removed. */
export function topicTerms(terms: readonly string[]): string[] {
  return terms.filter(term => !RECENCY_TERMS.some(pattern => pattern.test(term)));
}

/** Topic matching prevents an unrelated official API page from winning by hostname alone. */
export function topicMatches(query: string, candidate: FusedCandidate): boolean {
  const identifiers = query.match(/\b[a-z_]\w*(?:\.\w+)+\b/gi)?.filter(term => !/^(?:node\.js|docs?\.|www\.)/i.test(term)) ?? [];
  const text = `${candidate.title ?? ''} ${candidate.snippet ?? ''} ${candidate.url}`.toLowerCase();
  if (identifiers.length) {
    const subject = `${candidate.title ?? ''} ${candidate.url}`.toLowerCase().replace(/[/.()]+/g, ' ');
    return identifiers.some(term => new RegExp(`\\b${term.toLowerCase().replace(/\./g, ' ')}\\b`).test(subject));
  }
  const topics = topicTerms(queryTerms(query));
  return !topics.length || topics.filter(term => termMatches(term, text)).length >= Math.min(2, topics.length);
}

export function preferOfficial(query: string, candidates: readonly FusedCandidate[]): FusedCandidate[] {
  const hosts = officialHosts(query);
  if (!hosts.length) return [...candidates];
  const priority = (candidate: FusedCandidate) => {
    if (!isOfficial(candidate.url, hosts) || !topicMatches(query, candidate)) return 0;
    const path = new URL(candidate.url).pathname;
    if (path === '/' && !/官网|网站|website|homepage/i.test(query)) return 0;
    const chinese = /[\u3400-\u9fff]/.test(query);
    const foreign = /^\/(?:es|fr|de|id|ja|ko|pt-br|ru)(?:\/|$)/i.test(path);
    if (chinese && /^\/(?:zh-CN|zh-cn|zh|zh-TW)(?:\/|$)/i.test(path)) return 3;
    return foreign ? 1 : 2;
  };
  return [...candidates].sort((a, b) => priority(b) - priority(a));
}

/**
 * The title as the deduplication evidence: lower-cased, whitespace collapsed,
 * and with a trailing site suffix (`… | 逐水寻源`) dropped.
 *
 * Engines append their own site names, so the same page arrives as
 * `向量数据库比较报告… | 数荣量标-SynDataWorks` from one lane and without the
 * suffix from another. Comparing the raw strings made those two copies look
 * like different pages (P2-4).
 */
function variantTitle(title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const [head] = normalized.split(/\s*[|｜]\s*/);
  return (head ?? normalized).replace(/[\s\-–—_]+$/, '').trim();
}

/**
 * The deduplication key for one source.
 *
 * Slash variants of one path are merged on **title** evidence: the page name
 * is what says both entries are the same article, and lanes legitimately
 * return different excerpts of it — requiring the snippets to match kept real
 * duplicates apart while their excerpts differed in length (P2-4). Different
 * non-root paths stay distinct because the URL is part of the key, and two
 * pages whose titles differ stay distinct even when only the trailing slash
 * separates their URLs.
 */
export function contentVariantKey(url: string, title?: string): string {
  const key = title === undefined ? '' : variantTitle(title);
  if (key.length === 0) return url;
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return `${parsed.href}\n${key}`;
  } catch { return url; }
}
