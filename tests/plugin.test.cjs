const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

// Loads the plugins of a temporary app with a collector in place of the systemone error log.
async function loadPlugins(systemone) {
  const dir = createApp({ name: 'plugin-app', private: true, cds: { requires: { systemone } } });
  const script = `
    const cds = require('@sap/cds');
    const errors = [];
    cds.log('systemone').error = (...args) => errors.push(args.join(' '));
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
    const { errors } = await loadPlugins({ kind: 'systemone-generic', model: 'x' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /modelId/);
    assert.match(errors[0], /model/);
  });

  test('logs nothing without a model setting', async () => {
    assert.deepEqual(await loadPlugins({ kind: 'systemone-generic', modelId: 'x' }), { errors: [] });
  });
});
