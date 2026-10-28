const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

const root = path.resolve(__dirname, '..');

test('temporary apps resolve the local cap-decisions and a single @sap/cds', async () => {
  const dir = createApp({
    name: 'x',
    private: true,
    dependencies: { 'cap-decisions': '*', '@sap/cds': '*' },
    cds: { requires: { decisions: { kind: 'decisions-laya' } } },
  });
  try {
    const result = await runInApp(
      dir,
      `const cds = require('@sap/cds');
       cds.plugins.then(() => console.log(JSON.stringify({
         kind: cds.env.requires.decisions.kind,
         resolved: require.resolve('cap-decisions'),
         cdsPath: require.resolve('@sap/cds'),
       })));`,
    );
    assert.equal(typeof result.kind, 'string');
    assert.equal(fs.realpathSync(result.resolved), path.join(fs.realpathSync(root), 'dist/index.js'));
    assert.equal(
      path
        .dirname(fs.realpathSync(result.cdsPath))
        .startsWith(fs.realpathSync(path.join(root, 'node_modules/@sap/cds'))),
      true,
    );
  } finally {
    removeApp(dir);
  }
});

test('runInApp reports stderr when the script fails', async () => {
  const dir = createApp({ name: 'x', private: true });
  try {
    await assert.rejects(runInApp(dir, "throw new Error('boom')"), /boom/);
  } finally {
    removeApp(dir);
  }
});
