const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

const pick = `(s) => ({ impl: s.impl, modelId: s.modelId, requiresToken: s.requiresToken, limits: s.limits, url: s.credentials && s.credentials.url, timeoutMs: s.timeoutMs })`;
const resolveScript = `const cds = require('@sap/cds');
  cds.plugins.then(() => console.log(JSON.stringify((${pick})(cds.env.requires.systemone))));`;

async function resolveSettings(systemone, env = {}) {
  const dir = createApp({ name: 'kinds-app', private: true, cds: systemone ? { requires: { systemone } } : {} });
  try {
    return await runInApp(dir, resolveScript, { env });
  } finally {
    removeApp(dir);
  }
}

const typesafeLimits = { choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } };
// CAP replaces `kind` with the last kind of the chain (systemone-defaults), so the selected kind is checked through
// its settings instead.
const expected = {
  'systemone-generic': { impl: 'cap-jev', timeoutMs: 10000 },
  'systemone-typesafe': {
    impl: 'cap-jev',
    timeoutMs: 10000,
    modelId: 'jev-latest',
    requiresToken: true,
    limits: typesafeLimits,
    url: 'https://api.typesafe.ai/v1/systemone',
  },
  'systemone-cloudflare': {
    impl: 'cap-jev/providers/cloudflare',
    timeoutMs: 10000,
    modelId: 'clef',
    requiresToken: true,
    limits: { questions: 64 },
  },
  'systemone-subq': {
    impl: 'cap-jev/providers/subq',
    timeoutMs: 10000,
    modelId: 'subq-snap-preview',
    requiresToken: true,
    limits: { questions: 16, choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } },
    url: 'https://api.subq.ai/v1/systemone',
  },
  'systemone-laya': {
    impl: 'cap-jev',
    timeoutMs: 10000,
    limits: { choiceOptions: 100 },
    url: 'http://127.0.0.1:8000/v1/systemone',
  },
};

for (const [kind, settings] of Object.entries(expected)) {
  test(`${kind} resolves its provider settings`, async () => {
    assert.deepEqual(await resolveSettings({ kind }), settings);
  });
}

test('an application without a systemone entry resolves the generic kind in production', async () => {
  const settings = await resolveSettings(undefined, { CDS_ENV: 'production' });
  assert.equal(settings.impl, 'cap-jev');
  assert.equal(settings.url, undefined);
});

test('an application without a systemone entry resolves the mock kind in development and test', async () => {
  for (const profile of ['development', 'test']) {
    const settings = await resolveSettings(undefined, { CDS_ENV: profile });
    assert.equal(settings.impl, 'cap-jev/providers/mock', profile);
    assert.equal(settings.timeoutMs, 10000, profile);
  }
});

test('profiles switch the kind and production keeps the base kind', async () => {
  const systemone = { kind: 'systemone-typesafe', '[development]': { kind: 'systemone-laya' } };
  const development = await resolveSettings(systemone, { CDS_ENV: 'development' });
  assert.deepEqual(development, expected['systemone-laya']);
  const production = await resolveSettings(systemone, { CDS_ENV: 'production' });
  assert.deepEqual(production, expected['systemone-typesafe']);
});

test('application settings deep-merge over the kind settings', async () => {
  const settings = await resolveSettings({ kind: 'systemone-typesafe', limits: { choiceOptions: 300 } });
  assert.deepEqual(settings.limits, { choiceOptions: 300, scoreCriteria: { min: 2, max: 10 } });
  assert.equal(settings.modelId, 'jev-latest');
});

test('cds.connect.to resolves TypeSafe with its own settings', async () => {
  const dir = createApp({
    name: 'typesafe-app',
    private: true,
    cds: { requires: { systemone: { kind: 'systemone-typesafe', credentials: { token: 't' } } } },
  });
  try {
    const result = await runInApp(
      dir,
      `const cds = require('@sap/cds');
       (async () => {
         await cds.plugins;
         const srv = await cds.connect.to('systemone');
         console.log(JSON.stringify({
           modelId: srv.options.modelId,
           instance: srv instanceof require('cap-jev').SystemOneService,
           name: srv.constructor.name,
         }));
       })().catch((e) => console.log(JSON.stringify({ error: e.code || e.name, message: e.message })));`,
    );
    assert.deepEqual(result, { modelId: 'jev-latest', instance: true, name: 'SystemOneService' });
  } finally {
    removeApp(dir);
  }
});

test('cds.connect.to resolves Cloudflare with its subclass', async () => {
  const dir = createApp({
    name: 'cloudflare-app',
    private: true,
    cds: { requires: { systemone: { kind: 'systemone-cloudflare', credentials: { token: 't', accountId: 'a' } } } },
  });
  try {
    const result = await runInApp(
      dir,
      `const cds = require('@sap/cds');
       (async () => {
         await cds.plugins;
         const srv = await cds.connect.to('systemone');
         console.log(JSON.stringify({
           modelId: srv.options.modelId,
           instance: srv instanceof require('cap-jev').SystemOneService,
           name: srv.constructor.name,
         }));
       })().catch((e) => console.log(JSON.stringify({ error: e.code || e.name, message: e.message })));`,
    );
    assert.deepEqual(result, { modelId: 'clef', instance: true, name: 'CloudflareService' });
  } finally {
    removeApp(dir);
  }
});

test('cds.connect.to resolves SubQ with its subclass', async () => {
  const dir = createApp({
    name: 'subq-app',
    private: true,
    cds: { requires: { systemone: { kind: 'systemone-subq', credentials: { token: 't' } } } },
  });
  try {
    const result = await runInApp(
      dir,
      `const cds = require('@sap/cds');
       (async () => {
         await cds.plugins;
         const srv = await cds.connect.to('systemone');
         console.log(JSON.stringify({
           modelId: srv.options.modelId,
           instance: srv instanceof require('cap-jev').SystemOneService,
           name: srv.constructor.name,
         }));
       })().catch((e) => console.log(JSON.stringify({ error: e.code || e.name, message: e.message })));`,
    );
    assert.deepEqual(result, { modelId: 'subq-snap-preview', instance: true, name: 'SubqService' });
  } finally {
    removeApp(dir);
  }
});
