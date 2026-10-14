/**
 * Minimal local HTTP server for contract tests. Binds an ephemeral port on
 * 127.0.0.1. No proxy policy is installed in the test process, so
 * `dsh-web-fetch-http` resolves it as a direct route.
 * @module test/helpers/mock-server
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

export interface MockServer {
  /** Origin URL, e.g. `http://127.0.0.1:41234`. */
  readonly url: string;
  /** Every request received so far, in order. */
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export type MockHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>;

export interface StartMockServerOptions {
  /** Artificial delay before the handler runs, to exercise timeouts and aborts. */
  delayMs?: number;
}

export async function startMockServer(
  handler: MockHandler,
  options: StartMockServerOptions = {},
): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    if (options.delayMs !== undefined && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    try {
      await handler(recorded, response);
    } catch {
      response.destroy();
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
