/**
 * Cooperative constants shared by the providers. Skeleton scope (#1): one
 * search engine (Zhipu) and one fetch pass-through (built-in HTTP).
 * @module limits
 */
/** Stable id this plugin registers on both seam registries (search and fetch). */
export declare const AGGREGATED_PROVIDER_ID = "aggregated";
/** Default credential reference for the Zhipu engine (the config default). */
export declare const ZHIPU_DEFAULT_API_KEY_ENV = "ZHIPU_API_KEY";
/** Zhipu web_search endpoint (the `tools-api` search transport). */
export declare const ZHIPU_WEB_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
/**
 * Zhipu's Anthropic-compatible Messages base URL (the `anthropic` search
 * transport, issue #12): the client POSTs to `{base}/messages`. This route is
 * billed to the GLM Coding Plan quota rather than the per-call tools API.
 */
export declare const ZHIPU_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic/v1";
/** Default search transport: the Anthropic-compatible Messages API. */
export declare const ZHIPU_DEFAULT_SEARCH_TRANSPORT = "anthropic";
/** Default GLM model for the Anthropic Messages route. */
export declare const ZHIPU_ANTHROPIC_DEFAULT_MODEL = "glm-4.6";
/**
 * Path appended to {@link ZHIPU_ANTHROPIC_BASE_URL}: the Messages endpoint is
 * `POST {base}/messages` (the base already carries its `/v1`).
 */
export declare const ZHIPU_ANTHROPIC_MESSAGES_PATH = "/messages";
/** `anthropic-version` header value required by the Messages API. */
export declare const ZHIPU_ANTHROPIC_API_VERSION = "2023-06-01";
/** Generated-token bound; streaming stops at the first complete result block. */
export declare const ZHIPU_ANTHROPIC_MAX_TOKENS = 1024;
/**
 * Default `tools[].max_uses`: the aggregated seam wants one search pass, not a
 * research conversation — multiple rounds multiply latency and spend without
 * improving the source list.
 */
export declare const ZHIPU_ANTHROPIC_MAX_USES = 1;
/** Default search_engine tier (DESIGN.md / issue #3: defaults to `search_pro`). */
export declare const ZHIPU_DEFAULT_SEARCH_ENGINE = "search_pro";
/** Default snippet granularity (`content_size`). */
export declare const ZHIPU_DEFAULT_CONTENT_SIZE = "medium";
/**
 * Zhipu-specific error codes relevant to this engine (docs.bigmodel.cn):
 * concurrency cap, no available engine, engine returned no valid data.
 * These are classified (not guessed): each maps to `WEB_PROVIDER_ERROR`
 * with the upstream code/message preserved in the failure message.
 */
export declare const ZHIPU_ERR_CONCURRENCY_LIMIT = "1701";
export declare const ZHIPU_ERR_NO_AVAILABLE_ENGINE = "1702";
export declare const ZHIPU_ERR_ENGINE_NO_DATA = "1703";
/** Zhipu's `search_query` accepts at most 70 characters; longer queries are truncated. */
export declare const ZHIPU_SEARCH_QUERY_MAX_CHARS = 70;
/** Zhipu `count` bounds (documented 1–50, API default 10). */
export declare const ZHIPU_COUNT_MIN = 1;
export declare const ZHIPU_COUNT_MAX = 50;
/** Single-engine search deadline (DESIGN.md: per-engine limit of 10 s). */
export declare const ZHIPU_SEARCH_TIMEOUT_MS = 10000;
/** Maximum upstream-controlled error text retained in one failure message. */
export declare const MAX_UPSTREAM_ERROR_CHARS = 2000;
