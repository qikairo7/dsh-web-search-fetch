import type { FusedCandidate } from './search-aggregate.js';
/** Explicit technical-document intent maps to project-owned documentation hosts. */
export declare function officialHosts(query: string): string[];
export declare function isOfficial(url: string, hosts: readonly string[]): boolean;
/** Topic matching prevents an unrelated official API page from winning by hostname alone. */
export declare function topicMatches(query: string, candidate: FusedCandidate): boolean;
export declare function preferOfficial(query: string, candidates: readonly FusedCandidate[]): FusedCandidate[];
/** Only merge slash variants when title and substantive snippet are identical. */
export declare function contentVariantKey(url: string, title?: string, snippet?: string): string;
