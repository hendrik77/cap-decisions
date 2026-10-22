const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify, stripVTControlCharacters } = require('node:util');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');
const { startMockServer } = require('../dist/mock-server');
const execFileAsync = promisify(execFile);

// The real command line of @sap/cds-dk, run in a child process in a temporary app.
const cdsBin = path.join(path.dirname(require.resolve('@sap/cds-dk/package.json')), 'bin/cds.js');
const providerPackage = path.resolve(__dirname, '../examples/provider-package');
const TIMEOUT = 120_000;

const servers = [];
after(() => Promise.all(servers.map((server) => server.close())));

async function cds(dir, ...args) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.CDS_ENV;
  delete env.NODE_ENV;
  try {
    const result = await execFileAsync(process.execPath, [cdsBin, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    return { status: 0, ...result };
  } catch (error) {
    return { status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}
const add = (dir, ...args) => cds(dir, 'add', 'systemone', ...args);

// The relative path and content of every file in the app, without node_modules.
function snapshot(dir, base = dir) {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(full, base));
    else files[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return files;
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const readJson = (dir, file) => JSON.parse(read(dir, file));
const lines = (result) => (result.stdout + result.stderr).split('\n').filter((line) => line.startsWith('[systemone]'));

async function withApp(options, body) {
  const { packageJson = {}, files, links } = options;
  const dir = createApp({ name: 'cds-add-app', private: true, ...packageJson }, files, { links });
  try {
    return await body(dir);
  } finally {
    removeApp(dir);
  }
}

// Connects to systemone in a fresh process of the app and prints one JSON line.
function connect(dir, { env = {}, body }) {
  return runInApp(
    dir,
    `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const request = {
      state: 'I was billed twice. Please refund me.',
      questions: { department: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Errors' } } },
    };
    (async () => {
      await cds.plugins;
      try {
        const srv = await cds.connect.to('systemone');
        ${body}
      } catch (e) { out({ error: e.code || e.name, message: e.message }); }
    })().catch((e) => { console.error(e); process.exit(1); });`,
    { env, timeout: 60_000 },
  );
}
const decide = `out({ name: srv.constructor.name, result: await srv.decide(request) });`;

describe('cds add systemone', { concurrency: true }, () => {
  test('sets the production kind, keeps the mock in development and is idempotent', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const first = await add(dir);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /\[systemone\].*systemone-laya/);
      assert.ok(lines(first).every((line) => line.startsWith('[systemone] ')));
      assert.deepEqual(readJson(dir, 'package.json').cds.requires.systemone, {
        '[production]': { kind: 'systemone-laya' },
      });
      assert.deepEqual(Object.keys(snapshot(dir)), ['package.json']);

      const before = snapshot(dir);
      const second = await add(dir);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /already configured/);
      assert.deepEqual(snapshot(dir), before);

      // Development still answers from the mock.
      const development = await connect(dir, { body: decide });
      assert.equal(development.name, 'MockService');
      assert.equal(development.result.model, 'mock');

      // Production uses the kind: the answer comes through HTTP from the mock server.
      const requests = [];
      const server = await startMockServer({ port: 0, log: (line) => requests.push(line) });
      servers.push(server);
      const production = await connect(dir, {
        env: { CDS_ENV: 'production', CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL: server.url },
        body: decide,
      });
      assert.equal(production.name, 'SystemOneService');
      assert.equal(production.result.model, 'mock');
      assert.equal(production.result.answers.department.choice, 'billing');
      assert.equal(requests.length, 1, 'the request went through HTTP');
    });
  });

  test('--kind systemone-typesafe writes a token placeholder and .gitignore', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const first = await add(dir, '--kind', 'systemone-typesafe');
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /\.cdsrc-private\.json/);
      assert.equal(readJson(dir, 'package.json').cds.requires.systemone['[production]'].kind, 'systemone-typesafe');
      assert.deepEqual(readJson(dir, '.cdsrc-private.json'), {
        requires: { systemone: { '[production]': { credentials: { token: '' } } } },
      });
      assert.match(read(dir, '.gitignore'), /^\.cdsrc-private\.json$/m);

      const before = snapshot(dir);
      const second = await add(dir, '--kind', 'systemone-typesafe');
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(snapshot(dir), before);

      // The empty token counts as missing.
      const production = await connect(dir, { env: { CDS_ENV: 'production' }, body: 'out({ ok: true });' });
      assert.equal(production.error, 'INVALID_CONFIG', JSON.stringify(production));
      assert.match(production.message, /token/);
    });
  });

  test('--kind systemone-subq writes a token placeholder and no URL reminder', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const result = await add(dir, '--kind', 'systemone-subq');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readJson(dir, 'package.json').cds.requires.systemone['[production]'].kind, 'systemone-subq');
      assert.deepEqual(readJson(dir, '.cdsrc-private.json'), {
        requires: { systemone: { '[production]': { credentials: { token: '' } } } },
      });
      assert.match(read(dir, '.gitignore'), /^\.cdsrc-private\.json$/m);
      assert.doesNotMatch(result.stdout + result.stderr, /credentials\.url/);

      // The empty token counts as missing.
      const production = await connect(dir, { env: { CDS_ENV: 'production' }, body: 'out({ ok: true });' });
      assert.equal(production.error, 'INVALID_CONFIG', JSON.stringify(production));
      assert.match(production.message, /token/);
    });
  });

  test('--for writes the kind into another profile', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const result = await add(dir, '--for', 'hybrid');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readJson(dir, 'package.json').cds.requires.systemone, {
        '[hybrid]': { kind: 'systemone-laya' },
      });
    });
  });

  test('--with-fixtures writes the example fixtures, which the mock uses', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const result = await add(dir, '--with-fixtures');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /test\/data\/systemone\.json/);
      const rules = readJson(dir, 'test/data/systemone.json');
      assert.equal(rules.length, 2);
      const answer = await connect(dir, { body: decide });
      assert.equal(answer.result.answers.department.choice, 'billing');
      assert.match(answer.result.model, /mock/);

      fs.writeFileSync(path.join(dir, 'test/data/systemone.json'), '[]\n');
      const kept = await add(dir, '--with-fixtures');
      assert.equal(kept.status, 0, kept.stderr);
      assert.equal(read(dir, 'test/data/systemone.json'), '[]\n');
      const forced = await add(dir, '--with-fixtures', '--force');
      assert.equal(forced.status, 0, forced.stderr);
      assert.equal(readJson(dir, 'test/data/systemone.json').length, 2);
    });
  });

  test('a different kind is kept, and --force replaces it', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      assert.equal((await add(dir)).status, 0);
      const before = snapshot(dir);
      const kept = await add(dir, '--kind', 'systemone-typesafe');
      assert.equal(kept.status, 0, kept.stderr);
      assert.match(kept.stdout, /systemone-laya/);
      assert.match(kept.stdout, /--force/);
      assert.deepEqual(snapshot(dir), before);

      const forced = await add(dir, '--kind', 'systemone-typesafe', '--force');
      assert.equal(forced.status, 0, forced.stderr);
      assert.equal(readJson(dir, 'package.json').cds.requires.systemone['[production]'].kind, 'systemone-typesafe');
      assert.ok(Object.hasOwn(snapshot(dir), '.cdsrc-private.json'));
    });
  });

  test('an unknown kind fails, lists the selectable kinds and writes nothing', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const before = snapshot(dir);
      const result = await add(dir, '--kind', 'systemone-nope');
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /Unknown kind "systemone-nope"/);
      assert.match(output, /systemone-laya/);
      assert.doesNotMatch(output, /\n\s+at /, 'no stack trace');
      assert.deepEqual(snapshot(dir), before);

      const mock = await add(dir, '--kind', 'systemone-mock');
      assert.notEqual(mock.status, 0);
      assert.match(mock.stdout + mock.stderr, /mock/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  test('cds add --help lists the facet and its options', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (dir) => {
      const result = await cds(dir, 'add', '--help');
      assert.equal(result.status, 0, result.stderr);
      // The help text is bold even with NO_COLOR.
      const help = stripVTControlCharacters(result.stdout);
      assert.match(help, /systemone\s+- System One decisions with cap-jev/);
      assert.match(help, /cds add systemone\s+--kind[\s\S]*--with-fixtures/);
    });
  });

  test('a Java project is refused', { timeout: TIMEOUT }, async () => {
    await withApp({ files: { 'pom.xml': '<project/>\n', 'srv/pom.xml': '<project/>\n' } }, async (dir) => {
      const before = snapshot(dir);
      const result = await add(dir);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /cap-jev is a Node\.js plugin/);
      assert.deepEqual(snapshot(dir), before);
    });
  });

  test('selects the kind of a provider package', { timeout: TIMEOUT }, async () => {
    const options = {
      packageJson: { dependencies: { 'cap-jev-provider-acme': '*' } },
      links: { 'cap-jev-provider-acme': providerPackage },
    };
    await withApp(options, async (dir) => {
      const unknown = await add(dir, '--kind', 'systemone-nope');
      assert.match(unknown.stdout + unknown.stderr, /systemone-acme/);

      const result = await add(dir, '--kind', 'systemone-acme');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readJson(dir, 'package.json').cds.requires.systemone['[production]'].kind, 'systemone-acme');
      assert.equal(readJson(dir, '.cdsrc-private.json').requires.systemone['[production]'].credentials.token, '');
      assert.match(read(dir, '.gitignore'), /\.cdsrc-private\.json/);
    });
  });
});
