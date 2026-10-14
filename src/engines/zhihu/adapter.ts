/**
 * The Zhihu engine as the search pipeline consumes it: a seam-shaped `search`
 * plus the `quota` call the breaker reads. This is the composition point of the
 * engine (client + wire mapping) and the only thing DESIGN.md's per-engine
 * adapter contract needs from a search-only engine — Zhihu has no extraction
 * role (DESIGN.md), so there is no `fetch`.
 *
 * It deliberately does not declare or register a DSH provider: the aggregated
 * provider on `ctx.web` is the pipeline's single face (DESIGN.md), so this class
 * stays a plain engine handle and imports nothing from the seam registries.
 * @module engines/zhihu/adapter
 */
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import { ZhihuClient, type ZhihuClientOptions } from './client.js';
import type { ZhihuQuota } from './types.js';
import { mapZhihuSearchResponse } from './wire.js';

export class ZhihuEngine {
  constructor(private readonly client: ZhihuClient) {}

  /** Today's quota for `global_search`; `undefined` when unreadable. */
  async quota(signal?: AbortSignal): Promise<ZhihuQuota | undefined> {
    return await this.client.quota(signal);
  }

  /**
   * Run one search and map it to seam sources. A failure that already carries a
   * seam code is rethrown untouched (so a breaker still sees its
   * `ZhihuCircuitSignal`); anything else is wrapped as a provider error, the
   * same way the Zhipu engine's provider boundary does it.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    try {
      const payload = await this.client.search(request.query, request.maxResults, signal);
      return mapZhihuSearchResponse(payload);
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError(
        error instanceof Error ? error.message : `Zhihu web search failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      );
    }
  }
}

/** Build the engine from the same options the client takes. */
export function createZhihuEngine(options: ZhihuClientOptions): ZhihuEngine {
  return new ZhihuEngine(new ZhihuClient(options));
}
