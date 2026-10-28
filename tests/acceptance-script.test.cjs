const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { startMockServer } = require('../dist/mock-server');
const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/acceptance.cjs');
const TOKEN = 'acceptance-test-token-4711';
const TIMEOUT = 600_000;

// npm is a .cmd file on Windows, which spawnSync cannot run without a shell, so npm's JavaScript entry runs with node.
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find((file) => file?.endsWith('.js') && fs.existsSync(file));

let temp;
let archive;
const servers = [];

before(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-decisions-acceptance-test-'));
  const args = ['pack', '--ignore-scripts', '--pack-destination', temp];
  const pack = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(pack.status, 0, pack.error?.message ?? pack.stderr);
  archive = path.join(temp, pack.stdout.trim().split('\n').at(-1));
});

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  fs.rmSync(temp, { recursive: true, force: true });
});

// Runs the script in a child process and returns its exit status and output.
async function acceptance(args, env = {}) {
  const clean = { ...process.env, CAP_DECISIONS_ACCEPTANCE_TOKEN: '', ...env };
  if (!clean.CAP_DECISIONS_ACCEPTANCE_TOKEN) delete clean.CAP_DECISIONS_ACCEPTANCE_TOKEN;
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: clean,
      timeout: TIMEOUT,
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function mock(options) {
  const server = await startMockServer({ port: 0, ...options });
  servers.push(server);
  return server;
}

const runKind = (kind, server, extra = []) =>
  acceptance(['--kind', kind, '--archive', archive, '--url', server.url, '--link-cds', root, ...extra], {
    CAP_DECISIONS_ACCEPTANCE_TOKEN: server.token,
  });

const KINDS = {
  'decisions-typesafe': {
    options: { token: TOKEN },
    lines: [
      'skipped network error: remote target',
      'pass wrong token',
      'pass missing token',
      'pass limit choiceOptions 255',
      'pass limit scoreCriteria.min 2',
      'pass limit scoreCriteria.max 10',
    ],
  },
  'decisions-subq': {
    options: { token: TOKEN },
    lines: [
      'skipped network error: remote target',
      'pass wrong token',
      'pass limit questions 16',
      'pass limit choiceOptions 255',
      'pass limit scoreCriteria.max 10',
    ],
  },
  'decisions-cloudflare': {
    options: { token: TOKEN, format: 'cloudflare' },
    lines: ['skipped network error: remote target', 'pass wrong token', 'pass limit questions 64'],
  },
  'decisions-laya': {
    options: {},
    lines: [
      'skipped missing token: the kind needs no token',
      'skipped wrong token: the kind needs no token',
      'pass network error',
      'pass limit choiceOptions 100',
    ],
  },
  'decisions-generic': {
    options: {},
    lines: [
      'skipped missing token: the kind needs no token',
      'pass network error',
      'skipped limits: the kind sets no limits',
    ],
  },
};

describe('acceptance script against the HTTP mock server', () => {
  for (const [kind, { options, lines }] of Object.entries(KINDS)) {
    test(`passes every check of ${kind}`, { timeout: TIMEOUT }, async () => {
      const server = await mock(options);
      server.token = options.token;
      const result = await runKind(kind, server);
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 0, output);
      for (const name of ['connect', 'choice', 'score', 'noul', 'several questions', 'timeout', 'example handler']) {
        assert.match(result.stdout, new RegExp(`^pass ${name} \\(\\d+ ms\\)$`, 'm'), output);
      }
      for (const line of lines)
        assert.ok(new RegExp(`^${line.replace(/[.]/g, '\\.')}`, 'm').test(result.stdout), `${line}\n${output}`);
      assert.doesNotMatch(result.stdout, /^fail /m);
      assert.match(result.stdout, new RegExp(`### Acceptance run: ${kind}`));
      assert.match(result.stdout, /- Archive: cap-decisions-.*\.tgz/);
      assert.match(result.stdout, /- Result: \d+ passed, 0 failed, \d+ skipped/);
      assert.match(result.stdout, /- Model: .+, answered as (?!unknown)\S+/);
      assert.match(result.stdout, /\| Check \| Result \| Latency \| Notes \|/);
      assert.ok(!output.includes(TOKEN), 'the token must not appear in the output');
    });
  }

  test('a failing check gives exit 1 and a fail line that names it', { timeout: TIMEOUT }, async () => {
    // Every call fails with 500, so the checks that need an answer fail while the others still run.
    const server = await mock({ fail: { code: 'HTTP_ERROR', status: 500 } });
    const result = await runKind('decisions-laya', server);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^fail choice: /m);
    assert.match(result.stdout, /^pass timeout/m);
    assert.match(result.stdout, /\| choice \| fail \|/);
  });

  test('--keep keeps the app and prints its path', { timeout: TIMEOUT }, async () => {
    const server = await mock({});
    const result = await runKind('decisions-generic', server, ['--keep']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const kept = /^Kept the app in (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(kept && fs.existsSync(path.join(kept, 'package.json')));
    fs.rmSync(kept, { recursive: true, force: true });
  });
});

test('a token kind without the token variable exits with 2 after reading the kind', { timeout: TIMEOUT }, async () => {
  const server = await mock({ token: TOKEN });
  const result = await acceptance([
    '--kind',
    'decisions-subq',
    '--archive',
    archive,
    '--url',
    server.url,
    '--link-cds',
    root,
  ]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /decisions-subq needs a token; set CAP_DECISIONS_ACCEPTANCE_TOKEN/);
});

describe('acceptance script usage errors', () => {
  const cases = [
    ['an unknown kind', () => ['--kind', 'decisions-nope', '--archive', archive]],
    ['a missing archive', () => ['--kind', 'decisions-laya', '--archive', path.join(temp, 'missing.tgz')]],
    ['no archive argument', () => ['--kind', 'decisions-laya']],
    ['a --token argument', () => ['--kind', 'decisions-typesafe', '--archive', archive, '--token', 'secret-value']],
    ['decisions-generic without --url', () => ['--kind', 'decisions-generic', '--archive', archive]],
    ['decisions-cloudflare without account or url', () => ['--kind', 'decisions-cloudflare', '--archive', archive]],
    ['an unknown argument', () => ['--kind', 'decisions-laya', '--archive', archive, '--bogus']],
  ];
  for (const [name, args] of cases) {
    test(`${name} exits with 2`, async () => {
      const result = await acceptance(args());
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /Usage: node scripts\/acceptance\.cjs/);
      assert.ok(!(result.stdout + result.stderr).includes('secret-value'));
    });
  }
});
