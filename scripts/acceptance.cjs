'use strict';
// Acceptance checks of one kind against a real or local decision server, from an installed release archive.
// Not part of the package. Usage: see USAGE below, and docs/plans/hardening-for-1.0.md (H10).

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { clearTimeout } = require('node:timers');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const KINDS = ['decisions-typesafe', 'decisions-cloudflare', 'decisions-laya', 'decisions-generic', 'decisions-subq'];
// Kinds that run on this machine, where "nothing listens on this port" is a meaningful check.
const LOCAL_KINDS = ['decisions-laya', 'decisions-generic'];
const TOKEN_VARIABLE = 'CAP_DECISIONS_ACCEPTANCE_TOKEN';
const USAGE = `Usage: node scripts/acceptance.cjs --kind <kind> --archive <cap-decisions-x.y.z.tgz> [--url <url>] [--account-id <id>] [--keep]
  kinds: ${KINDS.join(', ')}
  The token (token kinds) is read from the environment variable ${TOKEN_VARIABLE}.`;

class UsageError extends Error {}

// ---------------------------------------------------------------- command line

function parseArgs(argv) {
  const options = { keep: false };
  const values = {
    '--kind': 'kind',
    '--archive': 'archive',
    '--url': 'url',
    '--account-id': 'accountId',
    '--link-cds': 'linkCds',
  };
  for (let index = 0; index < argv.length; index++) {
    const [name, inline] = argv[index].split(/=(.*)/s);
    if (name === '--token') {
      throw new UsageError(`The token is not accepted as an argument; set ${TOKEN_VARIABLE} instead.`);
    }
    if (name === '--keep') options.keep = true;
    else if (values[name]) {
      const value = inline ?? argv[++index];
      if (!value) throw new UsageError(`${name} needs a value`);
      options[values[name]] = value;
    } else throw new UsageError(`Unknown argument "${name}"`);
  }
  if (!options.kind || !KINDS.includes(options.kind))
    throw new UsageError(`--kind must be one of: ${KINDS.join(', ')}`);
  if (!options.archive) throw new UsageError('--archive is required');
  options.archive = path.resolve(options.archive);
  if (!fs.existsSync(options.archive)) throw new UsageError(`Archive not found: ${options.archive}`);
  if (options.kind === 'decisions-generic' && !options.url) throw new UsageError('decisions-generic requires --url');
  if (options.kind === 'decisions-cloudflare' && !options.url && !options.accountId) {
    throw new UsageError('decisions-cloudflare requires --account-id (or --url)');
  }
  if (options.linkCds) options.linkCds = path.resolve(options.linkCds);
  return options;
}

// ---------------------------------------------------------------- processes

const children = new Set();
// No child may outlive the script, whatever happens.
process.on('exit', () => children.forEach((child) => child.kill('SIGKILL')));

// Runs a command and returns its output; never throws.
function run(command, args, { cwd, env = process.env, timeout = 120_000 }) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd, env, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        children.delete(child);
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, error });
      },
    );
    children.add(child);
  });
}

