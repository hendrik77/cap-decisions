import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockSettings } from './types';
import { SystemOneError, validateRequest } from './validation';
import { DEFAULT_FIXTURES, loadFixtures, mockDecision, parseMockOptions } from './providers/mock-core';
import type { MockStrategy } from './providers/mock-engine';
import { parseFixtures } from './providers/mock-fixtures';
import type { MockRule } from './providers/mock-fixtures';

const MAX_BODY_BYTES = 1024 * 1024;
const OPTION_KEYS = [
  ...['port', 'host', 'path', 'fixtures', 'rules', 'root', 'strategy', 'latencyMs'],
  ...['fail', 'token', 'format', 'log'],
];

interface CommonOptions {
  port?: number;
  host?: string;
  path?: string;
  root?: string;
  strategy?: MockSettings['strategy'];
  latencyMs?: number;
  fail?: MockSettings['fail'];
  token?: string;
  format?: 'jev' | 'cloudflare';
  log?: (line: string) => void;
}

export type MockServerOptions = CommonOptions &
  ({ fixtures?: string; rules?: never } | { rules?: MockRule[]; fixtures?: never });

export interface MockServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

interface Context {
  path: string;
  format: 'jev' | 'cloudflare';
  token?: Buffer;
  strategy: MockStrategy;
  latencyMs: number;
  rules: MockRule[];
  fail?: MockRule;
  source: string;
  log?: (line: string) => void;
}

const invalidConfig = (message: string) => new SystemOneError('INVALID_CONFIG', message);
const digest = (value: string) => createHash('sha256').update(value).digest();

async function parseOptions(options: unknown): Promise<{ context: Context; port: number; host: string }> {
  if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
    throw invalidConfig('Mock server options must be an object');
  }
  const given = (options ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(given).find((key) => !OPTION_KEYS.includes(key));
  if (unknown) throw invalidConfig(`Unknown mock server option "${unknown}"`);
  const { port = 8000, host = '127.0.0.1', path = '/v1/systemone', root = process.cwd() } = given;
  const { fixtures, rules, token, format = 'jev', log } = given;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalidConfig('port must be an integer from 0 to 65535');
  }
  if (typeof host !== 'string' || !host) throw invalidConfig('host must be a non-empty string');
  if (typeof path !== 'string' || !path.startsWith('/')) throw invalidConfig('path must start with /');
  if (typeof root !== 'string' || !root) throw invalidConfig('root must be a non-empty directory path');
  if (token !== undefined && (typeof token !== 'string' || !token))
    throw invalidConfig('token must be a non-empty string');
  if (format !== 'jev' && format !== 'cloudflare') throw invalidConfig('format must be jev or cloudflare');
  if (log !== undefined && typeof log !== 'function') throw invalidConfig('log must be a function');
  if (fixtures !== undefined && rules !== undefined) throw invalidConfig('Use either fixtures or rules, not both');
  const { strategy, latencyMs, fail } = parseMockOptions(
    {
      fixtures: fixtures as string | undefined,
      strategy: given.strategy,
      latencyMs: given.latencyMs,
      fail: given.fail,
    } as MockSettings,
    'fail',
  );
  const context: Context = {
    path,
    format,
    strategy,
    latencyMs,
    fail,
    rules: [],
    source: 'rules',
    log: log as Context['log'],
  };
  if (token !== undefined) context.token = digest(token as string);
  if (rules !== undefined) {
    context.rules = parseFixtures(rules, 'rules');
  } else {
    context.source = (fixtures as string | undefined) ?? DEFAULT_FIXTURES;
    context.rules = await loadFixtures(root, context.source, fixtures !== undefined);
  }
  return { context, port, host };
}

function send(res: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const content =
    body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  res.writeHead(status, { ...content, ...headers });
  res.end(body);
}

