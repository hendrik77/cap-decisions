const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApp, removeApp } = require('./helpers/app.cjs');
const { testProviderKind } = require('../dist/testing.js');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');

// The kit runs against the built-in kinds that talk to a server. Each call registers its own describe block.
for (const kind of ['systemone-generic', 'systemone-laya', 'systemone-typesafe']) {
  testProviderKind({ kind, packageDir: root });
}

// SubQ speaks the Jev protocol, but reports errors as { detail: { error_type, message } }.
testProviderKind({
  kind: 'systemone-subq',
  packageDir: root,
  encodeError: ({ code, status, message }) => ({ status, body: { detail: { error_type: code, message } } }),
});

// Cloudflare wraps the answer in an envelope and reports errors as { success: false, errors: [{ code }] }.
testProviderKind({
  kind: 'systemone-cloudflare',
  packageDir: root,
  encode: (response) => ({ success: true, errors: [], result: response }),
  encodeError: ({ code, status, message }) => ({
    status,
    body: { success: false, errors: [{ code, message }], result: null },
  }),
});

describe('the kit itself', () => {
  test('rejects options without a kind or with unknown options', () => {
    assert.throws(() => testProviderKind({}), /kind/);
    assert.throws(() => testProviderKind(undefined), /options/);
    assert.throws(() => testProviderKind({ kind: 'systemone-generic', encode: 'no' }), /encode/);
    assert.throws(() => testProviderKind({ kind: 'systemone-generic', unknown: true }), /unknown/);
  });

  test('requiring cap-jev/testing does not load @sap/cds', async () => {
    const script = `
      require(${JSON.stringify(path.join(root, 'dist/testing.js'))});
      const loaded = Object.keys(require.cache).filter((file) => file.includes('@sap/cds'));
      console.log(JSON.stringify(loaded));`;
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(stdout), []);
  });

  test('is exported as cap-jev/testing with types', () => {
    const pkg = require('../package.json');
    assert.deepEqual(pkg.exports['./testing'], {
      types: './dist/testing.d.ts',
      default: './dist/testing.js',
    });
    assert.equal(typeof require('cap-jev/testing').testProviderKind, 'function');
  });

  test('cds-plugin.js does not load dist/testing.js', async () => {
    assert.equal(fs.readFileSync(path.join(root, 'cds-plugin.js'), 'utf8').includes('testing'), false);
    const script = `
      require('@sap/cds');
      require(${JSON.stringify(path.join(root, 'cds-plugin.js'))});
      console.log(JSON.stringify(Object.keys(require.cache).filter((file) => file.includes('testing'))));`;
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(stdout), []);
  });
});

const GOOD_UNWRAP = `if (typeof payload !== 'object' || !payload || !('data' in payload)) {
      throw new SystemOneError('INVALID_RESPONSE', 'missing data');
    }
    return payload.data;`;

// A provider package in a temporary directory, with the symlinks a development install has.
function writeProvider({ unwrap }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-provider-')));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'cap-jev-provider-kit-test',
      version: '0.0.0',
      private: true,
      main: 'srv/service.js',
      cds: {
        requires: {
          kinds: {
            'systemone-kit-test': {
              kind: 'systemone-defaults',
              impl: 'cap-jev-provider-kit-test',
              requiresToken: true,
              limits: { choiceOptions: 5 },
            },
          },
        },
      },
    }),
  );
  write('cds-plugin.js', '// CAP discovers the package through this file.\n');
  write(
    'srv/service.js',
    `const { SystemOneService, SystemOneError } = require('cap-jev');
class KitTestService extends SystemOneService {
  unwrap(payload) {
    ${unwrap}
  }
}
module.exports = KitTestService;
`,
  );
  fs.mkdirSync(path.join(dir, 'node_modules/@sap'), { recursive: true });
  fs.symlinkSync(root, path.join(dir, 'node_modules/cap-jev'), 'dir');
  fs.symlinkSync(
    fs.realpathSync(path.join(root, 'node_modules/@sap/cds')),
    path.join(dir, 'node_modules/@sap/cds'),
    'dir',
  );
  write(
    'test/provider.test.cjs',
    `const { testProviderKind } = require(${JSON.stringify(path.join(root, 'dist/testing.js'))});
testProviderKind({
  kind: process.env.KIT_KIND || 'systemone-kit-test',
  packageDir: ${JSON.stringify(dir)},
  ...(process.env.KIT_NO_ENCODE ? {} : { encode: (response) => ({ data: response }) }),
});
`,
  );
  return dir;
}

// Runs a test file in a child "node --test". The environment of the outer test runner is removed, so that the
// child behaves like a provider package's own run.
async function runTests(dir, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--test', '--test-reporter=spec', path.join(dir, 'test/provider.test.cjs')],
      { cwd: dir, encoding: 'utf8', env: childEnv, timeout: 120_000 },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code, output: String(error.stdout) + String(error.stderr) };
  }
}

describe('a provider package', () => {
  test('with a correct unwrap passes the kit, with a wrong unwrap it fails and names the check', async () => {
    const good = writeProvider({
      unwrap: GOOD_UNWRAP,
    });
    const broken = writeProvider({ unwrap: 'return payload.dat;' });
    try {
      const [passed, failed] = await Promise.all([runTests(good), runTests(broken)]);
      assert.equal(passed.code, 0, passed.output);
      assert.match(passed.output, /✔ a noul answer comes back typed/);

      assert.notEqual(failed.code, 0, failed.output);
      assert.match(failed.output, /✖ a noul answer comes back typed/);
      assert.match(failed.output, /INVALID_RESPONSE/);
      // The checks that do not depend on unwrap still pass, so the report shows what is wrong and what is not.
      assert.match(failed.output, /✔ a missing token is INVALID_CONFIG/);
    } finally {
      fs.rmSync(good, { recursive: true, force: true });
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  test('without the wire adapter a wrapped answer fails the kit', async () => {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP });
    try {
      const result = await runTests(dir, { KIT_NO_ENCODE: '1' });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /✖ a choice answer comes back typed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown kind fails with a readable message', async () => {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP });
    try {
      const result = await runTests(dir, { KIT_KIND: 'systemone-does-not-exist' });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /systemone-does-not-exist is not a known kind/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs in an existing app with appDir', async () => {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP });
    const app = createApp(
      { name: 'kit-app', private: true, dependencies: { 'cap-jev-provider-kit-test': '*' } },
      {},
      { links: { 'cap-jev-provider-kit-test': dir } },
    );
    try {
      fs.writeFileSync(
        path.join(dir, 'test/provider.test.cjs'),
        `const { testProviderKind } = require(${JSON.stringify(path.join(root, 'dist/testing.js'))});
testProviderKind({
  kind: 'systemone-kit-test',
  appDir: ${JSON.stringify(app)},
  encode: (response) => ({ data: response }),
});
`,
      );
      const result = await runTests(dir);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /✔ a score answer comes back typed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      removeApp(app);
    }
  });
});
