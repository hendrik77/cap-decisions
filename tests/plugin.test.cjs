const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

// Loads the plugins of a temporary app with a collector in place of the decisions error log.
async function loadPlugins(decisions, requires = { decisions }) {
  const dir = createApp({ name: 'plugin-app', private: true, cds: { requires } });
  const script = `
    const cds = require('@sap/cds');
    const errors = [];
    cds.log('decisions').error = (...args) => errors.push(args.join(' '));
    (async () => {
      await cds.plugins;
      console.log(JSON.stringify({ errors }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script);
  } finally {
    removeApp(dir);
  }
}

describe('cds-plugin.js', () => {
  test('logs one error naming modelId when model is configured, and does not throw', async () => {
    const { errors } = await loadPlugins({ kind: 'decisions-generic', model: 'x' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /modelId/);
    assert.match(errors[0], /model/);
  });

  test('logs one error when the service is still configured as systemone, the name before 0.10.0', async () => {
    const { errors } = await loadPlugins(undefined, { systemone: { kind: 'systemone-laya' } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cds\.requires\.systemone/);
    assert.match(errors[0], /renamed to decisions in 0\.10\.0/);
    assert.match(errors[0], /Migrating from cap-jev/);
  });

  test('logs nothing without a model setting', async () => {
    assert.deepEqual(await loadPlugins({ kind: 'decisions-generic', modelId: 'x' }), { errors: [] });
  });
});

// Loads the plugins of a temporary app with a stubbed command line (`cds.cli`) and a stubbed `cds.add`.
// `setup` is a script fragment that runs before the plugins load.
async function loadWithStub(setup) {
  const dir = createApp({ name: 'plugin-add-app', private: true });
  const script = `
    const cds = require('@sap/cds');
    const errors = [];
    const registered = [];
    cds.log('decisions').error = (...args) => errors.push(args.join(' '));
    ${setup}
    (async () => {
      await cds.plugins;
      const loaded = Object.keys(require.cache).some((file) => /[\\\\/]dist[\\\\/]add\\.js$/.test(file));
      console.log(JSON.stringify({ errors, registered, loaded }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script);
  } finally {
    removeApp(dir);
  }
}

const stubAdd = `
  class Plugin {}
  cds.add = {
    Plugin,
    register(name, Class) {
      registered.push({
        name,
        help: Class.help(),
        options: Object.keys(Class.prototype.options.call({})),
        isPlugin: Class.prototype instanceof Plugin,
      });
    },
  };`;

describe('cds-plugin.js and cds add', () => {
  test('registers the decisions facet for cds add', async () => {
    const result = await loadWithStub(`cds.cli = { command: 'add' }; ${stubAdd}`);
    assert.deepEqual(result.errors, []);
    assert.equal(result.registered.length, 1);
    assert.equal(result.registered[0].name, 'decisions');
    assert.match(result.registered[0].help, /Decision models/);
    assert.deepEqual(result.registered[0].options, ['kind', 'with-fixtures']);
    assert.equal(result.registered[0].isPlugin, true);
    assert.equal(result.loaded, true);
  });

  test('registers the decisions facet for cds help, which loads the plugins for cds add --help', async () => {
    const result = await loadWithStub(`cds.cli = { command: 'help' }; ${stubAdd}`);
    assert.deepEqual(result.errors, []);
    assert.equal(result.registered[0]?.name, 'decisions');
  });

  test('does not register or load the facet for other commands', async () => {
    const result = await loadWithStub(`cds.cli = { command: 'watch' }; ${stubAdd}`);
    assert.deepEqual(result, { errors: [], registered: [], loaded: false });
  });

  test('does not register or load the facet without a command line', async () => {
    const result = await loadWithStub(stubAdd);
    assert.deepEqual(result, { errors: [], registered: [], loaded: false });
  });

  test('does not read cds.add for other commands', async () => {
    const result = await loadWithStub(`
      cds.cli = { command: 'watch' };
      Object.defineProperty(cds, 'add', { get() { throw new Error('cds.add was read'); }, configurable: true });`);
    assert.deepEqual(result, { errors: [], registered: [], loaded: false });
  });

  test('does not register or throw without cds.add', async () => {
    const result = await loadWithStub(`cds.cli = { command: 'add' };`);
    assert.deepEqual(result, { errors: [], registered: [], loaded: false });
  });

  test('logs one error and does not throw when registering fails', async () => {
    const result = await loadWithStub(`
      cds.cli = { command: 'add' };
      cds.add = { Plugin: class {}, register() { throw new Error('boom'); } };`);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /boom/);
    assert.match(result.errors[0], /cds add decisions/);
    assert.deepEqual(result.registered, []);
  });
});
