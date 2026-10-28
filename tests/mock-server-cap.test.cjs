const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');
const { startMockServer } = require('../dist/mock-server');

const servers = [];
async function mock(options) {
  const lines = [];
  const server = await startMockServer({ port: 0, log: (line) => lines.push(line), ...options });
  servers.push(server);
  return { ...server, lines };
}
after(() => Promise.all(servers.map((server) => server.close())));

// Runs decide() in a temporary production app against the settings and prints one JSON line.
async function decide(decisions) {
  const dir = createApp({ name: 'mock-server-app', private: true, cds: { requires: { decisions } } });
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const request = {
      state: 'I was billed twice. Please refund me.',
      questions: {
        department: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
        },
        refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
      },
    };
    (async () => {
      await cds.plugins;
      try {
        const srv = await cds.connect.to('decisions');
        out(await srv.decide(request));
      } catch (e) { out({ error: e.code || e.name, message: e.message, status: e.status, providerCode: e.providerCode }); }
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script, { env: { CDS_ENV: 'production' }, timeout: 60_000 });
  } finally {
    removeApp(dir);
  }
}
const generic = (server, extra = {}) => ({
  kind: 'decisions-generic',
  credentials: { url: server.url },
  ...extra,
});
const cloudflare = (server, token = 't') => ({
  kind: 'decisions-cloudflare',
  credentials: { url: server.url, token },
});

describe('cap-decisions against the mock server', { concurrency: true }, () => {
  test('decisions-generic gets the answer', async () => {
    const server = await mock();
    const result = await decide(generic(server));
    assert.equal(result.model, 'mock');
    assert.equal(result.answers.department.choice, 'billing');
    assert.equal(result.answers.refund.type, 'noul');
    assert.equal(server.lines.length, 1);
  });

  test('HTTP_ERROR 503 is retried and keeps status and providerCode', async () => {
    const server = await mock({ fail: { code: 'HTTP_ERROR', status: 503, providerCode: 'overloaded' } });
    const result = await decide(generic(server));
    assert.equal(result.error, 'HTTP_ERROR', JSON.stringify(result));
    assert.equal(result.status, 503);
    assert.equal(result.providerCode, 'overloaded');
    assert.equal(server.lines.length, 3);
  });

  test('HTTP_ERROR 400 is not retried', async () => {
    const server = await mock({ fail: { code: 'HTTP_ERROR', status: 400 } });
    const result = await decide(generic(server));
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, 400);
    assert.equal(result.providerCode, 'mock_error');
    assert.equal(server.lines.length, 1);
  });

  test('NETWORK_ERROR', async () => {
    const server = await mock({ fail: 'NETWORK_ERROR' });
    const result = await decide(generic(server));
    assert.equal(result.error, 'NETWORK_ERROR', JSON.stringify(result));
  });

  test('TIMEOUT', async () => {
    const server = await mock({ fail: 'TIMEOUT' });
    const result = await decide(generic(server, { timeoutMs: 500 }));
    assert.equal(result.error, 'TIMEOUT', JSON.stringify(result));
  });

  test('INVALID_RESPONSE', async () => {
    const server = await mock({ fail: 'INVALID_RESPONSE' });
    const result = await decide(generic(server));
    assert.equal(result.error, 'INVALID_RESPONSE', JSON.stringify(result));
    assert.equal(server.lines.length, 1);
  });

  test('PROVIDER_ERROR in jev format is an HTTP_ERROR 500', async () => {
    const server = await mock({ fail: { code: 'PROVIDER_ERROR', providerCode: 'E42' } });
    const result = await decide(generic(server));
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, 500);
    assert.equal(result.providerCode, 'E42');
  });

  test('a fixture rule answers through the server', async () => {
    const server = await mock({ rules: [{ when: { question: 'department' }, answer: { choice: 'technical' } }] });
    const result = await decide(generic(server));
    assert.equal(result.answers.department.choice, 'technical');
  });

  test('decisions-cloudflare gets the unwrapped answer through format cloudflare', async () => {
    const server = await mock({ format: 'cloudflare', token: 't' });
    const result = await decide(cloudflare(server));
    assert.equal(result.model, 'mock');
    assert.equal(result.answers.department.choice, 'billing');
  });

  test('decisions-cloudflare maps PROVIDER_ERROR with its providerCode', async () => {
    const server = await mock({ format: 'cloudflare', fail: { code: 'PROVIDER_ERROR', providerCode: 'E42' } });
    const result = await decide(cloudflare(server));
    assert.equal(result.error, 'PROVIDER_ERROR', JSON.stringify(result));
    assert.equal(result.providerCode, 'E42');
    assert.equal(server.lines.length, 1);
  });

  test('decisions-cloudflare finds the code of an HTTP error in the envelope', async () => {
    const server = await mock({
      format: 'cloudflare',
      fail: { code: 'HTTP_ERROR', status: 403, providerCode: 'denied' },
    });
    const result = await decide(cloudflare(server));
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, 403);
    assert.equal(result.providerCode, 'denied');
  });

  test('a wrong token is HTTP_ERROR 401', async () => {
    const server = await mock({ token: 'right' });
    const result = await decide({ kind: 'decisions-generic', credentials: { url: server.url, token: 'wrong' } });
    assert.equal(result.error, 'HTTP_ERROR', JSON.stringify(result));
    assert.equal(result.status, 401);
    assert.equal(result.providerCode, 'authentication_error');
    assert.equal(server.lines.length, 1);
  });

  test('the right token gets the answer', async () => {
    const server = await mock({ token: 'right' });
    const result = await decide({ kind: 'decisions-generic', credentials: { url: server.url, token: 'right' } });
    assert.equal(result.model, 'mock');
  });
});
