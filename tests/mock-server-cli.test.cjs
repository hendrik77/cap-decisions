const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMockServer } = require('../dist/mock-server');

const { fetch } = globalThis;
const cli = path.resolve(__dirname, '..', 'dist', 'mock-server-cli.js');
const version = require('../package.json').version;
const request = {
  state: 'I was billed twice. Please refund me.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
    },
    refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
  },
};
const post = (url, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(request),
  });
const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-mock-cli-')));

const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGKILL');
});

// Starts the CLI; `exited` resolves with the exit code, `listening` with the URL once the server is up.
function run(args, { cwd = process.cwd(), env = {} } = {}) {
  const environment = { ...process.env };
  delete environment.CAP_JEV_MOCK_TOKEN;
  Object.assign(environment, env);
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: environment });
  children.add(child);
  const output = { stdout: '', stderr: '' };
  let onListening;
  const listening = new Promise((resolve) => (onListening = resolve));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
    const match = /listening on (\S+)/.exec(output.stdout);
    if (match) onListening(match[1]);
  });
  child.stderr.on('data', (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, output, listening, exited };
}

const withTimeout = (promise, message, ms = 10_000) => {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
  return Promise.race([promise, timeout]);
};

const until = (condition, message) =>
  withTimeout(
    (async () => {
      while (!condition()) await new Promise((resolve) => setTimeout(resolve, 20));
    })(),
    message,
  );

async function withCli(args, options, body) {
  const process_ = run(args, options);
  try {
    const early = process_.exited.then(({ code }) => {
      throw new Error(`exited with ${code} before listening: ${process_.output.stderr}`);
    });
    const url = await withTimeout(Promise.race([process_.listening, early]), 'no listening line');
    return await body(url, process_);
  } finally {
    process_.child.kill('SIGKILL');
    await process_.exited;
  }
}

async function fails(args, options) {
  const process_ = run(args, options);
  const result = await withTimeout(process_.exited, 'the process did not exit');
  return { ...result, ...process_.output };
}

describe('serving', () => {
  test('--port 0 prints the URL and answers a request', async () => {
    await withCli(['--port', '0'], {}, async (url, { output }) => {
      assert.match(output.stdout, /^cap-jev mock server listening on http:\/\/127\.0\.0\.1:\d+\/v1\/systemone\n/);
      const response = await post(url);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.answers.refund.type, 'noul');
    });
  });

  test('logs each request on stdout, and not with --quiet', async () => {
    await withCli(['--port', '0'], {}, async (url, { output }) => {
      await post(url);
      await until(() => /POST \/v1\/systemone 200 \d+ms/.test(output.stdout), 'no log line');
    });
    await withCli(['--port', '0', '--quiet'], {}, async (url, { output }) => {
      await post(url);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.doesNotMatch(output.stdout, /POST/);
    });
  });

  test('--path changes the endpoint', async () => {
    await withCli(['--port', '0', '--path', '/custom'], {}, async (url) => {
      assert.ok(url.endsWith('/custom'), url);
      assert.equal((await post(url)).status, 200);
    });
  });

  test('--fixtures is relative to the current directory', async () => {
    const cwd = tempDir();
    try {
      fs.writeFileSync(
        path.join(cwd, 'rules.json'),
        JSON.stringify([{ when: { question: 'department' }, answer: { choice: 'technical' } }]),
      );
      await withCli(['--port', '0', '--fixtures', 'rules.json'], { cwd }, async (url) => {
        const body = await (await post(url)).json();
        assert.equal(body.answers.department.choice, 'technical');
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--strategy and --latency-ms are accepted', async () => {
    await withCli(['--port', '0', '--strategy', 'seeded', '--latency-ms', '150'], {}, async (url) => {
      const started = Date.now();
      assert.equal((await post(url)).status, 200);
      assert.ok(Date.now() - started >= 100);
    });
  });

  test('--fail with --status and --provider-code answers with that error', async () => {
    const args = ['--port', '0', '--fail', 'HTTP_ERROR', '--status', '503', '--provider-code', 'overloaded'];
    await withCli(args, {}, async (url) => {
      const response = await post(url);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { type: 'overloaded' } });
    });
  });

  test('--fail alone selects the error code', async () => {
    await withCli(['--port', '0', '--fail', 'INVALID_RESPONSE'], {}, async (url) => {
      const response = await post(url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'not json');
    });
  });

  test('--format cloudflare wraps the answer', async () => {
    await withCli(['--port', '0', '--format', 'cloudflare'], {}, async (url) => {
      const body = await (await post(url)).json();
      assert.equal(body.success, true);
      assert.deepEqual(body.errors, []);
      assert.equal(body.result.answers.refund.type, 'noul');
    });
  });
});

