import type { FusedCandidate } from './search-aggregate.js';
/** Explicit technical-document intent maps to project-owned documentation hosts. */
export declare function officialHosts(query: string): string[];
export declare function isOfficial(url: string, hosts: readonly string[]): boolean;
/** The query's usable terms, in query order (English words and CJK runs). */
export declare function queryTerms(query: string): string[];
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
export declare function termMatches(term: string, text: string): boolean;
/** The terms that carry the topic, i.e. with recency qualifiers removed. */
export declare function topicTerms(terms: readonly string[]): string[];
/** Topic matching prevents an unrelated official API page from winning by hostname alone. */
export declare function topicMatches(query: string, candidate: FusedCandidate): boolean;
export declare function preferOfficial(query: string, candidates: readonly FusedCandidate[]): FusedCandidate[];
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
export declare function contentVariantKey(url: string, title?: string): string;
