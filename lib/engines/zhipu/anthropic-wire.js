import { ZHIPU_ANTHROPIC_BASE_URL, ZHIPU_ANTHROPIC_DEFAULT_MODEL, ZHIPU_ANTHROPIC_MAX_TOKENS, ZHIPU_ANTHROPIC_MAX_USES, ZHIPU_ANTHROPIC_MESSAGES_PATH, ZHIPU_DEFAULT_SEARCH_TRANSPORT, } from '../../limits.js';
import { readNonEmptyString, readRecord } from './wire.js';
// ---------------------------------------------------------------------------
// Channel selection and endpoint building
// ---------------------------------------------------------------------------
/**
 * Narrow a runtime value to a supported search transport; anything else falls
 * back to the default (`anthropic`, the Coding Plan route). Config strings are
 * untrusted, so an unknown spelling must never reach the wire.
 */
export function resolveZhipuSearchTransport(value) {
    return value === 'anthropic' || value === 'tools-api' ? value : ZHIPU_DEFAULT_SEARCH_TRANSPORT;
}
/** Narrow a runtime value to a usable Messages base URL; blank/non-string → the public default. */
export function resolveZhipuAnthropicBaseURL(value) {
    return readNonEmptyString(value) ?? ZHIPU_ANTHROPIC_BASE_URL;
}
/**
 * Build the Messages endpoint from a base URL: trailing slashes are dropped so
 * `…/v1` and `…/v1/` both yield `…/v1/messages` (a doubled slash would some
 * gateways 404 on).
 */
export function buildZhipuAnthropicEndpoint(baseURL) {
    return `${baseURL.replace(/\/+$/u, '')}${ZHIPU_ANTHROPIC_MESSAGES_PATH}`;
}
/** Narrow a runtime value to a usable model name; blank/non-string → `glm-4.6`. */
export function resolveZhipuAnthropicModel(value) {
    return readNonEmptyString(value) ?? ZHIPU_ANTHROPIC_DEFAULT_MODEL;
}
/**
 * Narrow a runtime value to a positive integer, or `undefined` for anything
 * else (fractional values are floored, zero and negatives rejected).
 */
function resolvePositiveInteger(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    const floored = Math.floor(value);
    return floored < 1 ? fallback : floored;
}
/** Narrow a runtime `maxUses` to a positive integer; anything else → 1. */
export function resolveZhipuAnthropicMaxUses(value) {
    return resolvePositiveInteger(value, ZHIPU_ANTHROPIC_MAX_USES);
}
/** Narrow a runtime `maxTokens` to a positive integer; anything else → 1024. */
export function resolveZhipuAnthropicMaxTokens(value) {
    return resolvePositiveInteger(value, ZHIPU_ANTHROPIC_MAX_TOKENS);
}
/**
 * Build the Messages request: one user message carrying the query verbatim,
 * one `web_search_20250305` server tool with a bounded `max_uses`, and — by
 * default — `stream: true` for the early-close path (issue #14).
 *
 * The tools API's 70-character query cap deliberately does not apply here —
 * the Messages route owns its own query handling, and truncating would change
 * what the model is asked to search for.
 */
export function buildZhipuAnthropicRequest(query, params = {}) {
    return {
        model: resolveZhipuAnthropicModel(params.model),
        max_tokens: resolveZhipuAnthropicMaxTokens(params.maxTokens),
        tools: [
            {
                type: 'web_search_20250305',
                name: 'web_search',
                max_uses: resolveZhipuAnthropicMaxUses(params.maxUses),
            },
        ],
        messages: [{ role: 'user', content: query }],
        // Omitted (not `false`) for the fallback: an unknown boolean field is a
        // needless way to have a gateway reject the request.
        ...(params.stream === false ? {} : { stream: true }),
    };
}
// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------
/**
 * The two block types that carry search results, in the order
 * {@link mapZhipuAnthropicResponse} consumes them: standard Anthropic
 * `web_search_tool_result`, then Zhipu's non-standard `tool_result`.
 *
 * Single source of truth on purpose: the streaming early-close layer
 * (`./anthropic-stream.js`) must recognize exactly the blocks this mapping
 * layer consumes. If it closed on a block the mapper ignores, the seam would
 * return an empty source list while the real results were still on the wire.
 */