function sendError(res: ServerResponse, context: Context, status: number, type: string, message?: string): void {
  const detail = { ...(message === undefined ? {} : { message }) };
  const body =
    context.format === 'cloudflare'
      ? { success: false, errors: [{ code: type, ...detail }], result: null }
      : { error: { type, ...detail } };
  send(res, status, JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: Buffer | undefined, error?: Error) => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        done(undefined);
      } else chunks.push(chunk);
    };
    const onEnd = () => done(Buffer.concat(chunks));
    const onError = (error: Error) => done(undefined, error);
    const onClose = () => {
      if (!req.complete) done(undefined, new Error('The client closed the connection'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// Drops the rest of a body that is too large, so that closing the connection does not reset it before the client
// has read the answer. Stops after a size or time limit.
function discard(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded) return resolve();
    let size = 0;
    const finish = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', finish);
      req.off('close', finish);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * MAX_BODY_BYTES) finish();
    };
    const timer = setTimeout(finish, 1000);
    req.on('data', onData);
    req.on('end', finish);
    req.on('close', finish);
    req.resume();
  });
}

function authorized(req: IncomingMessage, token: Buffer): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && timingSafeEqual(digest(header.slice(7)), token);
}

function failure(
  res: ServerResponse,
  req: IncomingMessage,
  context: Context,
  error: SystemOneError,
  gone: Promise<void>,
) {
  const type = error.providerCode === undefined ? undefined : String(error.providerCode);
  switch (error.code) {
    case 'INVALID_CONFIG':
      return sendError(res, context, 500, 'mock_fixture_error', error.message);
    case 'HTTP_ERROR':
      return sendError(res, context, error.status ?? 500, type ?? 'mock_error');
    case 'NETWORK_ERROR':
      req.socket.destroy();
      return undefined;
    case 'TIMEOUT':
      return gone;
    case 'INVALID_RESPONSE':
      return send(res, 200, 'not json', { 'content-type': 'application/json' });
    case 'PROVIDER_ERROR':
      return context.format === 'cloudflare'
        ? send(
            res,
            200,
            JSON.stringify({
              success: false,
              errors: [{ code: type ?? 'provider_error', message: error.message }],
              result: null,
            }),
          )
        : sendError(res, context, 500, type ?? 'provider_error');
    default:
      return sendError(res, context, 500, 'mock_server_error');
  }
}

function wait(ms: number, gone: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void gone.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, context: Context, gone: Promise<void>) {
  if ((req.url ?? '').split('?')[0] !== context.path) return sendError(res, context, 404, 'not_found_error');
  if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST' });
  if (context.token && !authorized(req, context.token)) {
    return sendError(res, context, 401, 'authentication_error');
  }
  const body = await readBody(req);
  if (body === undefined) {
    await discard(req);
    res.setHeader('connection', 'close');
    return sendError(res, context, 413, 'request_too_large');
  }
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return sendError(res, context, 400, 'invalid_request_error', 'The request body is not valid JSON');
  }
  if (typeof request === 'object' && request !== null && !Array.isArray(request)) {
    request = { ...request };
    delete (request as Record<string, unknown>).model;
  }
  try {
    validateRequest(request);
  } catch (error) {
    if (!(error instanceof SystemOneError)) throw error;
    return sendError(res, context, 400, 'invalid_request_error', error.message);
  }
  if (context.latencyMs > 0) await wait(context.latencyMs, gone);
  if (res.destroyed) return undefined;
  const { strategy, rules, fail, source } = context;
  let result;
  try {
    result = mockDecision(request, { strategy, rules, fail, source });
  } catch (error) {
    if (!(error instanceof SystemOneError)) throw error;
    return failure(res, req, context, error, gone);
  }
  return send(
    res,
    200,
    JSON.stringify(context.format === 'cloudflare' ? { success: true, errors: [], result } : result),
  );
}

function serve(context: Context): Server {
  return createServer((req, res) => {
    const started = Date.now();
    const gone = new Promise<void>((resolve) => {
      res.once('close', () => {
        resolve();
        if (!context.log) return;
        const target = (req.url ?? '').split('?')[0].replace(/[^ -~]/g, '?');
        const status = res.headersSent ? res.statusCode : '-';
        try {
          context.log(`${req.method} ${target} ${status} ${Date.now() - started}ms`);
        } catch {
          // A failing log function must not break the server.
        }
      });
    });
    handle(req, res, context, gone).catch(() => {
      if (res.headersSent) res.destroy();
      else sendError(res, context, 500, 'mock_server_error');
    });
  });
}

export async function startMockServer(options?: MockServerOptions): Promise<MockServer> {
  const { context, port, host } = await parseOptions(options);
  const server = serve(context);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = (server.address() as AddressInfo).port;
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${hostname}:${actual}${context.path}`,
    port: actual,
    host,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
