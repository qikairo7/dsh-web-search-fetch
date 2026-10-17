import { WebError } from '@deepseek-ai/dsh-web';
/**
 * Whether one textual address is a non-public destination.
 *
 * Only `unicast` is accepted: every other range `ipaddr.js` reports — including
 * the translation and tunnelling prefixes whose eventual destination cannot be
 * pinned — is refused. Text that is not an address is not this function's
 * concern and reports `false`.
 * @param input - textual IPv4 or IPv6 address, brackets allowed.
 * @returns whether the address is outside the public unicast space.
 */
export declare function isPrivateAddress(input: string): boolean;
/** A hostname resolved to its addresses; `undefined` when resolution failed. */
export type AddressLookup = (hostname: string) => Promise<readonly string[] | undefined>;
/** Default lookup: the operating system resolver, every answer at once. */
export declare const systemLookup: AddressLookup;
/** Outcome of one guard check. */
export interface AddressGuardVerdict {
    /** `false` only when the destination is proven non-public. */
    readonly allowed: boolean;
    /** The address that made the verdict, for the error message and the log. */
    readonly address?: string;
    /** Why the check could not reach a verdict, when it could not. */
    readonly reason?: 'unresolvable' | 'not-a-url' | 'exempt' | 'public';
}
/**
 * Decide whether one URL may be handed to a third-party extraction engine.
 *
 * @param rawUrl - the target URL as the caller supplied it.
 * @param options.exemptHosts - hosts whose fetches keep their own policy.
 * @param options.lookup - resolver override for focused tests.
 * @param options.signal - the operation's signal; a cancelled operation stops
 *   waiting for the resolver instead of holding the deadline open.
 * @returns the verdict; never throws.
 */
export declare function guardTargetAddress(rawUrl: string, options?: {
    exemptHosts?: readonly string[];
    lookup?: AddressLookup;
    signal?: AbortSignal;
}): Promise<AddressGuardVerdict>;
/**
 * Refuse a private destination with the seam's own blocking code.
 * @param rawUrl - the refused target.
 * @param address - the address that proved the destination private.
 * @returns the error the fetch face throws.
 */
export declare function blockedTargetError(rawUrl: string, address?: string): WebError;