export const ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES = ['web_search_tool_result', 'tool_result'];
/** Standard Anthropic result block type (structured `web_search_result` items). */
export const ZHIPU_ANTHROPIC_STANDARD_RESULT_BLOCK_TYPE = ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES[0];
/** Zhipu's non-standard result block type (a Python-`repr` string payload). */
export const ZHIPU_ANTHROPIC_ZHIPU_RESULT_BLOCK_TYPE = ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES[1];
/** Is this block type one that carries search results? */
export function isZhipuAnthropicResultBlockType(value) {
    return (typeof value === 'string' &&
        ZHIPU_ANTHROPIC_RESULT_BLOCK_TYPES.includes(value));
}
/**
 * Read one quoted (single- or double-quoted) string that starts at `index`
 * (the opening quote), decoding the backslash escapes Python's `repr` emits.
 * An unterminated literal yields the rest of the text.
 */
function readQuotedString(text, index) {
    const quote = text[index];
    let out = '';
    let cursor = index + 1;
    while (cursor < text.length) {
        const char = text[cursor];
        if (char === '\\') {
            const escaped = text[cursor + 1];
            if (escaped === 'n')
                out += '\n';
            else if (escaped === 't')
                out += '\t';
            else if (escaped === 'r')
                out += '\r';
            else if (escaped !== undefined)
                out += escaped;
            cursor += 2;
            continue;
        }
        if (char === quote)
            return [out, cursor + 1];
        out += char;
        cursor += 1;
    }
    return [out, cursor];
}
/** Keys carrying a value this mapping layer consumes, in repr literal text. */
const REPR_KEY_PATTERN = /['"]?(title|link|url|content|snippet|page_age|date)['"]?\s*:/gu;
/**
 * Scan a Python-`repr`-style literal for
 * `{'title': …, 'link': …, 'content': …}` records, tolerating `text` array
 * wrappers and either quote style. A record is flushed when a `title`/`url`
 * key arrives after the current one already carries its URL, which is what
 * separates adjacent records in the nested wrapper layout.
 */
function scanReprItems(text) {
    const items = [];
    let current = null;
    const flush = () => {
        if (current?.url !== undefined) {
            items.push({
                url: current.url,
                ...(current.title === undefined ? {} : { title: current.title }),
                ...(current.snippet === undefined ? {} : { snippet: current.snippet }),
                ...(current.publishedAt === undefined ? {} : { publishedAt: current.publishedAt }),
            });
        }
        current = null;
    };
    REPR_KEY_PATTERN.lastIndex = 0;
    let match;
    while ((match = REPR_KEY_PATTERN.exec(text)) !== null) {
        const key = match[1];
        let cursor = REPR_KEY_PATTERN.lastIndex;
        while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t'))
            cursor += 1;
        const quote = text[cursor];
        if (quote !== "'" && quote !== '"')
            continue;
        const [value, next] = readQuotedString(text, cursor);
        // Skip past the decoded literal so nested quotes cannot re-enter the scan.
        REPR_KEY_PATTERN.lastIndex = next;
        if ((key === 'title' || key === 'url') && current?.url !== undefined)
            flush();
        current ??= {};
        if (key === 'link' || key === 'url')
            current.url ??= value;
        else if (key === 'title')
            current.title ??= value;
        else if (key === 'content' || key === 'snippet')
            current.snippet ??= value;
        else if (key === 'page_age' || key === 'date')
            current.publishedAt ??= value;
    }
    flush();
    return items;
}
/** Join a structured `content` array's text parts into one snippet. */
function joinTextParts(parts) {
    if (!Array.isArray(parts))
        return undefined;
    const texts = parts
        .map((part) => readNonEmptyString(readRecord(part)?.text))
        .filter((text) => text !== undefined);
    return texts.length === 0 ? undefined : texts.join('\n');
}
/**
 * Read the URL of a structured entry: `url` first, then Zhipu's `link`.
 * Non-string and blank values are dropped, never coerced.
 */
function readEntryUrl(record) {
    return readNonEmptyString(record.url) ?? readNonEmptyString(record.link);
}
/**
 * Walk any JSON-ish value collecting result entries: any object carrying a
 * non-empty string `url` or `link` becomes an item. `content`/`text` payloads
 * are joined for the snippet; recursion handles Zhipu's `{'text': [items]}`
 * wrappers and standard `web_search_result` items alike. A found entry is not
 * descended into (its own `text` array is snippet material, not child items).
 */
function collectStructuredItems(value, out = []) {
    if (Array.isArray(value)) {
        for (const entry of value)
            collectStructuredItems(entry, out);
        return out;
    }
    const record = readRecord(value);
    if (record === undefined)
        return out;
    const url = readNonEmptyString(readEntryUrl(record) ?? record.url);
    if (url !== undefined) {
        const snippet = readNonEmptyString(record.content) ??
            readNonEmptyString(record.snippet) ??
            joinTextParts(record.content) ??
            readNonEmptyString(record.text);
        const title = readNonEmptyString(record.title);
        const publishedAt = readNonEmptyString(record.page_age) ?? readNonEmptyString(record.date);
        out.push({
            url,
            ...(title === undefined ? {} : { title }),
            ...(snippet === undefined ? {} : { snippet }),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
        return out;
    }
    for (const entry of Object.values(record))
        collectStructuredItems(entry, out);
    return out;
}
/**
 * Extract raw items from one result block's `content` field. A string is
 * JSON-parsed first (a JSON-encoded array is a legitimate spelling), then
 * repr-scanned; arrays and objects go straight to the structured walker.
 */
export function parseZhipuAnthropicBlockItems(content) {
    if (typeof content === 'string') {
        const text = content.trim();
        if (text.length === 0)
            return [];
        try {
            return collectStructuredItems(JSON.parse(text));
        }
        catch {
            return scanReprItems(text);
        }
    }
    if (content !== null && typeof content === 'object')
        return collectStructuredItems(content);
    return [];
}
/**
 * Build the `url → cited_text` map from standard `text` blocks' `citations[]`:
 * the standard layout carries the snippet there rather than on the result item.
 * First occurrence wins.
 */
export function collectZhipuAnthropicCitationSnippets(blocks) {
    const snippets = new Map();
    for (const block of blocks) {
        if (block.type !== 'text' || !Array.isArray(block.citations))
            continue;
        for (const raw of block.citations) {
            const citation = readRecord(raw);
            if (citation === undefined)
                continue;
            const url = readNonEmptyString(citation.url);
            const cited = readNonEmptyString(citation.cited_text);
            if (url === undefined || cited === undefined || snippets.has(url))
                continue;
            snippets.set(url, cited);
        }
    }
    return snippets;
}
/**
 * Map a Messages response — standard Anthropic block layout first, then
 * Zhipu's non-standard `tool_result` layout — into seam sources. URLs are
 * deduped (first occurrence wins), entries without a URL are dropped, and
 * `truncated` is always `false`: the seam owns the `maxResults` bound.
 */
export function mapZhipuAnthropicResponse(payload) {
    const blocks = Array.isArray(payload.content)
        ? payload.content
            .map((block) => readRecord(block))
            .filter((block) => block !== undefined)
        : [];
    const citations = collectZhipuAnthropicCitationSnippets(blocks);
    const items = [];
    for (const block of blocks) {
        if (block.type !== ZHIPU_ANTHROPIC_STANDARD_RESULT_BLOCK_TYPE)
            continue;
        for (const item of collectStructuredItems(block.content)) {
            items.push({
                ...item,
                ...(item.snippet === undefined && citations.has(item.url)
                    ? { snippet: citations.get(item.url) }
                    : {}),
            });
        }
    }
    for (const block of blocks) {
        if (block.type !== ZHIPU_ANTHROPIC_ZHIPU_RESULT_BLOCK_TYPE)
            continue;
        items.push(...parseZhipuAnthropicBlockItems(block.content));
    }
    const seen = new Set();
    const sources = [];
    for (const item of items) {
        const url = readNonEmptyString(item.url);
        if (url === undefined || seen.has(url))
            continue;
        seen.add(url);
        sources.push({
            url,
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
            ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
        });
    }
    return { sources, truncated: false };
}
