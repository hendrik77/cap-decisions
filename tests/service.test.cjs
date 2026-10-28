const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');
const { startServer, noulResult } = require('./helpers/fake-server.cjs');

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());
const reset = () => {
  server.received.length = 0;
  server.requests.length = 0;
  server.setHandler(undefined);
};

// Runs `body` inside an async function of a temporary app; the body prints one JSON line through out().
async function inApp(decisions, body, { files, env, extra } = {}) {
  const dir = createApp(
    { name: 'service-app', private: true, cds: decisions === undefined ? {} : { requires: { decisions } }, ...extra },
    files,
  );
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const fail = (e) => out({ error: e.code || e.name, message: e.message, status: e.status, providerCode: e.providerCode });
    const request = { state: 'Refund me', questions: { answer: { type: 'noul', instructions: 'Refund?' } } };
    (async () => {
      await cds.plugins;
      try {
        ${body}
      } catch (e) { fail(e); }
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script, { env });
  } finally {
    removeApp(dir);
  }
}

const connect = `const srv = await cds.connect.to('decisions');`;
const invalidConfig = (message) => ({ error: 'INVALID_CONFIG', message: message ?? /./ });
const expectError = (actual, expected) => {
  assert.equal(actual.error, expected.error);
  if (expected.message instanceof RegExp) assert.match(actual.message, expected.message);
};

describe('connecting', () => {
  test('TypeSafe without a token fails with INVALID_CONFIG', async () => {
    expectError(await inApp({ kind: 'decisions-typesafe' }, connect + `out({ ok: true });`), invalidConfig(/token/));
  });

  test('Cloudflare without a token fails with INVALID_CONFIG', async () => {
    const result = await inApp({ kind: 'decisions-cloudflare', credentials: { accountId: 'a' } }, connect);
    expectError(result, invalidConfig(/token/));
  });

  test('Cloudflare with a token but no accountId and no url fails with INVALID_CONFIG', async () => {
    const result = await inApp({ kind: 'decisions-cloudflare', credentials: { token: 't' } }, connect);
    expectError(result, invalidConfig(/accountId/));
  });

  test('a token over non-loopback HTTP fails with INVALID_CONFIG', async () => {
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: 'http://example.com/x', token: 't' } },
      connect,
    );
    expectError(result, invalidConfig(/HTTPS or a loopback/));
  });

  test('an application without decisions configuration fails in production (no URL)', async () => {
    const result = await inApp(undefined, connect, { env: { CDS_ENV: 'production' } });
    expectError(result, invalidConfig(/endpoint URL/));
  });

  test('the model setting does not connect', async () => {
    // CAP reads model as a CDS model and fails first (MODEL_NOT_FOUND); the settings check names modelId when
    // the service is created without that lookup, see tests/validation.test.cjs.
    const result = await inApp({ kind: 'decisions-generic', model: 'x', credentials: { url: server.url } }, connect);
    assert.ok(result.error);
    const direct = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `const { DecisionsService } = require('cap-decisions');
       const srv = new DecisionsService('decisions', undefined, { model: 'x', timeoutMs: 1000, credentials: { url: ${JSON.stringify(server.url)} } });
       await srv.init();
       out({ ok: true });`,
    );
    expectError(direct, invalidConfig(/modelId/));
  });

  test('misplaced secrets fail with INVALID_CONFIG', async () => {
    const result = await inApp({ kind: 'decisions-generic', token: 'x', credentials: { url: server.url } }, connect);
    expectError(result, invalidConfig(/credentials/));
  });

  test('Laya and generic with a url connect without a token', async () => {
    assert.deepEqual(await inApp({ kind: 'decisions-laya' }, connect + `out({ ok: true });`), { ok: true });
    assert.deepEqual(
      await inApp({ kind: 'decisions-generic', credentials: { url: server.url } }, connect + `out({ ok: true });`),
      { ok: true },
    );
  });

  test('an unknown setting logs a warning and the connection still succeeds', async () => {
    const result = await inApp(
      { kind: 'decisions-generic', bogus: 1, credentials: { url: server.url } },
      `const warnings = [];
       cds.log('decisions').warn = (...args) => warnings.push(args.join(' '));
       ${connect}
       out({ connected: srv instanceof cds.Service, warnings });`,
    );
    assert.equal(result.connected, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /bogus/);
  });
});

