/**
 * Pre-network destination guard for the fetch face.
 *
 * The built-in `dsh-web-fetch-http` provider already refuses non-public
 * destinations, but only on the static HTTP route. The dynamic route hands the
 * URL to third-party extraction engines, which resolve and fetch the target on
 * their own infrastructure — a loopback or RFC 1918 target would therefore leave
 * this process and reach the operator's private network from the outside. This
 * module closes that gap before any engine is dispatched:
 *
 * - **Literal addresses** are classified directly, so `http://127.0.0.1/` is
 *   refused without a DNS query.
 * - **Hostnames** are resolved here; when any answer is non-public the request
 *   is refused, and when resolution itself fails the request is **not** blocked
 *   (the guard cannot prove the destination is private, and the engines still
 *   answer the error for an unresolvable host).
 *
 * A configured static-domain profile (`fetch.staticDomains`) is the documented
 * escape hatch: those hosts are fetched by the built-in HTTP fetcher, which
 * enforces its own policy, so the guard is skipped for them.
 * @module address-guard
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { WebError } from '@deepseek-ai/dsh-web';
/** Ranges that are never a legitimate public web target. */
const BLOCKED_RANGES = new Set([
    'unspecified',
    'broadcast',
    'multicast',
    'linkLocal',
    'loopback',
    'private',
    'reserved',
    'carrierGradeNat',
    'uniqueLocal',
    'ipv4Mapped',
    'rfc6145',
    'rfc6052',
    '6to4',
    'teredo',
]);
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
export function isPrivateAddress(input) {
    const address = input.trim().replace(/^\[|\]$/g, '');
    if (isIP(address) === 0)
        return false;
    let parsed;
    try {
        parsed = ipaddr.parse(address);
    }
    catch {
        return false;
    }
    const range = parsed.range();
    return range !== 'unicast' && BLOCKED_RANGES.has(range);
}
/** Default lookup: the operating system resolver, every answer at once. */
export const systemLookup = async (hostname) => {
    try {
        return (await lookup(hostname, { all: true, order: 'verbatim' })).map(entry => entry.address);
    }
    catch {
        return undefined;
    }
};
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
export async function guardTargetAddress(rawUrl, options = {}) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return { allowed: true, reason: 'not-a-url' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return { allowed: true, reason: 'not-a-url' };
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isExempt(host, options.exemptHosts))
        return { allowed: true, reason: 'exempt' };
    if (isIP(host) !== 0) {
        return isPrivateAddress(host) ? { allowed: false, address: host } : { allowed: true, address: host, reason: 'public' };
    }
    const addresses = await resolveWithin((options.lookup ?? systemLookup)(host), options.signal);
    if (addresses === undefined || addresses.length === 0)
        return { allowed: true, reason: 'unresolvable' };
    const blocked = addresses.find(address => isPrivateAddress(address));
    if (blocked !== undefined)
        return { allowed: false, address: blocked };
    return { allowed: true, reason: 'public' };
}
/**
 * Await the resolver, but stop waiting when the operation is cancelled: a
 * guard that outlives its operation cannot protect anything.
 * @param work - the pending resolution.
 * @param signal - the operation's signal.
 * @returns the resolved addresses, or `undefined` once the operation is gone.
 */
async function resolveWithin(work, signal) {
    if (signal === undefined)
        return await work;
    if (signal.aborted)
        return undefined;
    let stop;
    const cancelled = new Promise((resolve) => {
        stop = () => resolve(undefined);
        signal.addEventListener('abort', stop, { once: true });
    });
    try {
        return await Promise.race([work, cancelled]);
    }
    finally {
        if (stop !== undefined)
            signal.removeEventListener('abort', stop);
    }
}
/**
 * Refuse a private destination with the seam's own blocking code.
 * @param rawUrl - the refused target.
 * @param address - the address that proved the destination private.
 * @returns the error the fetch face throws.
 */
export function blockedTargetError(rawUrl, address) {
    const detail = address === undefined ? '' : `（${address}）`;
    return new WebError(`目标地址${detail}属于本机或内网范围，已拒绝外发给第三方提取服务；` +
        `如需抓取内网地址，请把它加入 fetch.staticDomains，改由内置 HTTP 提取器按自身策略处理：${rawUrl}`, 'WEB_BLOCKED_URL');
}
/** Whether `host` matches one configured static-domain profile (dot-bounded). */
function isExempt(host, exemptHosts) {
    for (const domain of exemptHosts ?? []) {
        const normalized = domain.trim().toLowerCase().replace(/^\.+/, '');
        if (normalized.length === 0)
            continue;
        if (host === normalized || host.endsWith(`.${normalized}`))
            return true;
    }
    return false;
}
