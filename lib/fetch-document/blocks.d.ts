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
/** Data rows one listing table may keep before it is trimmed as page furniture. */
export declare const LISTING_TABLE_MAX_ROWS = 20;
/** Characters one listing table may reach before its row list is trimmed. */
export declare const LISTING_TABLE_MAX_CHARS = 4000;
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
export declare function compactTable(text: string): {
    text: string;
    omittedRows: number;
};
/** Remove explicit page furniture, never prose, code, tables or ordinary link lists. */
export declare function cleanBlocks(blocks: readonly ContentBlock[]): ContentBlock[];
export declare function challengeBlocks(blocks: readonly ContentBlock[]): boolean;
/** Total characters of the ordinary paragraphs: the body a reader would get. */
export declare function paragraphChars(blocks: readonly ContentBlock[]): number;
export declare function structured(content: string): boolean;
