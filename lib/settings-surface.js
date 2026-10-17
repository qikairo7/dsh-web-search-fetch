/**
 * Settings namespace of this plugin's configuration surface.
 *
 * The settings domain addresses a plugin's namespace by its Loader entry id,
 * so this equals the id `cordis.patch.yml` inserts. It is spelled here rather
 * than imported because the browser half must not depend on a Host package.
 */
export const WEB_SEARCH_FETCH_SETTINGS_NAMESPACE = 'web-search-fetch';
/** Fields served by native settings: transport, credential references and the extension map.
 * The map is volatile as a whole so path mutations can preserve custom endpoints and refs.
 */
export const EDITABLE_SETTINGS_PATHS = [
    ['controls'],
    ['search', 'rerank'],
    ['engines'],
    ['fetch', 'anysearchApiKeyEnv'],
    ['search', 'anysearchApiKeyEnv'],
    ['search', 'siliconflowApiKeyEnv'],
    ['search', 'decisionModel'],
    ['fetch', 'firecrawlApiKeyEnv'],
];
/**
 * Whether `path` is one of this plugin's declared editable settings paths.
 * @param path - config path addressed by a settings edit.
 * @returns whether the path is declared editable.
 */
export function isEditableSettingsPath(path) {
    return EDITABLE_SETTINGS_PATHS.some((candidate) => (candidate.length === path.length || ['engines', 'controls'].includes(candidate[0]) && path[0] === candidate[0]) && candidate.every((segment, index) => segment === path[index]));
}
/** All credential inputs from the complete integration list, in service order. */
export const CREDENTIAL_SLOTS = [
    { "id": "anysearch", "overridePaths": [["search", "anysearchApiKeyEnv"]], "defaultRef": "ANYSEARCH_API_KEY", "additionalPaths": [["fetch", "anysearchApiKeyEnv"]] },
    { "id": "deepseek", "overridePaths": [["engines", "deepseek", "apiKeyEnv"]], "defaultRef": "DEEPSEEK_API_KEY" },
    { "id": "firecrawl", "overridePaths": [["fetch", "firecrawlApiKeyEnv"]], "defaultRef": "FIRECRAWL_API_KEY", "additionalPaths": [["engines", "firecrawl", "apiKeyEnv"]] },
    { "id": "tavily", "overridePaths": [["engines", "tavily", "apiKeyEnv"]], "defaultRef": "TAVILY_API_KEY" },
    { "id": "exa", "overridePaths": [["engines", "exa", "apiKeyEnv"]], "defaultRef": "EXA_API_KEY" },
    { "id": "keenable", "overridePaths": [["engines", "keenable", "apiKeyEnv"]], "defaultRef": "KEENABLE_API_KEY" },
    { "id": "crawl4ai", "overridePaths": [["engines", "crawl4ai", "apiKeyEnv"]], "defaultRef": "CRAWL4AI_API_KEY" },
    { "id": "github", "overridePaths": [["engines", "github", "apiKeyEnv"]], "defaultRef": "GITHUB_TOKEN" },
    { "id": "tinyfish", "overridePaths": [["engines", "tinyfish", "apiKeyEnv"]], "defaultRef": "TINYFISH_API_KEY" },
    { "id": "serply", "overridePaths": [["engines", "serply", "apiKeyEnv"]], "defaultRef": "SERPLY_API_KEY" },
    { "id": "kimi", "overridePaths": [["engines", "kimi", "apiKeyEnv"]], "defaultRef": "MOONSHOT_API_KEY" },
    { "id": "siliconflow", "overridePaths": [["search", "siliconflowApiKeyEnv"]], "defaultRef": "SILICONFLOW_API_KEY" },
    { "id": "dashscope", "overridePaths": [], "defaultRef": "DASHSCOPE_API_KEY" },
    { "id": "typesafe", "overridePaths": [], "defaultRef": "TYPESAFE_API_KEY" }
];
/**
 * Resolve every slot to the reference its chain currently names.
 *
 * This is the same chain the host's own search-face reads follow, so a card
 * built from these refs describes and writes the credentials the engines
 * actually use.
 * @param config - the parsed plugin configuration.
 * @returns one effective reference per slot, in {@link CREDENTIAL_SLOTS} order.
 */
export function resolveCredentialRefs(config) {
    return CREDENTIAL_SLOTS.map((slot) => {
        const ref = resolveSlotRef(config, slot);
        const refs = [...new Set([ref, ...(slot.additionalPaths ?? []).flatMap(path => {
                    const value = readVolatile(readConfigPath(config, path));
                    return typeof value === 'string' && value.length ? [value] : [];
                })])];
        return { id: slot.id, ref, ...(refs.length > 1 ? { refs } : {}) };
    });
}
/**
 * Resolve one slot by id, for the host's own reads.
 * @param config - the parsed plugin configuration.
 * @param id - slot to resolve.
 * @returns the effective reference name.
 */
export function resolveCredentialRef(config, id) {
    const slot = CREDENTIAL_SLOTS.find((candidate) => candidate.id === id);
    /* v8 ignore next -- the id is a closed union, so a missing slot is unrepresentable. */
    if (slot === undefined)
        throw new Error(`unknown credential slot "${id}"`);
    return resolveSlotRef(config, slot);
}
/** Resolve one slot: first non-empty override, else the declared default. */
function resolveSlotRef(config, slot) {
    for (const path of slot.overridePaths) {
        const named = readVolatile(readConfigPath(config, path));
        if (typeof named === 'string' && named.length > 0)
            return named;
    }
    return slot.defaultRef;
}
/** Read one config path, or `undefined` when any segment is absent. */
function readConfigPath(config, path) {
    let node = config;
    for (const segment of path) {
        node = readVolatile(node);
        if (typeof node !== 'object' || node === null)
            return undefined;
        node = node[segment];
    }
    return node;
}
/**
 * Project credential facts into the booleans-only rows the card renders.
 *
 * The input view has no slot a value could ride in, and the output is built
 * field by field rather than spread, so an unexpected extra field on a
 * provider's view cannot reach the browser through this path.
 * @param slots - effective references, as {@link resolveCredentialRefs} returns.
 * @param described - per-reference facts, keyed by reference name.
 * @returns one status row per slot, in the order given.
 */
export function projectCredentialStatus(slots, described) {
    return slots.map((slot) => {
        const views = (slot.refs ?? [slot.ref]).map(ref => described[ref]);
        return {
            id: slot.id,
            ref: slot.ref,
            configured: views.every(info => info?.configured === true),
            writable: views.every(info => info?.writable !== false),
        };
    });
}
/**
 * Read a configuration field the settings page can edit.
 *
 * A field the page edits is declared `.volatile()`, so its parsed value is a
 * live reference rather than a copy; reading through it is what makes a saved
 * edit reach the next operation without a restart. A plain value is returned
 * as-is so a caller holding a hand-built config still works.
 * @param value - the parsed field, volatile or plain.
 * @returns the current value, or `undefined` while unset.
 */
export function readVolatile(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
