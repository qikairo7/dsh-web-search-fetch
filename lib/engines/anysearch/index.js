/**
 * The AnySearch engine module's public surface. The aggregation pipelines
 * (#8 search, #9 extract) import from here rather than reaching into
 * individual files.
 *
 * Deliberately not re-exported from `src/index.ts`: registering this engine is
 * #8/#9's work, and wiring it into the plugin entry point here would collide
 * with the other engine branches.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97, MIT.
 * Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch
 */
export { AnySearchClient } from './client.js';
export { AnySearchEngine, failureSignalOf, toWebError } from './engine.js';
export { AnySearchClientError, anySearchFailureSignal, classifyAnySearchFailure, mapExtractErrorCodeToWebErrorCode, parseRetryAfterMs, } from './error.js';
export { endpoint, envelopeData, isAbsoluteHttpUrl, mapExtractResponse, mapSearchResponse, parseExtractData, parseSearchData, readEnvelope, } from './wire.js';
export { ANYSEARCH_DEFAULT_BASE_URL, ANYSEARCH_DEFAULT_CREDENTIAL_NAME, ANYSEARCH_EXTRACT_PATH, ANYSEARCH_SEARCH_PATH, ANYSEARCH_TIMEOUT_MS, } from './limits.js';
