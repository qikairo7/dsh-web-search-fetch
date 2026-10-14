/**
 * AnySearch HTTP client: the transport under both engine faces.
 *
 * Three properties are load-bearing and each has a test:
 *
 * 1. The credential is resolved once per operation and never cached, so a
 *    rotated key takes effect on the next call (per-operation credential resolution).
 * 2. A placeholder credential is refused before any request goes out — a
 *    literal `ANYSEARCH_API_KEY` in the value slot is a misconfiguration, and
 *    spending a request to learn that is waste.
 * 3. Every failure leaves as an {@link AnySearchClientError} carrying a
 *    {@link AnySearchFailureSignal}, so the quota circuit breaker (#7) reads a
 *    classification instead of parsing a message.
 *
 * Absorbed at file level from anysearch-dsh commit d20ab97 (src/client.ts),
 * MIT. Copyright (c) 2026 AnySearch Team.
 * @module engines/anysearch/client
 */
import {
  ANYSEARCH_API_KEY_PLACEHOLDERS,
  ANYSEARCH_CLIENT_ID,
  ANYSEARCH_DEFAULT_BASE_URL,
  ANYSEARCH_DEFAULT_CREDENTIAL_NAME,
  ANYSEARCH_EXTRACT_PATH,
  ANYSEARCH_DOMAINS_PATH,
  ANYSEARCH_SUB_DOMAINS_PATH,
  ANYSEARCH_SEARCH_PATH,
  ANYSEARCH_TIMEOUT_MS,
} from './limits.js';
import {
  AnySearchClientError,
  classifyAnySearchFailure,
  upstreamFailureMessage,
  type AnySearchAuthentication,
  type AnySearchOperation,
} from './error.js';
import {
  endpoint,
  envelopeData,
  parseExtractData,
  parseDomainsData,
  parseSubDomainsData,
  parseSearchData,
  readEnvelope,
  type AnySearchEnvelope,
  type AnySearchEnvelopeData,
  type AnySearchExtractRequest,
  type AnySearchExtractResponse,
  type AnySearchSearchRequest,
  type AnySearchSearchResponse,
} from './wire.js';
import type { AnySearchDomainsResponse, AnySearchSubDomainsResponse } from './types.js';

/** Options for {@link AnySearchClient}. Every field has a default except the resolver. */
export interface AnySearchClientOptions {
  /**
   * Resolve the API key for one operation. Called afresh on every operation and
   * never cached. `undefined` or an empty string means "unconfigured": the
   * engine reports that as a config failure rather than sending anonymously,
   * because DESIGN.md lists a credential for this engine.
   */
  resolveApiKey: () => Promise<string | undefined>;
  /** Credential reference name used in error messages. The value never appears. */
  credentialName?: string;
  /** API base URL. Defaults to the public origin; the pathname is preserved. */
  baseURL?: string;
  /** Per-operation transport deadline. Defaults to the documented extract budget. */
  timeoutMs?: number;
  /** `fetch` implementation override, for focused tests. */
  fetchImpl?: typeof fetch;
}

/** A request this client can send. */
interface ClientRequest {
  readonly path: string;
  readonly operation: AnySearchOperation;
  readonly body?: string;
  readonly query?: URLSearchParams;
}

