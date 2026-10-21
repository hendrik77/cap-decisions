import { startMockServer } from '../src/mock-server';
import type { MockServer, MockServerOptions } from '../src/mock-server';

export const full: MockServerOptions = {
  port: 0,
  host: '127.0.0.1',
  path: '/v1/systemone',
  fixtures: 'test/data/systemone.json',
  root: '/tmp',
  strategy: 'seeded',
  latencyMs: 50,
  fail: { code: 'HTTP_ERROR', status: 503, providerCode: 'overloaded' },
  token: 'secret',
  format: 'cloudflare',
  log: (line: string) => void line,
};
export const withRules: MockServerOptions = {
  rules: [{ when: { question: 'refund' }, answer: { noul: 0.9 } }, { fail: 'TIMEOUT' }],
  fail: 'NETWORK_ERROR',
};
export const empty: MockServerOptions = {};

// @ts-expect-error fixtures and rules exclude each other.
export const both: MockServerOptions = { fixtures: 'a.json', rules: [] };
// @ts-expect-error The format is limited to jev and cloudflare.
export const wrongFormat: MockServerOptions = { format: 'xml' };
// @ts-expect-error The strategy is limited to keywords and seeded.
export const wrongStrategy: MockServerOptions = { strategy: 'random' };
// @ts-expect-error The port is a number.
export const wrongPort: MockServerOptions = { port: '8000' };

export async function use(): Promise<void> {
  const server: MockServer = await startMockServer({ port: 0 });
  const url: string = server.url;
  const port: number = server.port;
  const host: string = server.host;
  const closed: Promise<void> = server.close();
  void [url, port, host];
  await closed;
  await startMockServer();
}
