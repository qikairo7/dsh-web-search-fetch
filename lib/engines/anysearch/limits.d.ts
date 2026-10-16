/**
 * Cooperative constants for the AnySearch engine module.
 *
 * Kept inside `engines/anysearch/` rather than the shared `src/limits.ts`, so
 * landing this engine cannot collide with the other engine branches. Options
 * that callers may override are the exported `*Options` interfaces; these are
 * the defaults those interfaces fall back to.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97 (src/limits.ts),
 * MIT. Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch/limits
 */
/** Public AnySearch API origin (reference: `ANYSEARCH_DEFAULT_BASE_URL`). */
export declare const ANYSEARCH_DEFAULT_BASE_URL = "https://api.anysearch.com";
/** API path for the search operation. */
export declare const ANYSEARCH_SEARCH_PATH = "/v1/search";
/** API path for the extract operation. */
export declare const ANYSEARCH_EXTRACT_PATH = "/v1/extract";
export declare const ANYSEARCH_DOMAINS_PATH = "/v1/domains";
export declare const ANYSEARCH_SUB_DOMAINS_PATH = "/v1/sub-domains";
/** Default credential reference name (DESIGN.md); the value is never read from config. */
export declare const ANYSEARCH_DEFAULT_CREDENTIAL_NAME = "ANYSEARCH_API_KEY";
/**
 * Single-path transport deadline. DESIGN.md caps every extract engine at 45 s;
 * the reference client used 55 s under a 60 s tool budget. Callers that need
 * the tighter DESIGN.md search budget (10 s) pass `timeoutMs` explicitly.
 */
export declare const ANYSEARCH_TIMEOUT_MS = 45000;
/**
 * Values that mean "the credential reference name was pasted as the value".
 * Sending one would burn a request to learn nothing, so the client refuses.
 * Reference: `API_KEY_PLACEHOLDERS` in src/client.ts.
 */
export declare const ANYSEARCH_API_KEY_PLACEHOLDERS: readonly string[];
/**
 * Aggregate cap on cleaned page content retained across one search response
 * (reference: `MAX_CANONICAL_CONTENT_CHARS`). The seam mapping uses only
 * `title`/`snippet`, so this bounds memory rather than the returned payload.
 */
export declare const MAX_CANONICAL_CONTENT_CHARS = 200000;
/** Maximum upstream-controlled error text retained in one failure message. */
export declare const MAX_UPSTREAM_ERROR_CHARS = 2000;
/** Client identifier sent to AnySearch for attribution and abuse triage. */
export declare const ANYSEARCH_CLIENT_ID = "dsh-web-search-fetch";