// npm is a .cmd file on Windows, which cannot be run without a shell; npm's JavaScript entry runs with node instead.
function findNpmCli() {
  return [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((file) => file?.endsWith('.js') && fs.existsSync(file));
}
const npm = (args, options) => {
  const cli = findNpmCli();
  return cli ? run(process.execPath, [cli, ...args], options) : run('npm', args, options);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ---------------------------------------------------------------- the app

// Copies the example app, points it at the archive, installs and runs `cds add decisions`.
async function createApp(options, dir) {
  const repository = path.resolve(__dirname, '..');
  fs.cpSync(path.join(repository, 'examples/cap-app'), dir, {
    recursive: true,
    // The example's tsconfig extends the repository's; the app needs none.
    filter: (source) => !['node_modules', 'tsconfig.json'].includes(path.basename(source)),
  });
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // `cds add decisions` writes the kind, so the example's own production kind must not be there.
  delete pkg.cds;
  // @sap/cds comes first: with a linked @sap/cds listed after the archive, npm 11 fails on the peer dependency.
  pkg.dependencies = {};
  if (options.linkCds) pkg.dependencies['@sap/cds'] = `file:${path.join(options.linkCds, 'node_modules/@sap/cds')}`;
  else {
    pkg.dependencies['@sap/cds'] = '^10';
    pkg.dependencies['@sap/cds-dk'] = '^10';
  }
  pkg.dependencies['cap-decisions'] = `file:${options.archive}`;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
  const install = await npm(['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir,
  });
  if (install.status !== 0) throw new Error(`npm install failed: ${install.stderr || install.error?.message}`);
  const dk = path.join(options.linkCds ?? dir, 'node_modules/@sap/cds-dk/bin/cds.js');
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.CDS_ENV;
  delete env.NODE_ENV;
  const add = await run(process.execPath, [dk, 'add', 'decisions', '--kind', options.kind], { cwd: dir, env });
  if (add.status !== 0) throw new Error(`cds add decisions failed: ${add.stderr || add.stdout}`);
}

// The part of every check that runs in the app: connect, decide, print one JSON line. The settings of the
// check, token included, arrive in CDS_CONFIG, so they live in the environment of this child only.
const CHILD = `
const cds = require('@sap/cds');
const finish = (value) => process.stdout.write('\\n' + JSON.stringify(value) + '\\n', () => process.exit(0));
(async () => {
  await cds.plugins;
  const spec = JSON.parse(process.env.ACCEPTANCE_SPEC);
  if (spec.action === 'info') {
    const { requiresToken, limits, modelId } = cds.env.requires.decisions;
    return finish({ requiresToken: !!requiresToken, limits: limits || {}, modelId, cds: require('@sap/cds/package.json').version });
  }
  const out = { ok: true };
  let started = performance.now();
  try {
    const service = await cds.connect.to('decisions');
    out.connectMs = performance.now() - started;
    if (spec.action === 'decide') {
      started = performance.now();
      try { out.result = await service.decide({ state: spec.state, questions: spec.questions }); }
      finally { out.ms = performance.now() - started; }
    }
  } catch (error) {
    out.ok = false;
    out.error = { code: error.code, status: error.status, message: String(error.message), providerCode: error.providerCode };
  }
  finish(out);
})().catch((error) => { process.stderr.write(String((error && error.stack) || error)); process.exitCode = 1; });
`;

function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) target[key] = merge(target[key] ?? {}, value);
    else if (value !== undefined) target[key] = value;
  }
  return target;
}

// Runs one spec in a child process in the production profile and parses its last JSON line.
async function runCheck(context, spec, { token = context.token, url = context.url, settings = {} } = {}) {
  const decisions = merge({ credentials: { url, accountId: context.accountId, token } }, settings);
  const env = {
    ...process.env,
    CDS_ENV: 'production',
    CDS_CONFIG: JSON.stringify({ requires: { decisions } }),
    ACCEPTANCE_SPEC: JSON.stringify(spec),
  };
  delete env.NODE_ENV;
  delete env[TOKEN_VARIABLE];
  const child = await run(process.execPath, ['-e', CHILD], { cwd: context.dir, env, timeout: 60_000 });
  const line = child.stdout.trim().split('\n').filter(Boolean).at(-1);
  let outcome;
  try {
    outcome = JSON.parse(line);
  } catch {
    outcome = undefined;
  }
  // The model the server says answered, for the report.
  if (outcome?.result?.model) context.answeredBy ??= outcome.result.model;
  return {
    outcome,
    output: child.stdout + child.stderr,
    crash: outcome ? undefined : child.stderr || child.stdout || 'no output',
  };
}

// ---------------------------------------------------------------- questions

