/**
 * Settings-surface facts of this plugin: which fields the settings domain may
 * serve, and which credential reference each engine key slot addresses.
 *
 * The settings domain addresses a plugin by its Loader entry id and serves the
 * fields a Config schema declares `.volatile()`. Nothing has to be registered
 * for that — the exported schema *is* the declaration. What the schema cannot
 * state is the rest of the surface, and that is what this module owns: the
 * namespace id, the editable paths, and the credential-reference fallback
 * chains the browser settings card mirrors.
 *
 * Credential values never appear here. A slot names a *reference*; a status row
 * carries booleans only, so no path through this module can carry a secret.
 * @module settings-surface
 */
import type { AdditionalEnginesConfig } from './engines/additional/index.js';
import type { Volatile } from '@deepseek-ai/cordis';
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials';

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
] as const;

/** One editable config path. */
export type EditableSettingsPath = (typeof EDITABLE_SETTINGS_PATHS)[number];

/**
 * Whether `path` is one of this plugin's declared editable settings paths.
 * @param path - config path addressed by a settings edit.
 * @returns whether the path is declared editable.
 */
export function isEditableSettingsPath(path: readonly string[]): boolean {
  return EDITABLE_SETTINGS_PATHS.some(
    (candidate) =>
      (candidate.length === path.length || ['engines', 'controls'].includes(candidate[0]) && path[0] === candidate[0]) && candidate.every((segment, index) => segment === path[index]),
  );
}

/**
 * The parsed configuration fields this module reads.
 *
 * Declared structurally rather than imported from `./index.js` so the module
 * stays free of a cycle with the plugin entry. Every volatile field is written
 * as the union a hand-built config may use: a `.volatile()` field parses into a
 * live reference, while a caller assembling a config by hand passes a plain
 * value.
 */
export interface SettingsSurfaceConfig {
  engines?: Volatile<AdditionalEnginesConfig | undefined> | AdditionalEnginesConfig;
  /** Search-face configuration. */
  search?: {
    /** No schema default: unset falls back, so the reference admits `undefined`. */
    anysearchApiKeyEnv?: Volatile<string> | string;
    siliconflowApiKeyEnv?: Volatile<string> | string;
  };
  /** Fetch-face configuration. */
  fetch?: {
    anysearchApiKeyEnv?: Volatile<string | undefined> | string;
    firecrawlApiKeyEnv?: Volatile<string> | string;
  };
}

/** Stable id of one engine key slot the settings card offers. */
export type CredentialSlotId = 'anysearch' | 'deepseek' | 'firecrawl' | 'tavily' | 'exa' | 'keenable' | 'crawl4ai' | 'github' | 'tinyfish' | 'serply' | 'kimi' | 'siliconflow' | 'dashscope' | 'typesafe';

/** One engine key slot: which references name it, and the fallback. */
export interface CredentialSlot {
  /** Stable slot id the card labels and renders in this order. */
  readonly id: CredentialSlotId;
  /**
   * Config paths that may override the reference name, outermost first. The
   * first one that names a non-empty reference wins; the rest are fallbacks.
   */
  readonly overridePaths: readonly (readonly string[])[];
  /** Reference used when no override names one. */
  readonly defaultRef: string;
  /** Explicit references shared by this service across capability faces. */
  readonly additionalPaths?: readonly (readonly string[])[];
}

