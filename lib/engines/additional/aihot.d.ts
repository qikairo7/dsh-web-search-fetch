import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import { EngineHttp } from './http.js';
/** Preserve structured reports and sync operations, including nulls, attribution and opaque cursors. */
export declare function readAihotApi(rawUrl: string, http: EngineHttp, signal?: AbortSignal): Promise<WebFetchResult | undefined>;
