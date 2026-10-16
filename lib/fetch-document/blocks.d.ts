export interface ContentBlock {
    kind: 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'quote';
    text: string;
    key: string;
    index: number;
    level?: number;
}
/** HTML conversion uses the same converter family as DSH; it never executes scripts. */
export declare function markdown(content: string, kind: 'html' | 'text'): string;
/** Only ordinary paragraph whitespace is normalized for comparison, never for output. */
export declare function splitBlocks(content: string): ContentBlock[];
/** Remove explicit page furniture, never prose, code, tables or ordinary link lists. */
export declare function cleanBlocks(blocks: readonly ContentBlock[]): ContentBlock[];
export declare function challengeBlocks(blocks: readonly ContentBlock[]): boolean;
export declare function structured(content: string): boolean;
