/**
 * Test-only network guard for the AnySearch suite.
 *
 * The engine's HTTP tests must only ever reach the local mock server. This
 * replaces `globalThis.fetch` with a wrapper that refuses any non-loopback
 * host, so an accidental call to the real API fails loudly instead of quietly
 * leaving the test machine (and possibly spending quota).
 *
 * New file belonging to the AnySearch branch — the shared `mock-server.ts`
 * helper is deliberately left alone to avoid colliding with the other engine
 * branches.
 * @module test/helpers/anysearch-network-guard
 */

/** Import for the side effect of installing the guard. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const target =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(target).hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    // Reject rather than throw: `fetch` always returns a promise, and callers
    // (including the engine's error classifier) rely on that.
    throw new Error(`test network guard: refused a request to non-loopback host "${host}"`);
  }
  return await originalFetch(input, init);
}) as typeof fetch;
