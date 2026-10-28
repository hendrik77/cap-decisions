const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');
const { startServer, noulResult } = require('./helpers/fake-server.cjs');

const providerPackage = path.resolve(__dirname, '../examples/provider-package');

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());
const reset = (handler) => {
  server.received.length = 0;
  server.requests.length = 0;
  server.setHandler(handler);
};
const reply = (payload) => (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
};

// Runs `body` inside an async function of a temporary app; the body prints one JSON line through out().
async function inApp(decisions, body, { files, links, dependencies } = {}) {
  const dir = createApp(
    { name: 'extension-app', private: true, dependencies, cds: { requires: { decisions } } },
    files,
    { links },
  );
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const fail = (e) => out({ error: e.code || e.name, message: e.message });
    const request = { state: 'Refund me', questions: { answer: { type: 'noul', instructions: 'Refund?' } } };
    (async () => {
      await cds.plugins;
      try {
        ${body}
      } catch (e) { fail(e); }
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script);
  } finally {
    removeApp(dir);
  }
}

const connect = `const srv = await cds.connect.to('decisions');`;
const decide = `${connect}
  out(await srv.decide(request));`;
const acmeApp = (credentials, extra = {}) => ({
  decisions: { kind: 'decisions-acme', ...extra, credentials },
  options: {
    links: { 'cap-decisions-provider-acme': providerPackage },
    dependencies: { 'cap-decisions-provider-acme': '*' },
  },
});
const inAcmeApp = (credentials, body, extra) => {
  const { decisions, options } = acmeApp(credentials, extra);
  return inApp(decisions, body, options);
};

const envelopeSubclass = `
const { DecisionsService, DecisionsError } = require('cap-decisions');

class AcmeDecisions extends DecisionsService {
  endpoint(credentials) {
    return credentials.url;
  }

  unwrap(payload) {
    if (!payload || typeof payload !== 'object' || !('envelope' in payload)) {
      throw new DecisionsError('INVALID_RESPONSE', 'Acme response is missing envelope');
    }
    return payload.envelope;
  }
}

module.exports = AcmeDecisions;
`;

describe('app-local subclass', () => {
  test('is loaded through impl and unwraps the envelope', async () => {
    reset(reply({ envelope: noulResult }));
    const result = await inApp(
      { kind: 'decisions-generic', impl: 'srv/acme-decisions.js', credentials: { url: server.url } },
      `${connect}
       const result = await srv.decide(request);
       out({ name: srv.constructor.name, result });`,
      { files: { 'srv/acme-decisions.js': envelopeSubclass } },
    );
    assert.equal(result.name, 'AcmeDecisions');
    assert.deepEqual(result.result, noulResult);
    assert.equal(server.received.length, 1);
  });

  test('an answer without the envelope fails with INVALID_RESPONSE', async () => {
    reset();
    const result = await inApp(
      { kind: 'decisions-generic', impl: 'srv/acme-decisions.js', credentials: { url: server.url } },
      decide,
      { files: { 'srv/acme-decisions.js': envelopeSubclass } },
    );
    assert.equal(result.error, 'INVALID_RESPONSE');
  });
});

describe('app-local subclass without a transport', () => {
  test('a setup that does not create the transport fails with INVALID_CONFIG', async () => {
    const subclass = `
const { DecisionsService } = require('cap-decisions');
module.exports = class NoTransport extends DecisionsService {
  async setup() {}
};`;
    reset();
    const result = await inApp(
      { kind: 'decisions-generic', impl: 'srv/no-transport.js', credentials: { url: server.url } },
      decide,
      { files: { 'srv/no-transport.js': subclass } },
    );
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /setup\(\) did not create the transport/);
    assert.equal(server.received.length, 0);
  });
});

describe('provider package', () => {
  const credentials = () => ({ url: server.url, token: 't', region: 'eu' });

  test('the decisions-acme kind decides through the fake server with the bearer token', async () => {
    reset(reply({ data: noulResult }));
    const result = await inAcmeApp(
      credentials(),
      `${connect}
      out({ name: srv.constructor.name, result: await srv.decide(request) });`,
    );
    assert.equal(result.name, 'AcmeService');
    assert.deepEqual(result.result, noulResult);
    assert.equal(server.requests[0].headers.authorization, 'Bearer t');
  });

  test('a response without data fails with INVALID_RESPONSE', async () => {
    reset();
    assert.equal((await inAcmeApp(credentials(), decide)).error, 'INVALID_RESPONSE');
  });

  test('the kind requires a token', async () => {
    const result = await inAcmeApp({ url: server.url, region: 'eu' }, connect + `out({ ok: true });`);
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /token/);
  });

  test('without url and region the endpoint fails with INVALID_CONFIG', async () => {
    reset();
    const result = await inAcmeApp({ token: 't' }, decide);
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /region/);
    assert.equal(server.received.length, 0);
  });

  test('the kind limit of 20 choice options applies before any request', async () => {
    reset(reply({ data: noulResult }));
    const result = await inAcmeApp(
      credentials(),
      `${connect}
       const criteria = Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['option' + i, 'Option ' + i]));
       await srv.decide({ state: 'x', questions: { pick: { type: 'choice', instructions: 'Pick', criteria } } });`,
    );
    assert.equal(result.error, 'INVALID_REQUEST');
    assert.equal(server.received.length, 0);
  });

  test('the region credential produces no warning', async () => {
    const result = await inAcmeApp(
      credentials(),
      `const warnings = [];
       cds.log('decisions').warn = (...args) => warnings.push(args.join(' '));
       ${connect}
       out({ warnings });`,
    );
    assert.deepEqual(result, { warnings: [] });
  });

  test('an unknown credential key fails with INVALID_CONFIG', async () => {
    const result = await inAcmeApp({ ...credentials(), foo: 'x' }, connect + `out({ ok: true });`);
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /foo/);
  });

  test('a region credential is rejected by the base service, which does not list it', async () => {
    const result = await inApp(
      { kind: 'decisions-generic', credentials: { url: server.url, region: 'eu' } },
      connect + `out({ ok: true });`,
    );
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /region/);
  });

  test('the package and the app share one cap-decisions and one @sap/cds instance', async () => {
    const result = await inAcmeApp(
      credentials(),
      `const fs = require('node:fs');
       const path = require('node:path');
       const providerDir = fs.realpathSync(path.join(process.cwd(), 'node_modules/cap-decisions-provider-acme'));
       const real = (file) => fs.realpathSync(file);
       const fromProvider = (name) => real(require.resolve(name, { paths: [providerDir] }));
       ${connect}
       const { DecisionsService } = require('cap-decisions');
       out({
         providerDir,
         capJev: [fromProvider('cap-decisions'), real(require.resolve('cap-decisions'))],
         cds: [fromProvider('@sap/cds'), real(require.resolve('@sap/cds'))],
         instance: srv instanceof DecisionsService,
       });`,
    );
    assert.equal(result.providerDir, providerPackage);
    assert.equal(result.capJev[0], result.capJev[1]);
    assert.equal(result.cds[0], result.cds[1]);
    assert.equal(result.instance, true);
  });
});