describe('decision flow', () => {
  test('limits reject before any request reaches the server', async () => {
    reset();
    const result = await inApp(
      { kind: 'decisions-laya', credentials: { url: server.url } },
      `${connect}
       const criteria = Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['option' + i, 'x']));
       await srv.decide({ state: 'x', questions: { q: { type: 'choice', instructions: 'Choose', criteria } } });
       out({ ok: true });`,
    );
    assert.equal(result.error, 'INVALID_REQUEST');
    assert.equal(server.received.length, 0);
  });

  test('modelId is sent as model and omitted when unset', async () => {
    reset();
    const call = `${connect} const result = await srv.decide(request); out({ model: result.model });`;
    const withModel = await inApp(
      { kind: 'decisions-generic', modelId: 'jev-latest', credentials: { url: server.url } },
      call,
    );
    assert.deepEqual(withModel, { model: 'fake-model' });
    assert.equal(server.received[0].model, 'jev-latest');
    await inApp({ kind: 'decisions-generic', credentials: { url: server.url } }, call);
    assert.equal('model' in server.received[1], false);
  });

  test('a token is sent as bearer authorization', async () => {
    reset();
    await inApp(
      { kind: 'decisions-generic', requiresToken: true, credentials: { url: server.url, token: 'secret' } },
      `${connect} await srv.decide(request); out({});`,
    );
    assert.equal(server.requests[0].headers.authorization, 'Bearer secret');
  });

  test('before and after handlers run on decide', async () => {
    reset();
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `${connect}
       const seen = [];
       srv.before('decide', (req) => { seen.push('before'); req.data.state = 'modified state'; });
       srv.after('decide', (res) => { seen.push('after:' + res.model); });
       await srv.decide(request);
       out({ seen });`,
    );
    assert.deepEqual(result.seen, ['before', 'after:fake-model']);
    assert.equal(server.received[0].state, 'modified state');
  });

  test('caller cancellation gives ABORTED', async () => {
    reset();
    server.setHandler((_req, res) => setTimeout(() => res.end(JSON.stringify(noulResult)), 300));
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `${connect}
       const controller = new AbortController();
       const pending = srv.decide(request, { signal: controller.signal });
       setTimeout(() => controller.abort(), 20);
       await pending;
       out({ ok: true });`,
    );
    assert.equal(result.error, 'ABORTED');
  });

  test('the debug log has attempts, model and usage but no request data', async () => {
    reset();
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `${connect}
       const logs = [];
       cds.log('decisions').debug = (...args) => logs.push(args);
       await srv.decide({ state: 'private state', questions: { answer: { type: 'noul', instructions: 'Secret question?' } } });
       out({ logs });`,
    );
    assert.equal(result.logs.length, 1);
    const details = result.logs[0][1];
    assert.equal(details.attempts, 1);
    assert.equal(details.model, 'fake-model');
    assert.deepEqual(details.usage, { input_tokens: 3, output_tokens: 1 });
    assert.equal(typeof details.latencyMs, 'number');
    const text = JSON.stringify(result.logs);
    assert.equal(text.includes('private state') || text.includes('Secret question'), false);
  });

  test('an invalid provider response fails with INVALID_RESPONSE end to end', async () => {
    reset();
    server.setHandler((_req, res) =>
      res.end(JSON.stringify({ ...noulResult, answers: { answer: { type: 'noul', noul: 2 } } })),
    );
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `${connect} await srv.decide(request); out({ ok: true });`,
    );
    assert.equal(result.error, 'INVALID_RESPONSE');
  });

  test('an HTTP error carries status and providerCode', async () => {
    reset();
    server.setHandler((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'secret details' } }));
    });
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url } },
      `${connect} await srv.decide(request); out({ ok: true });`,
    );
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, 400);
    assert.equal(result.providerCode, 'invalid_request');
    assert.equal(result.message.includes('secret'), false);
  });
});

describe('subclass contract', () => {
  const custom = `const { DecisionsService } = require('cap-decisions');
module.exports = class extends DecisionsService {
  async call() {
    globalThis.__calls = (globalThis.__calls || 0) + 1;
    const noul = process.env.CUSTOM_MODE === 'invalid' ? 2 : 0.5;
    return {
      result: { model: 'custom', answers: { answer: { type: 'noul', noul } }, usage: { input_tokens: 1, output_tokens: 1 } },
      attempts: 1,
    };
  }
};`;
  const config = () => ({ kind: 'decisions-generic', impl: 'srv/custom.js', credentials: { url: server.url } });

  test('a result returned by call() is validated by the base class', async () => {
    const files = { 'srv/custom.js': custom };
    const run = (mode) =>
      inApp(config(), `${connect} const result = await srv.decide(request); out({ model: result.model });`, {
        files,
        env: { CUSTOM_MODE: mode },
      });
    assert.deepEqual(await run('valid'), { model: 'custom' });
    assert.equal((await run('invalid')).error, 'INVALID_RESPONSE');
  });

  test('an invalid request never reaches call()', async () => {
    const result = await inApp(
      config(),
      `${connect}
       let error;
       try { await srv.decide({ state: 'x', questions: {} }); } catch (e) { error = e.code; }
       out({ error, calls: globalThis.__calls || 0 });`,
      { files: { 'srv/custom.js': custom } },
    );
    assert.deepEqual(result, { error: 'INVALID_REQUEST', calls: 0 });
  });

  test('a subclass overriding endpoint, unwrap and errorCode is used for HTTP', async () => {
    reset();
    const envelope = `const { DecisionsService } = require('cap-decisions');
module.exports = class extends DecisionsService {
  endpoint(credentials) { return credentials.url + '/wrapped'; }
  unwrap(payload) { return payload.data; }
  errorCode(payload) { return payload && payload.code; }
};`;
    server.setHandler((_req, res) => res.end(JSON.stringify({ data: noulResult })));
    const ok = await inApp(
      config(),
      `${connect} const result = await srv.decide(request); out({ model: result.model });`,
      { files: { 'srv/custom.js': envelope } },
    );
    assert.deepEqual(ok, { model: 'fake-model' });
    assert.equal(server.requests[0].url, '/v1/systemone/wrapped');
    server.setHandler((_req, res) => {
      res.writeHead(500);
      res.end(JSON.stringify({ code: 'E42' }));
    });
    const failed = await inApp(config(), `${connect} await srv.decide(request); out({ ok: true });`, {
      files: { 'srv/custom.js': envelope },
    });
    assert.equal(failed.error, 'HTTP_ERROR');
    assert.equal(failed.providerCode, 'E42');
  });
});