const STATE = 'A customer writes: I want a refund for my last invoice.';
const choice = (count = 3) => ({
  type: 'choice',
  instructions: 'Which team should handle this message?',
  criteria:
    count === 3
      ? { billing: 'Payments and refunds', technical: 'Errors and integrations', other: null }
      : Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`option${index + 1}`, `Option number ${index + 1}`]),
        ),
});
const score = (count = 5) => ({
  type: 'score',
  instructions: 'How unhappy is the customer?',
  criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
});
const noul = () => ({ type: 'noul', instructions: 'Is the customer asking for money back?' });
const many = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index + 1}`, noul()]));

// ---------------------------------------------------------------- checks

const rounded = (ms) => (ms === undefined ? undefined : Math.max(1, Math.round(ms)));
const pass = (ms, note = '') => ({ status: 'pass', ms: rounded(ms), note });
const fail = (note, ms) => ({ status: 'fail', ms: rounded(ms), note });
const skipped = (note) => ({ status: 'skipped', note });

// Expects a call to fail with the given code (and status), else says what happened.
function expectError(call, code, statuses) {
  const { outcome, crash } = call;
  if (!outcome) return `the check process crashed: ${crash}`;
  if (outcome.ok) return `expected ${code}, but the call succeeded`;
  if (outcome.error.code !== code) return `expected ${code}, got ${outcome.error.code}: ${outcome.error.message}`;
  if (statuses && !statuses.includes(outcome.error.status))
    return `expected status ${statuses.join(' or ')}, got ${outcome.error.status}`;
  return undefined;
}

// Expects a successful call and returns its answers, else an explanation.
function expectAnswers(call, expectedIds) {
  const { outcome, crash } = call;
  if (!outcome) return { problem: `the check process crashed: ${crash}` };
  if (!outcome.ok)
    return {
      problem: `${outcome.error.code}${outcome.error.status ? ` ${outcome.error.status}` : ''}: ${outcome.error.message}`,
    };
  const answers = outcome.result?.answers ?? {};
  const missing = expectedIds.filter((id) => !answers[id]);
  if (missing.length) return { problem: `no answer for ${missing.join(', ')}` };
  return { answers, ms: outcome.ms };
}

async function single(context, type, question, verify) {
  const call = await runCheck(context, { action: 'decide', state: STATE, questions: { q: question } });
  const { answers, ms, problem } = expectAnswers(call, ['q']);
  if (problem) return fail(problem, call.outcome?.ms);
  const answer = answers.q;
  if (answer.type !== type) return fail(`the answer type is ${answer.type}, not ${type}`, ms);
  const wrong = verify(answer);
  return wrong ? fail(wrong, ms) : pass(ms, `${type} answer ok`);
}

const inRange = (value) => typeof value === 'number' && value >= 0 && value <= 1;

const BASIC_CHECKS = {
  async connect(context) {
    const call = await runCheck(context, { action: 'connect' });
    if (!call.outcome) return fail(`the check process crashed: ${call.crash}`);
    if (!call.outcome.ok) return fail(`${call.outcome.error.code}: ${call.outcome.error.message}`);
    return pass(call.outcome.connectMs, 'settings are valid');
  },
  choice: (context) =>
    single(context, 'choice', choice(), (answer) =>
      ['billing', 'technical', 'other'].includes(answer.choice)
        ? undefined
        : `"${answer.choice}" is not an offered label`,
    ),
  score: (context) =>
    single(context, 'score', score(5), (answer) =>
      // The score is a number along the scale (the types say so), not necessarily a whole one.
      typeof answer.score === 'number' && answer.score >= 0 && answer.score <= 4
        ? undefined
        : `score ${answer.score} is not a number from 0 to 4`,
    ),
  noul: (context) =>
    single(context, 'noul', noul(), (answer) =>
      inRange(answer.noul) ? undefined : `noul ${answer.noul} is not in [0, 1]`,
    ),
  async 'several questions'(context) {
    const questions = { c: choice(), s: score(5), n: noul() };
    const call = await runCheck(context, { action: 'decide', state: STATE, questions });
    const { answers, ms, problem } = expectAnswers(call, Object.keys(questions));
    if (problem) return fail(problem, call.outcome?.ms);
    const types = Object.entries(answers).filter(([id, answer]) => answer.type !== questions[id].type);
    return types.length
      ? fail(`wrong answer type for ${types.map(([id]) => id).join(', ')}`, ms)
      : pass(ms, 'three answers');
  },
};

// One request exactly at a limit must work, one beyond it must be refused before sending.
async function limitCheck(context, atLimit, beyond) {
  const ok = expectAnswers(
    await runCheck(context, { action: 'decide', state: STATE, questions: atLimit }),
    Object.keys(atLimit),
  );
  if (ok.problem) return fail(`at the limit: ${ok.problem}`);
  const problem = expectError(
    await runCheck(context, { action: 'decide', state: STATE, questions: beyond }),
    'INVALID_REQUEST',
  );
  return problem ? fail(`beyond the limit: ${problem}`, ok.ms) : pass(ok.ms, 'limit accepted, one more refused');
}

// The limits the resolved kind sets, as [name, check].
function limitChecks(context) {
  const { limits } = context.info;
  const checks = [];
  if (limits.questions) {
    checks.push([
      `limit questions ${limits.questions}`,
      () => limitCheck(context, many(limits.questions), many(limits.questions + 1)),
    ]);
  }
  if (limits.choiceOptions) {
    const count = limits.choiceOptions;
    checks.push([
      `limit choiceOptions ${count}`,
      () => limitCheck(context, { q: choice(count) }, { q: choice(count + 1) }),
    ]);
  }
  for (const bound of ['min', 'max']) {
    const count = limits.scoreCriteria?.[bound];
    if (!count) continue;
    const beyond = bound === 'min' ? count - 1 : count + 1;
    checks.push([
      `limit scoreCriteria.${bound} ${count}`,
      () => limitCheck(context, { q: score(count) }, { q: score(beyond) }),
    ]);
  }
  return checks;
}

async function wrongToken(context) {
  if (!context.info.requiresToken) return skipped('the kind needs no token');
  const wrong = `${context.token}-wrong`;
  const call = await runCheck(context, { action: 'decide', state: STATE, questions: { q: noul() } }, { token: wrong });
  const problem = expectError(call, 'HTTP_ERROR', [401, 403]);
  if (problem) return fail(problem);
  const leaked = [context.token, wrong].some((secret) => call.output.includes(secret));
  return leaked
    ? fail('the token or the wrong token appears in the output')
    : pass(call.outcome.ms, `HTTP ${call.outcome.error.status}`);
}

async function missingToken(context) {
  if (!context.info.requiresToken) return skipped('the kind needs no token');
  const call = await runCheck(context, { action: 'decide', state: STATE, questions: { q: noul() } }, { token: '' });
  return expectError(call, 'INVALID_CONFIG') ?? pass(call.outcome.ms ?? call.outcome.connectMs, 'INVALID_CONFIG');
}

async function timeout(context) {
  const call = await runCheck(
    context,
    { action: 'decide', state: STATE, questions: { q: noul() } },
    { settings: { timeoutMs: 1 } },
  );
  return expectError(call, 'TIMEOUT') ?? pass(call.outcome.ms, 'TIMEOUT with timeoutMs 1');
}

async function networkError(context) {
  if (!LOCAL_KINDS.includes(context.kind)) return skipped('remote target');
  const url = `http://127.0.0.1:${await freePort()}/v1/systemone`;
  const call = await runCheck(context, { action: 'decide', state: STATE, questions: { q: noul() } }, { url });
  return expectError(call, 'NETWORK_ERROR') ?? pass(call.outcome.ms, 'NETWORK_ERROR');
}

