#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startMockServer } from './mock-server';
import type { MockServerOptions } from './mock-server';
import { SystemOneError, isLoopbackHost } from './validation';

const HELP = `Usage: cap-jev-mock [options]

Starts a local mock of a System One (Jev) server.

Options:
  --port <n>             Port to listen on, 0 for any free port (default 8000)
  --host <host>          Address to listen on (default 127.0.0.1)
  --path <path>          Request path (default /v1/systemone)
  --fixtures <file>      Fixture rules, relative to the current directory
  --strategy <name>      keywords or seeded (default keywords)
  --latency-ms <n>       Delay every answer by n milliseconds (default 0)
  --fail <CODE>          Fail every request with this error code, such as HTTP_ERROR
  --status <n>           HTTP status for --fail HTTP_ERROR
  --provider-code <code> Provider error code for --fail
  --token <token>        Require this bearer token (default: env CAP_JEV_MOCK_TOKEN)
  --format <name>        jev or cloudflare (default jev)
  --quiet                Do not log requests
  -h, --help             Show this help
  -v, --version          Show the version

Example:
  npx cap-jev-mock
  CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start
`;

class UsageError extends Error {}

const number = (name: string, value: string): number => {
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a non-negative integer`);
  return Number(value);
};

function parse(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        path: { type: 'string' },
        fixtures: { type: 'string' },
        strategy: { type: 'string' },
        'latency-ms': { type: 'string' },
        fail: { type: 'string' },
        status: { type: 'string' },
        'provider-code': { type: 'string' },
        token: { type: 'string' },
        format: { type: 'string' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  return parsed.values;
}

function toOptions(values: ReturnType<typeof parse>): MockServerOptions {
  const options: Record<string, unknown> = { root: process.cwd() };
  if (values.port !== undefined) options.port = number('--port', values.port);
  if (values.host !== undefined) options.host = values.host;
  if (values.path !== undefined) options.path = values.path;
  if (values.fixtures !== undefined) options.fixtures = values.fixtures;
  if (values.strategy !== undefined) options.strategy = values.strategy;
  if (values['latency-ms'] !== undefined) options.latencyMs = number('--latency-ms', values['latency-ms']);
  if (values.format !== undefined) options.format = values.format;
  const token = values.token ?? (process.env.CAP_JEV_MOCK_TOKEN || undefined);
  if (token !== undefined) options.token = token;
  if (!values.quiet) options.log = (line: string) => process.stdout.write(`${line}\n`);
  const status = values.status === undefined ? undefined : number('--status', values.status);
  const providerCode = values['provider-code'];
  if (values.fail === undefined) {
    if (status !== undefined || providerCode !== undefined) {
      throw new UsageError('--status and --provider-code need --fail');
    }
  } else if (values.fail === 'HTTP_ERROR' && status === undefined) {
    throw new UsageError('--fail HTTP_ERROR needs --status from 400 to 599');
  } else if (status !== undefined && values.fail !== 'HTTP_ERROR') {
    throw new UsageError('--status only goes with --fail HTTP_ERROR');
  } else if (status === undefined && providerCode === undefined) {
    options.fail = values.fail;
  } else {
    options.fail = {
      code: values.fail,
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
    };
  }
  return options as MockServerOptions;
}

async function main(): Promise<void> {
  const values = parse(process.argv.slice(2));
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  const options = toOptions(values);
  let server;
  try {
    server = await startMockServer(options);
  } catch (error) {
    if (error instanceof SystemOneError) throw error;
    const { host = '127.0.0.1', port = 8000 } = options;
    process.stderr.write(`cap-jev-mock: cannot listen on ${host}:${port}: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const stop = () => {
    void server.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (!isLoopbackHost(server.host)) {
    const open = options.token === undefined ? ' and unprotected' : '';
    process.stderr.write(`cap-jev-mock: warning: the server is reachable from the network${open}\n`);
  }
  process.stdout.write(`cap-jev mock server listening on ${server.url}\n`);
}

main().catch((error: unknown) => {
  process.exitCode = 2;
  if (error instanceof UsageError) {
    process.stderr.write(`cap-jev-mock: ${error.message}\nRun cap-jev-mock --help for the options.\n`);
  } else if (error instanceof SystemOneError) {
    process.stderr.write(`cap-jev-mock: ${error.message}\n`);
  } else {
    process.exitCode = 1;
    process.stderr.write(`cap-jev-mock: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});
