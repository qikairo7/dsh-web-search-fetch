/**
 * Live credential-reference names.
 *
 * A settings-surface field is `.volatile()` because the settings page may edit
 * it. A saved edit is committed into the running reference by the Loader and
 * does not remount the plugin, so a consumer that captured the name at build
 * time keeps addressing the reference the user just moved away from.
 *
 * These helpers let a caller accept either a plain name (hand-written config,
 * tests) or a reader, and normalize both into a reader that is consulted per
 * operation.
 * @module credential-ref
 */

/** A credential reference name, or a reader of the current one. */
export type CredentialRefSource = string | (() => string | undefined);

/**
 * Normalize a reference source into a reader that always answers the current
 * name, falling back to `fallback` when unset.
 *
 * A reader that returns `undefined` (an unset volatile field) and an empty
 * string (an explicit blank) both fall back: a blank reference name would
 * address a credential that cannot exist.
 * @param source - a plain name or a reader of the current one.
 * @param fallback - the name used when the source is unset or blank.
 * @returns a reader of the reference name in force for one operation.
 */
export function liveCredentialRef(
  source: CredentialRefSource | undefined,
  fallback: string,
): () => string {
  if (typeof source === 'function') {
    return () => {
      const name = source();
      return name !== undefined && name.length > 0 ? name : fallback;
    };
  }
  if (source !== undefined && source.length > 0) return () => source;
  return () => fallback;
}