describe('token', () => {
  test('--token protects the endpoint', async () => {
    await withCli(['--port', '0', '--token', 'secret'], {}, async (url) => {
      assert.equal((await post(url)).status, 401);
      assert.equal((await post(url, { authorization: 'Bearer secret' })).status, 200);
    });
  });

  test('CAP_JEV_MOCK_TOKEN is the fallback', async () => {
    await withCli(['--port', '0'], { env: { CAP_JEV_MOCK_TOKEN: 'from-env' } }, async (url) => {
      assert.equal((await post(url)).status, 401);
      assert.equal((await post(url, { authorization: 'Bearer from-env' })).status, 200);
    });
  });

  test('--token wins over CAP_JEV_MOCK_TOKEN', async () => {
    await withCli(['--port', '0', '--token', 'option'], { env: { CAP_JEV_MOCK_TOKEN: 'env' } }, async (url) => {
      assert.equal((await post(url, { authorization: 'Bearer env' })).status, 401);
      assert.equal((await post(url, { authorization: 'Bearer option' })).status, 200);
    });
  });
});

describe('usage errors', () => {
  const usage = /Run cap-jev-mock --help for the options\./;

  test('a missing configured fixtures file exits with 2', async () => {
    const result = await fails(['--port', '0', '--fixtures', 'missing.json'], { cwd: tempDir() });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^cap-jev-mock: .*missing\.json/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  test('--fail HTTP_ERROR without --status exits with 2', async () => {
    const result = await fails(['--port', '0', '--fail', 'HTTP_ERROR']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^cap-jev-mock: /);
  });

  test('--fail with an unknown code exits with 2', async () => {
    const result = await fails(['--port', '0', '--fail', 'NOPE']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^cap-jev-mock: /);
  });

  test('--status and --provider-code without --fail exit with 2', async () => {
    for (const args of [
      ['--status', '503'],
      ['--provider-code', 'overloaded'],
    ]) {
      const result = await fails(['--port', '0', ...args]);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, /--fail/);
      assert.match(result.stderr, usage);
    }
  });

  test('numbers must be plain non-negative integers', async () => {
    for (const args of [
      ['--port', 'abc'],
      ['--port', '-1'],
      ['--port', '1.5'],
      ['--latency-ms', 'x'],
    ]) {
      const result = await fails(args);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.stderr, /^cap-jev-mock: /);
      assert.match(result.stderr, usage);
    }
  });

  test('an out-of-range port exits with 2', async () => {
    const result = await fails(['--port', '70000']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /port/);
  });

  test('an unknown option exits with 2 and shows the hint', async () => {
    const result = await fails(['--bogus']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^cap-jev-mock: /);
    assert.match(result.stderr, usage);
    assert.equal(result.stdout, '');
  });

  test('a positional argument exits with 2', async () => {
    const result = await fails(['extra']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, usage);
  });
});

describe('other behavior', () => {
  test('a non-loopback host prints a warning on stderr', async () => {
    await withCli(['--host', '0.0.0.0', '--port', '0'], {}, async (_url, { output }) => {
      await until(() => /reachable from the network/.test(output.stderr), 'no warning');
      assert.match(output.stderr, /unprotected/);
    });
    await withCli(['--host', '0.0.0.0', '--port', '0', '--token', 'x'], {}, async (_url, { output }) => {
      await until(() => /reachable from the network/.test(output.stderr), 'no warning');
      assert.doesNotMatch(output.stderr, /unprotected/);
    });
  });

  test('a loopback host prints no warning', async () => {
    await withCli(['--port', '0'], {}, async (_url, { output }) => {
      assert.equal(output.stderr, '');
    });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} exits with 0`, async () => {
      await withCli(['--port', '0'], {}, async (_url, { child, exited }) => {
        child.kill(signal);
        const result = await withTimeout(exited, `no exit after ${signal}`);
        assert.deepEqual(result, { code: 0, signal: null });
      });
    });
  }

  test('a port in use exits with 1', async () => {
    const server = await startMockServer({ port: 0 });
    try {
      const result = await fails(['--port', String(server.port)]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`^cap-jev-mock: cannot listen on 127\\.0\\.0\\.1:${server.port}: `));
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    } finally {
      await server.close();
    }
  });

  test('--help lists the options and exits with 0', async () => {
    const result = await fails(['--help']);
    assert.equal(result.code, 0);
    for (const option of ['--port', '--host', '--path', '--fixtures', '--strategy', '--latency-ms']) {
      assert.ok(result.stdout.includes(option), option);
    }
    for (const option of ['--fail', '--status', '--provider-code', '--token', '--format', '--quiet']) {
      assert.ok(result.stdout.includes(option), option);
    }
    assert.match(result.stdout, /CDS_REQUIRES_SYSTEMONE_KIND=systemone-laya npm start/);
    assert.equal(result.stderr, '');
  });

  test('--version prints the package version', async () => {
    for (const flag of ['--version', '-v']) {
      const result = await fails([flag]);
      assert.equal(result.code, 0);
      assert.equal(result.stdout.trim(), version);
    }
  });

  test('the built file starts with a node shebang', () => {
    assert.ok(fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n'));
  });

  // npm cannot mark the bin executable when it links the workspace before the first build.
  test('the build makes the file executable', { skip: process.platform === 'win32' }, () => {
    assert.equal(fs.statSync(cli).mode & 0o111, 0o111);
  });
});