export class AnySearchClient {
  private readonly resolveApiKey: () => Promise<string | undefined>;
  private readonly credentialName: string;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnySearchClientOptions) {
    this.resolveApiKey = options.resolveApiKey;
    this.credentialName = options.credentialName ?? ANYSEARCH_DEFAULT_CREDENTIAL_NAME;
    this.baseURL = options.baseURL ?? ANYSEARCH_DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? ANYSEARCH_TIMEOUT_MS;
    // Deferred lookup keeps `globalThis.fetch` patchable in tests.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Whether the configured base URL can produce public HTTP endpoints. A local
   * check only — it never makes a network call, as the seam requires.
   */
  available(): boolean {
    return endpoint(this.baseURL, ANYSEARCH_SEARCH_PATH) !== undefined;
  }

  /**
   * Run one search. `query` is passed through untruncated (the API documents no
   * length cap); `maxResults` becomes `max_results` only when supplied, so an
   * unbounded request leaves the API's own default in place.
   */
  async search(request: AnySearchSearchRequest, signal?: AbortSignal): Promise<AnySearchSearchResponse> {
    const body = JSON.stringify({
      query: request.query,
      ...(request.maxResults === undefined ? {} : { max_results: request.maxResults }),
      ...(request.tag === undefined ? {} : { tag: request.tag }),
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(request.zone === undefined ? {} : { zone: request.zone }),
      ...(request.language === undefined ? {} : { language: request.language }),
    });
    const envelope = await this.request(
      { path: ANYSEARCH_SEARCH_PATH, operation: 'search', body },
      signal,
    );
    return this.parseData('search', envelope, parseSearchData);
  }

  /** Extract and validate the cleaned content of one public HTTP(S) URL. */
  async extract(request: AnySearchExtractRequest, signal?: AbortSignal): Promise<AnySearchExtractResponse> {
    const body = JSON.stringify({ url: request.url });
    const envelope = await this.request(
      { path: ANYSEARCH_EXTRACT_PATH, operation: 'extract', body },
      signal,
    );
    return this.parseData('extract', envelope, parseExtractData);
  }

  async listDomains(signal?: AbortSignal): Promise<AnySearchDomainsResponse> {
    const envelope = await this.request({ path: ANYSEARCH_DOMAINS_PATH, operation: 'domains' }, signal);
    return this.parseData('domains', envelope, parseDomainsData);
  }

  async getSubDomains(domains: readonly string[], signal?: AbortSignal): Promise<AnySearchSubDomainsResponse> {
    const query = new URLSearchParams();
    for (const domain of domains) query.append('domain', domain);
    const envelope = await this.request({ path: ANYSEARCH_SUB_DOMAINS_PATH, operation: 'sub_domains', query }, signal);
    return this.parseData('sub_domains', envelope, parseSubDomainsData);
  }

  /** Run the value parser over an envelope, re-classifying a shape failure. */
  private parseData<T>(
    operation: AnySearchOperation,
    envelope: AnySearchEnvelope,
    parse: (payload: AnySearchEnvelopeData) => T,
  ): T {
    try {
      return parse(envelopeData(envelope));
    } catch (error) {
      throw new AnySearchClientError(
        `AnySearch ${operation} returned an invalid response: ${errorMessage(error)}`,
        {
          operation,
          ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
          cause: error,
        },
      );
    }
  }

  /**
   * One HTTP round trip plus envelope validation. The only place `fetch` is
   * called, so every failure path funnels through the classifiers below.
   */
  private async request(request: ClientRequest, signal?: AbortSignal): Promise<AnySearchEnvelope> {
    const url = endpoint(this.baseURL, request.path);
    if (url === undefined) {
      throw new AnySearchClientError('AnySearch base URL is invalid', {
        kind: 'config',
        operation: request.operation,
      });
    }
    if (signal?.aborted === true) {
      throw new AnySearchClientError(`AnySearch ${request.operation} aborted`, {
        kind: 'aborted',
        operation: request.operation,
        cause: signal.reason,
      });
    }

    const apiKey = await this.resolveCredential(request.operation, signal);
    const target = new URL(url);
    if (request.query !== undefined) target.search = request.query.toString();
    const authentication: AnySearchAuthentication = apiKey === undefined ? 'anonymous' : 'credential';
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      // Attribution headers kept from the reference client, so AnySearch can
      // identify this integration.
      'user-agent': ANYSEARCH_CLIENT_ID,
      'x-anysearch-client': ANYSEARCH_CLIENT_ID,
    };
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`;

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const composed = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

    let response: Response;
    try {
      response = await this.fetchImpl(target.href, {
        method: request.body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers,
        body: request.body,
        signal: composed,
      });
    } catch (error) {
      throw this.transportFailure(request.operation, error, signal, deadline);
    }

    const retryAfter = response.headers.get('retry-after') ?? undefined;
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw this.transportFailure(request.operation, error, signal, deadline, response.status, retryAfter);
    }

    // A non-2xx response is still an envelope when it parses as one; read it
    // for the stable error code before falling back to the HTTP status.
    const envelope = tryReadEnvelope(value);
    const errorCode = envelope?.errorCode;
    const requestId = envelope?.requestId;
    if (!response.ok) {
      throw new AnySearchClientError(
        upstreamFailureMessage(request.operation, detailFor(response, envelope), factsFor(response, authentication, requestId, errorCode, retryAfter)),
        {
          operation: request.operation,
          httpStatus: response.status,
          authentication,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
      );
    }

    if (envelope === undefined) {
      throw new AnySearchClientError(
        `AnySearch ${request.operation} returned an invalid response: response must be an object`,
        {
          operation: request.operation,
          httpStatus: response.status,
          authentication,
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
      );
    }
    if (envelope.code !== 0) {
      // Business failure under HTTP 200: `code !== 0` is the contract's error
      // signal, and the envelope's `message`/`error_code` are the details.
      throw new AnySearchClientError(
        upstreamFailureMessage(
          request.operation,
          envelope.message.length > 0 ? envelope.message : `API error ${String(envelope.code)}`,
          factsFor(response, authentication, requestId, errorCode, retryAfter),
        ),
        {
          operation: request.operation,
          httpStatus: response.status,
          authentication,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
      );
    }
    return envelope;
  }

  /**
   * Resolve the credential for one operation. Never cached. An empty or blank
   * value reads as "unconfigured"; a value equal to the credential reference
   * name or to a documented placeholder is refused outright.
   */
  private async resolveCredential(
    operation: AnySearchOperation,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let value: string | undefined;
    try {
      value = await resolveAbortable(this.resolveApiKey(), signal);
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) {
        throw new AnySearchClientError(`AnySearch ${operation} aborted`, {
          kind: 'aborted',
          operation,
          cause: signal?.aborted === true ? signal.reason : error,
        });
      }
      throw new AnySearchClientError(
        `AnySearch ${operation} credential resolution failed: ${errorMessage(error)}`,
        { kind: 'config', operation, cause: error },
      );
    }
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      throw new AnySearchClientError(
        `web search credential "${this.credentialName}" is not configured`,
        { kind: 'config', operation },
      );
    }
    const refused =
      trimmed === this.credentialName || ANYSEARCH_API_KEY_PLACEHOLDERS.includes(trimmed);
    if (refused) {
      throw new AnySearchClientError(
        `AnySearch ${operation} credential "${this.credentialName}" is a placeholder; write a real API key into the credential value`,
        { kind: 'config', operation },
      );
    }
    return trimmed;
  }

  /**
   * Classify a failure that happened before or around the response body: a
   * caller abort, the engine deadline, or a transport fault. Passing
   * `httpStatus` covers a body that arrived but could not be parsed.
   */
  private transportFailure(
    operation: AnySearchOperation,
    error: unknown,
    outer: AbortSignal | undefined,
    deadline: AbortSignal,
    httpStatus?: number,
    retryAfter?: string,
  ): AnySearchClientError {
    if (outer?.aborted === true) {
      return new AnySearchClientError(`AnySearch ${operation} aborted`, {
        kind: 'aborted',
        operation,
        cause: outer.reason,
      });
    }
    if (deadline.aborted || isAbortError(error)) {
      return new AnySearchClientError(
        `AnySearch ${operation} timed out after ${this.timeoutMs} ms`,
        { kind: 'timeout', operation, cause: error },
      );
    }
    return new AnySearchClientError(
      `AnySearch ${operation} request failed: ${errorMessage(error)}`,
      {
        kind: classifyAnySearchFailure({
          ...(httpStatus === undefined ? {} : { httpStatus }),
          // A response that arrived but could not be read is an upstream
          // failure, not a transport one: the transport worked.
          transport: httpStatus === undefined,
        }),
        operation,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
        cause: error,
      },
    );
  }
}

/** Read an envelope if it is shaped like one; `undefined` when it is not. */
function tryReadEnvelope(value: unknown): AnySearchEnvelope | undefined {
  try {
    return readEnvelope(value);
  } catch {
    return undefined;
  }
}

/** Upstream detail for one failure, preferring the envelope's own message. */
function detailFor(response: Response, envelope: AnySearchEnvelope | undefined): string {
  if (envelope !== undefined && envelope.message.length > 0) return envelope.message;
  return response.statusText.length > 0 ? response.statusText : 'API error';
}

/** Diagnostic facts attached to an upstream failure. No query text, no credential. */
function factsFor(
  response: Response,
  authentication: AnySearchAuthentication,
  requestId: string | undefined,
  errorCode: string | undefined,
  retryAfter: string | undefined,
): readonly string[] {
  return [
    `HTTP ${response.status}`,
    `auth ${authentication}`,
    ...(errorCode === undefined ? [] : [`error_code ${errorCode}`]),
    ...(requestId === undefined ? [] : [`request_id ${requestId}`]),
    ...(retryAfter === undefined ? [] : [`retry-after ${retryAfter}`]),
  ];
}

/** Race one asynchronous preflight against caller cancellation. */
async function resolveAbortable(
  operation: Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal === undefined) return await operation;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return await new Promise<string | undefined>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
