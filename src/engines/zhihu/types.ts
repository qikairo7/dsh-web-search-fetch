/**
 * Wire-level types for the Zhihu OpenAPI. Response fields are deliberately
 * `unknown`: the mapping layer narrows them at runtime, so an upstream that
 * lies cannot smuggle a non-string into the seam.
 * @module engines/zhihu/types
 */

/** Query parameters of one `global_search` call (`Filter`/`SearchDB` are out of scope, DESIGN.md). */
export interface ZhihuSearchRequest {
  /** Query text, sent verbatim (the API documents no length cap). */
  readonly Query: string;
  /** Result count, aligned to the seam's `maxResults` (1–20). */
  readonly Count?: number;
}

/** One `Data.Items[]` entry as delivered; only the mapped fields are read. */
export interface ZhihuSearchItem {
  readonly Title?: unknown;
  readonly ContentType?: unknown;
  readonly ContentID?: unknown;
  readonly ContentText?: unknown;
  readonly Url?: unknown;
  readonly CommentCount?: unknown;
  readonly VoteUpCount?: unknown;
  readonly AuthorName?: unknown;
  readonly EditTime?: unknown;
  readonly AuthorityLevel?: unknown;
  readonly CommentInfoList?: unknown;
}

/** `Data` of a `global_search` response. */
export interface ZhihuSearchData {
  readonly HasMore?: unknown;
  readonly Items?: unknown;
}

/** `global_search` response envelope. `Code !== 0` is a business error. */
export interface ZhihuSearchResponse {
  readonly Code?: unknown;
  readonly Message?: unknown;
  readonly Data?: unknown;
}

/** One `Data[]` entry of the quota response. */
export interface ZhihuQuotaEntry {
  readonly APIID?: unknown;
  readonly APIName?: unknown;
  readonly TotalQuota?: unknown;
  readonly TotalUsed?: unknown;
  readonly RemainingQuota?: unknown;
}

/** Quota response envelope. */
export interface ZhihuQuotaResponse {
  readonly Code?: unknown;
  readonly Message?: unknown;
  readonly Data?: unknown;
}

/**
 * Daily quota for one `APIID`, as consumed by the search pipeline's breaker: a
 * non-positive `remaining` means the engine is exhausted for the rest of the
 * day. All three values are int64 upstream and may arrive as numbers or as
 * decimal strings.
 */
export interface ZhihuQuota {
  readonly total: number;
  readonly used: number;
  readonly remaining: number;
}
