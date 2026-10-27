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
      throw new DecisionsError('INVALID_RESPONSE', 'missing data');
    }
    return payload.data;`;

// A provider package in a temporary directory, with the symlinks a development install has.
// `plugin` is the content of its cds-plugin.js; `cds` and `capJev` are 'link' (the real package, as installed),
// 'fake' (an empty package that is not the real one) or 'none'; `named: false` leaves out the package name.
function writeProvider({ unwrap, plugin = '// CAP discovers the package through this file.\n', ...layout }) {
  const { cds = 'link', capJev = 'link', named = true } = layout;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-provider-')));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  write(
    'package.json',
    JSON.stringify({
      ...(named ? { name: 'cap-jev-provider-kit-test' } : {}),
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
  write('cds-plugin.js', plugin);
  write(
    'srv/service.js',
    `const { DecisionsService, DecisionsError } = require('cap-jev');
class KitTestService extends DecisionsService {
  unwrap(payload) {
    ${unwrap}
  }
}
module.exports = KitTestService;
`,
  );
  fs.mkdirSync(path.join(dir, 'node_modules/@sap'), { recursive: true });
  const fake = (name) => write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.0.0' }));
  if (capJev === 'link') fs.symlinkSync(root, path.join(dir, 'node_modules/cap-jev'), 'dir');
  else fake('cap-jev');
  if (cds === 'link') {
    fs.symlinkSync(
      fs.realpathSync(path.join(root, 'node_modules/@sap/cds')),
      path.join(dir, 'node_modules/@sap/cds'),
      'dir',
    );
  } else if (cds === 'fake') fake('@sap/cds');
  write(
    'test/provider.test.cjs',
    `const { testProviderKind } = require(${JSON.stringify(path.join(root, 'dist/testing.js'))});
testProviderKind({
  kind: process.env.KIT_KIND || 'systemone-kit-test',
  packageDir: ${JSON.stringify(dir)},
  ...(process.env.KIT_NO_ENCODE ? {} : { encode: (response) => ({ data: response }) }),
  ...(process.env.KIT_ENCODE_THROWS
    ? { encode: () => { throw new Error('encode failed'); } }
    : {}),
  ...(process.env.KIT_SETTINGS ? { settings: JSON.parse(process.env.KIT_SETTINGS) } : {}),
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

describe('the kit reports a package that is set up wrongly', () => {
  async function failsWith(layout, pattern, env) {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP, ...layout });
    try {
      const result = await runTests(dir, env);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, pattern);
      return result;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a directory without package.json', async () => {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP });
    fs.rmSync(path.join(dir, 'package.json'));
    try {
      const result = await runTests(dir);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /is not a package directory: there is no readable package\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a package without a name', () => failsWith({ named: false }, /package\.json has no name/));

  test('two copies of @sap/cds', () => failsWith({ cds: 'fake' }, /Two copies of @sap\/cds would be loaded/));

  test('no @sap/cds anywhere', () =>
    failsWith({ cds: 'none', capJev: 'fake' }, /@sap\/cds cannot be resolved from .* or from cap-jev/));

  test('a CAP process that crashes while it starts reports its error output', () =>
    failsWith(
      { plugin: "throw new Error('plugin exploded');\n" },
      /The CAP process of the test kit exited with code 1\.[\s\S]*plugin exploded/,
    ));

  test('an encode function that throws makes the decisions fail', async () => {
    const result = await failsWith({}, /✖ a noul answer comes back typed/, { KIT_ENCODE_THROWS: '1' });
    assert.match(result.output, /HTTP_ERROR/);
  });

  test('a failing write to the CAP process is reported and does not crash the test process', async () => {
    const dir = writeProvider({ unwrap: GOOD_UNWRAP });
    // Every child the kit spawns gets a stdin whose write fails as after the process died (EPIPE).
    const preload = path.join(dir, 'break-stdin.cjs');
    fs.writeFileSync(
      preload,
      `const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  child.stdin.write = () => {
    setImmediate(() => child.stdin.emit('error', new Error('write EPIPE')));
    return true;
  };
  return child;
};
`,
    );
    try {
      const result = await runTests(dir, { NODE_OPTIONS: `--require ${preload}` });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /The CAP process of the test kit could not be written to: write EPIPE/);
      assert.doesNotMatch(result.output, /Unhandled 'error' event/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settings that cannot be connected fail the first check with a hint', () =>
    failsWith(
      {},
      /✖ connects with the kind's settings[\s\S]*could not be connected with the kit's settings: INVALID_CONFIG/,
      { KIT_SETTINGS: JSON.stringify({ timeoutMs: -1 }) },
    ));
});

describe('the kit validates its options', () => {
  test('packageDir, appDir, settings and credentials must have the right type', () => {
    assert.throws(
      () => testProviderKind({ kind: 'systemone-generic', packageDir: 5 }),
      /packageDir must be a directory/,
    );
    assert.throws(() => testProviderKind({ kind: 'systemone-generic', appDir: '' }), /appDir must be a directory/);
    assert.throws(() => testProviderKind({ kind: 'systemone-generic', settings: [] }), /settings must be an object/);
    assert.throws(
      () => testProviderKind({ kind: 'systemone-generic', credentials: 'x' }),
      /credentials must be an object/,
    );
  });
});