// Starts the example app as a server (on a port CAP picks and logs) and routes a refund message. The server is
// always stopped afterwards.
async function exampleHandler(context) {
  const decisions = { credentials: { url: context.url, accountId: context.accountId, token: context.token } };
  const env = {
    ...process.env,
    CDS_ENV: 'production',
    CDS_TYPESCRIPT: 'true',
    PORT: '0',
    CDS_CONFIG: JSON.stringify({ requires: { decisions, auth: { kind: 'mocked' } } }),
  };
  delete env.NODE_ENV;
  delete env[TOKEN_VARIABLE];
  const bin = path.join(context.dir, 'node_modules/@sap/cds/bin/serve.js');
  const server = spawn(process.execPath, [bin], { cwd: context.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(server);
  let log = '';
  let exited = false;
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));
  server.once('exit', () => (exited = true));
  try {
    const deadline = Date.now() + 60_000;
    let base;
    while (!(base = /server listening on \{ url: '([^']+)' \}/.exec(log)?.[1])) {
      if (exited) return fail(`the server stopped: ${log.trim().split('\n').slice(-3).join(' | ').slice(-400)}`);
      if (Date.now() > deadline) return fail('the server did not start within 60 s');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = performance.now();
    const response = await globalThis.fetch(`${base}/odata/v4/decision/classify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from('alice:').toString('base64')}`,
      },
      body: JSON.stringify({ message: 'I want a refund for my last invoice' }),
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const ms = performance.now() - started;
    if (response.status !== 200) return fail(`HTTP ${response.status}: ${text.slice(0, 200)}`, ms);
    const value = JSON.parse(text).value;
    return value === 'accounts'
      ? pass(ms, 'refund routed to accounts')
      : fail(`expected "accounts", got ${JSON.stringify(value)}`, ms);
  } finally {
    await stop(server);
    children.delete(server);
  }
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------- report

const redactor = (secrets) => (text) =>
  secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('***'), String(text));

function report(context, results, redact) {
  const counts = { pass: 0, fail: 0, skipped: 0 };
  results.forEach((result) => counts[result.status]++);
  const cell = (text) => redact(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const rows = results.map(
    (result) =>
      `| ${cell(result.name)} | ${result.status} | ${result.ms === undefined ? '' : `${result.ms} ms`} | ${cell(result.note)} |`,
  );
  return [
    `### Acceptance run: ${context.kind}`,
    '',
    `- Archive: ${path.basename(context.archive)}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Node: ${process.version}`,
    `- @sap/cds: ${context.info.cds}`,
    `- Model: ${context.info.modelId ?? 'none configured'}, answered as ${context.answeredBy ?? 'unknown'}`,
    `- Result: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped`,
    '',
    '| Check | Result | Latency | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const token = process.env[TOKEN_VARIABLE] || undefined;
  const redact = redactor([token, token && `${token}-wrong`]);
  const context = { ...options, token, accountId: options.accountId };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-decisions-acceptance-'));
    context.dir = dir;
    await createApp(options, dir);
    const info = await runCheck(context, { action: 'info' });
    if (!info.outcome) throw new Error(`could not read the settings: ${info.crash}`);
    context.info = info.outcome;
    if (context.info.requiresToken && !token) {
      process.stderr.write(`The kind ${options.kind} needs a token; set ${TOKEN_VARIABLE}.\n${USAGE}\n`);
      return 2;
    }
    const noLimits = !Object.keys(context.info.limits).length;
    const checks = [
      ['connect', () => BASIC_CHECKS.connect(context)],
      ['missing token', () => missingToken(context)],
      ...['choice', 'score', 'noul', 'several questions'].map((name) => [name, () => BASIC_CHECKS[name](context)]),
      ...(noLimits ? [['limits', async () => skipped('the kind sets no limits')]] : limitChecks(context)),
      ['wrong token', () => wrongToken(context)],
      ['timeout', () => timeout(context)],
      ['network error', () => networkError(context)],
      ['example handler', () => exampleHandler(context)],
    ];
    const results = [];
    for (const [name, check] of checks) {
      let result;
      try {
        result = await check();
      } catch (error) {
        result = fail(`unexpected error: ${error.message}`);
      }
      results.push({ name, ...result, note: redact(result.note ?? '') });
      const line =
        result.status === 'pass'
          ? `pass ${name}${result.ms === undefined ? '' : ` (${result.ms} ms)`}`
          : `${result.status} ${name}: ${redact(result.note)}`;
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write(`\n${report(context, results, redact)}\n`);
    return results.some((result) => result.status === 'fail') ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${redact(error.message)}\n`);
    return 1;
  } finally {
    if (dir && options.keep) process.stdout.write(`Kept the app in ${dir}\n`);
    else if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then((code) => {
  process.exitCode = code;
});
