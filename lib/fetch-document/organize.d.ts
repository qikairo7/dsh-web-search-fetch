import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { FetchCandidate } from '../fetch-aggregate.js';
/** Total characters the supplemental sections may add to one organized document. */
export declare const SUPPLEMENT_TOTAL_BUDGET_CHARS = 4000;
/**
 * Default page budget of one organized document, in characters.
 *
 * The budget belongs to the page, not to the transport: an organized result is
 * what the caller reads in place of the page, so the default bounds it to one
 * long article. Raising `controls.maxOutputChars` raises it per deployment.
 */
export declare const DEFAULT_MAX_OUTPUT_CHARS = 15000;
/** Characters one supplemental entry may add; longer entries are cut here. */
export declare const SUPPLEMENT_ENTRY_BUDGET_CHARS = 1200;
/** Reference body below this many paragraph characters is reported as thin. */
export declare const THIN_BODY_PARAGRAPH_CHARS = 200;
/** Reference body at or above this many paragraph characters is already substantial. */
export declare const SUBSTANTIAL_BODY_PARAGRAPH_CHARS = 1200;
/** Deterministic union of a single page's extracts; this never calls a language model. */
export declare function organizeDocuments(url: string, candidates: readonly FetchCandidate[], maxChars?: number, notes?: readonly string[]): WebFetchResult;
