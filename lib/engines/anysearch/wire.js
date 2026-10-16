import { MAX_CANONICAL_CONTENT_CHARS } from './limits.js';
/**
 * Join a base URL with an API path, preserving any base pathname. A base URL
 * that is not HTTP(S) — or not a URL at all — is unusable and yields
 * `undefined`, which the provider layer reports as `available() === false`.
 * Reference: `endpoint()` in src/client.ts.
 */
export function endpoint(baseURL, path) {
    let url;
    try {
        url = new URL(baseURL);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined;
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}${path}`;
    url.search = '';
    url.hash = '';
    return url.href;
}
/** Whether a string is an absolute `http:`/`https:` URL. */
export function isAbsoluteHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
/**
 * Validate one decoded response body as an AnySearch envelope. Throws
 * `TypeError` with the offending path when a field has the wrong shape; the
 * client turns that into a classified failure. `code !== 0` is *not* handled
 * here — the client needs the HTTP status and headers to classify it.
 */
export function readEnvelope(value) {
    const envelope = readRecord(value, 'response');
    const requestId = optionalStringField(envelope, 'request_id', 'request_id');
    const code = numberField(envelope, 'code', 'code');
    const message = optionalStringField(envelope, 'message', 'message');
    const errorCode = optionalStringField(envelope, 'error_code', 'error_code');
    return {
        code,
        message: message ?? '',
        ...(requestId === undefined ? {} : { requestId }),
        ...(errorCode === undefined ? {} : { errorCode }),
        data: envelope.data,
    };
}
/**
 * Validate the payload of a *successful* envelope. Only called once
 * `code === 0`, so a missing or non-object `data` here is a genuine contract
 * violation rather than an error envelope's `data: null`.
 */
export function envelopeData(envelope) {
    return {
        data: readRecord(envelope.data, 'data'),
        ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
    };
}
/**
 * Narrow one search response into validated results. URL-less entries are
 * retained here (with a count) and dropped at the seam mapping, matching the
 * reference split between `parseSearchData` and `mapAnySearchResponse`.
 * Aggregate `content` is bounded across all results in arrival order.
 */
export function parseSearchData(payload) {
    const parsedItems = arrayField(payload.data, 'results', 'data.results').map((value, index) => parseSearchResult(value, index));
    const results = parsedItems.flatMap((item) => (item.kind === 'invalid-url' ? [] : [item.result]));
    const urlLessResults = parsedItems.filter((item) => item.kind === 'url-less').length;
    const droppedInvalidUrlResults = parsedItems.filter((item) => item.kind === 'invalid-url').length;
    let remainingContentCharacters = MAX_CANONICAL_CONTENT_CHARS;
    const bounded = results.map((result) => {
        if (result.content === undefined)
            return result;
        const content = result.content.slice(0, remainingContentCharacters);
        remainingContentCharacters -= content.length;
        return { ...result, content };
    });
    const metadata = recordField(payload.data, 'metadata', 'data.metadata');
    return {
        ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
        results: bounded,
        metadata: {
            totalResults: nonNegativeIntegerField(metadata, 'total_results', 'data.metadata.total_results'),
            searchTimeMs: nonNegativeIntegerField(metadata, 'search_time_ms', 'data.metadata.search_time_ms'),
            ...(urlLessResults === 0 ? {} : { urlLessResults }),
            ...(droppedInvalidUrlResults === 0 ? {} : { droppedInvalidUrlResults }),
        },
    };
}
/**
 * Narrow one extract response. `url`, `title`, and `content` are all required
 * by the API contract, and `url` must be absolute HTTP(S).
 */
export function parseExtractData(payload) {
    const data = payload.data;
    const url = absoluteHttpUrlField(data, 'url', 'data.url');
    const title = stringField(data, 'title', 'data.title');
    const content = stringField(data, 'content', 'data.content');
    return {
        ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
        url,
        title,
        content,
    };
}
function parseSearchResult(value, index) {
    const path = `data.results[${index}]`;
    const result = readRecord(value, path);
    const url = stringField(result, 'url', `${path}.url`);
    if (url.length > 0 && !isAbsoluteHttpUrl(url))
        return { kind: 'invalid-url' };
    const title = stringField(result, 'title', `${path}.title`);
    const snippet = optionalStringRecordField(result, 'snippet', `${path}.snippet`);
    const content = optionalStringRecordField(result, 'content', `${path}.content`);
    const optionalFields = {
        ...(snippet === undefined ? {} : { snippet }),
        ...(content === undefined ? {} : { content }),
    };
    if (url.length === 0)
        return { kind: 'url-less', result: { title, ...optionalFields } };
    return { kind: 'citeable', result: { title, url, ...optionalFields } };
}
/**
 * Map validated search results into the seam shape. A seam source always has a
 * URL (see `WebSearchSource`'s doc comment), so structured URL-less results are
 * dropped here — exactly as `mapAnySearchResponse` filters them.
 * `truncated` is always `false`: `maxResults` is enforced by the seam, and this
 * engine never cuts the list itself.
 */
export function mapSearchResponse(response) {
    const sources = [];
    for (const result of response.results) {
        if (result.url === undefined)
            continue;
        const title = result.title.trim();
        const snippet = result.snippet?.trim();
        sources.push({
            url: result.url,
            ...(title.length === 0 ? {} : { title }),
            ...(snippet === undefined || snippet.length === 0 ? {} : { snippet }),
        });
    }
    return { sources, truncated: false };
}
/**
 * Map a validated extract response into the seam fetch shape. The Extract API
 * returns cleaned text (the reference labelled it `kind: 'text'` so the
 * harness does not convert it twice), a successful extract normalizes to
 * status 200, and this adapter does not truncate further.
 */
export function mapExtractResponse(response) {
    return {
        url: response.url,
        statusCode: 200,
        body: { kind: 'text', content: response.content },
        truncated: false,
    };
}
// ---------------------------------------------------------------------------
export function parseDomainsData(envelope) {
    const domains = arrayField(envelope.data, 'domains', 'data.domains')
        .map((value, index) => parseDomainSummary(value, index));
    return {
        ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId },
        domains,
    };
}
function parseDomainSummary(value, index) {
    const path = `data.domains[${index}]`;
    const domain = readRecord(value, path);
    return {
        domain: stringField(domain, 'domain', `${path}.domain`),
        description: stringField(domain, 'description', `${path}.description`),
        subDomainCount: nonNegativeIntegerField(domain, 'sub_domain_count', `${path}.sub_domain_count`),
    };
}
export function parseSubDomainsData(envelope) {
    const domains = arrayField(envelope.data, 'domains', 'data.domains')
        .map((value, index) => parseDomainCapability(value, index));
    return {
        ...envelope.requestId === undefined ? {} : { requestId: envelope.requestId },
        domains,
    };
}
function parseDomainCapability(value, index) {
    const path = `data.domains[${index}]`;
    const domain = readRecord(value, path);
    return {
        domain: stringField(domain, 'domain', `${path}.domain`),
        description: stringField(domain, 'description', `${path}.description`),
        subDomains: arrayField(domain, 'sub_domains', `${path}.sub_domains`)
            .map((item, subIndex) => parseSubDomain(item, `${path}.sub_domains[${subIndex}]`)),
    };
}
function parseSubDomain(value, path) {
    const subDomain = readRecord(value, path);
    const paramsValue = subDomain.params === undefined ? {} : readRecord(subDomain.params, `${path}.params`);
    const params = Object.create(null);
    for (const [name, rawInfo] of Object.entries(paramsValue)) {
        const infoPath = `${path}.params.${name}`;
        const info = readRecord(rawInfo, infoPath);
        const sortOrder = optionalNumberRecordField(info, 'sort_order', `${infoPath}.sort_order`);
        params[name] = {
            description: stringField(info, 'description', `${infoPath}.description`),
            required: booleanField(info, 'required', `${infoPath}.required`),
            ...sortOrder === undefined ? {} : { sortOrder },
        };
    }
    return {
        subDomain: stringField(subDomain, 'sub_domain', `${path}.sub_domain`),
        description: stringField(subDomain, 'description', `${path}.description`),
        params,
    };
}
function optionalNumberRecordField(value, key, path) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    if (typeof field !== 'number' || !Number.isInteger(field))
        throw new TypeError(`${path} must be an integer`);
    return field;
}
function booleanField(value, key, path) {
    const field = value[key];
    if (typeof field !== 'boolean')
        throw new TypeError(`${path} must be a boolean`);
    return field;
}
// Narrowing helpers. Each one throws a `TypeError` naming the JSON path, so a
// malformed upstream body reports *which* field was wrong.
// ---------------------------------------------------------------------------
/** A plain (non-null, non-array) object view, or a `TypeError`. */
export function readRecord(value, path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object`);
    }
    return value;
}
/** A required object field. */
function recordField(value, key, path) {
    return readRecord(value[key], path);
}
/** A required array field. */
function arrayField(value, key, path) {
    const field = value[key];
    if (!Array.isArray(field))
        throw new TypeError(`${path} must be an array`);
    return field;
}
/** A required string field. */
function stringField(value, key, path) {
    const field = value[key];
    if (typeof field !== 'string')
        throw new TypeError(`${path} must be a string`);
    return field;
}
/** A required absolute HTTP(S) URL field. */
function absoluteHttpUrlField(value, key, path) {
    const field = stringField(value, key, path);
    if (!isAbsoluteHttpUrl(field))
        throw new TypeError(`${path} must be an absolute HTTP(S) URL`);
    return field;
}
/** An optional string field; a present non-string is a `TypeError`. */
function optionalStringRecordField(value, key, path) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    if (typeof field !== 'string')
        throw new TypeError(`${path} must be a string`);
    return field;
}
/** A string field read off an unvalidated value; wrong types read as absent. */
function optionalStringField(value, key, path) {
    const field = value[key];
    if (field === undefined)
        return undefined;
    if (typeof field !== 'string')
        throw new TypeError(`${path} must be a string`);
    return field;
}
/** A required finite number field. */
function numberField(value, key, path) {
    const field = value[key];
    if (typeof field !== 'number' || !Number.isFinite(field))
        throw new TypeError(`${path} must be a number`);
    return field;
}
/** A required non-negative safe-integer field. */
function nonNegativeIntegerField(value, key, path) {
    const field = value[key];
    if (typeof field !== 'number')
        throw new TypeError(`${path} must be a number`);
    if (!Number.isSafeInteger(field) || field < 0) {
        throw new TypeError(`${path} must be a non-negative integer`);
    }
    return field;
}
