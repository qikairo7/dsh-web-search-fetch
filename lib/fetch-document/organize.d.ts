import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { FetchCandidate } from '../fetch-aggregate.js';
/** Deterministic union of a single page's extracts; this never calls a language model. */
export declare function organizeDocuments(url: string, candidates: readonly FetchCandidate[], maxChars?: number, notes?: readonly string[]): WebFetchResult;
