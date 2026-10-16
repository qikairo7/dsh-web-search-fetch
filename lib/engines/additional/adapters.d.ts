import { EngineHttp } from './http.js';
import type { AdditionalEngine, AdditionalEngineId, AdditionalEngineConfig } from './index.js';
export declare function adapt(id: AdditionalEngineId, search: EngineHttp, fetch: EngineHttp, settings?: AdditionalEngineConfig): AdditionalEngine;
export declare function githubPath(rawUrl: string): {
    path: string;
    query?: URLSearchParams;
} | undefined;