/** All credential inputs from the complete integration list, in service order. */
export const CREDENTIAL_SLOTS: readonly CredentialSlot[] = [
  {"id": "anysearch", "overridePaths": [["search", "anysearchApiKeyEnv"]], "defaultRef": "ANYSEARCH_API_KEY", "additionalPaths": [["fetch", "anysearchApiKeyEnv"]]},
  {"id": "deepseek", "overridePaths": [["engines", "deepseek", "apiKeyEnv"]], "defaultRef": "DEEPSEEK_API_KEY"},
  {"id": "firecrawl", "overridePaths": [["fetch", "firecrawlApiKeyEnv"]], "defaultRef": "FIRECRAWL_API_KEY", "additionalPaths": [["engines", "firecrawl", "apiKeyEnv"]]},
  {"id": "tavily", "overridePaths": [["engines", "tavily", "apiKeyEnv"]], "defaultRef": "TAVILY_API_KEY"},
  {"id": "exa", "overridePaths": [["engines", "exa", "apiKeyEnv"]], "defaultRef": "EXA_API_KEY"},
  {"id": "keenable", "overridePaths": [["engines", "keenable", "apiKeyEnv"]], "defaultRef": "KEENABLE_API_KEY"},
  {"id": "crawl4ai", "overridePaths": [["engines", "crawl4ai", "apiKeyEnv"]], "defaultRef": "CRAWL4AI_API_KEY"},
  {"id": "github", "overridePaths": [["engines", "github", "apiKeyEnv"]], "defaultRef": "GITHUB_TOKEN"},
  {"id": "tinyfish", "overridePaths": [["engines", "tinyfish", "apiKeyEnv"]], "defaultRef": "TINYFISH_API_KEY"},
  {"id": "serply", "overridePaths": [["engines", "serply", "apiKeyEnv"]], "defaultRef": "SERPLY_API_KEY"},
  {"id": "kimi", "overridePaths": [["engines", "kimi", "apiKeyEnv"]], "defaultRef": "MOONSHOT_API_KEY"},
  {"id": "siliconflow", "overridePaths": [["search", "siliconflowApiKeyEnv"]], "defaultRef": "SILICONFLOW_API_KEY"},
  {"id": "dashscope", "overridePaths": [], "defaultRef": "DASHSCOPE_API_KEY"},
  {"id": "typesafe", "overridePaths": [], "defaultRef": "TYPESAFE_API_KEY"}
];

/** One slot bound to the reference its chain currently resolves to. */
export interface CredentialSlotRef {
  /** Slot this reference belongs to. */
  readonly id: CredentialSlotId;
  /** Effective reference name, never a value. */
  readonly ref: string;
  readonly refs?: readonly string[];
}

/**
 * Resolve every slot to the reference its chain currently names.
 *
 * This is the same chain the host's own search-face reads follow, so a card
 * built from these refs describes and writes the credentials the engines
 * actually use.
 * @param config - the parsed plugin configuration.
 * @returns one effective reference per slot, in {@link CREDENTIAL_SLOTS} order.
 */
export function resolveCredentialRefs(
  config: SettingsSurfaceConfig,
): readonly CredentialSlotRef[] {
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
export function resolveCredentialRef(config: SettingsSurfaceConfig, id: CredentialSlotId): string {
  const slot = CREDENTIAL_SLOTS.find((candidate) => candidate.id === id);
  /* v8 ignore next -- the id is a closed union, so a missing slot is unrepresentable. */
  if (slot === undefined) throw new Error(`unknown credential slot "${id}"`);
  return resolveSlotRef(config, slot);
}

/** Resolve one slot: first non-empty override, else the declared default. */
function resolveSlotRef(config: SettingsSurfaceConfig, slot: CredentialSlot): string {
  for (const path of slot.overridePaths) {
    const named = readVolatile(readConfigPath(config, path));
    if (typeof named === 'string' && named.length > 0) return named;
  }
  return slot.defaultRef;
}

/** Read one config path, or `undefined` when any segment is absent. */
function readConfigPath(config: SettingsSurfaceConfig, path: readonly string[]): unknown {
  let node: unknown = config;
  for (const segment of path) {
    node = readVolatile(node);
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** One slot's read-only state as the card renders it: presence, never a value. */
export interface CredentialSlotStatus {
  /** Slot this row reports. */
  readonly id: CredentialSlotId;
  /** Effective reference the row describes. */
  readonly ref: string;
  /** Whether resolving the reference would currently return a value. */
  readonly configured: boolean;
  /** Whether the active provider can write the reference. */
  readonly writable: boolean;
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
export function projectCredentialStatus(
  slots: readonly CredentialSlotRef[],
  described: Readonly<Record<string, CredentialInfo>>,
): readonly CredentialSlotStatus[] {
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
export function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    return (value as Volatile<T>).get() as T;
  }
  return value as T;
}
