/** Absorbed from anysearch-dsh v0.1.8 (d20ab97), MIT.
 * Copyright (c) 2026 AnySearch Team.
 */
export type { AnySearchResult, AnySearchMetadata, AnySearchSearchRequest, AnySearchSearchResponse, } from './wire.js';
export type AnySearchParamValue = string | number | boolean;
export interface AnySearchDomainSummary {
    domain: string;
    description: string;
    subDomainCount: number;
}
export interface AnySearchDomainsResponse {
    requestId?: string;
    domains: AnySearchDomainSummary[];
}
export interface AnySearchParamInfo {
    description: string;
    required: boolean;
    sortOrder?: number;
}
export interface AnySearchSubDomain {
    subDomain: string;
    description: string;
    params: Record<string, AnySearchParamInfo>;
}
export interface AnySearchDomainCapability {
    domain: string;
    description: string;
    subDomains: AnySearchSubDomain[];
}
export interface AnySearchSubDomainsResponse {
    requestId?: string;
    domains: AnySearchDomainCapability[];
}
