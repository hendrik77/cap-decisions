const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');
const { startServer, noulResult } = require('./helpers/fake-server.cjs');

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());

async function inApp(credentials, body) {
  const dir = createApp({
    name: 'cloudflare-app',
    private: true,
    cds: { requires: { decisions: { kind: 'decisions-cloudflare', credentials } } },
  });
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const request = { state: 'Refund me', questions: { answer: { type: 'noul', instructions: 'Refund?' } } };
    (async () => {
      await cds.plugins;
      try {
        const srv = await cds.connect.to('decisions');
        ${body}
      } catch (e) { out({ error: e.code || e.name, message: e.message, status: e.status, providerCode: e.providerCode }); }
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script);
  } finally {
    removeApp(dir);
  }
}

const decide = `const result = await srv.decide(request); out({ model: result.model });`;
const withUrl = () => ({ token: 't', url: server.url });

test('builds the endpoint from an encoded accountId', async () => {
  const result = await inApp(
    { token: 't', accountId: 'a/b c' },
    `out({
       url: srv.endpoint({ accountId: 'a/b c' }),
       plain: srv.endpoint({ accountId: 'acct' }),
     });`,
  );
  assert.equal(result.url, 'https://api.cloudflare.com/client/v4/accounts/a%2Fb%20c/ai/run/@cf/cloudflare/clef');
  assert.equal(result.plain, 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef');
});

test('an explicit URL wins over accountId and a missing accountId is INVALID_CONFIG', async () => {
  const result = await inApp(
    { token: 't', accountId: 'a' },
    `let error;
     try { srv.endpoint({}); } catch (e) { error = e.code; }
     out({ explicit: srv.endpoint({ url: 'http://127.0.0.1:1/x', accountId: 'a' }), error });`,
  );
  assert.deepEqual(result, { explicit: 'http://127.0.0.1:1/x', error: 'INVALID_CONFIG' });
});

test('sends model and token to the explicit URL and unwraps the result', async () => {
  server.received.length = 0;
  server.requests.length = 0;
  server.setHandler((_req, res) => res.end(JSON.stringify({ success: true, result: noulResult })));
  assert.deepEqual(await inApp(withUrl(), decide), { model: 'fake-model' });
  assert.equal(server.received[0].model, 'clef');
  assert.equal(server.requests[0].headers.authorization, 'Bearer t');
});

test('success false is a PROVIDER_ERROR with the providerCode', async () => {
  server.setHandler((_req, res) =>
    res.end(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'secret details' }] })),
  );
  const result = await inApp(withUrl(), decide);
  assert.equal(result.error, 'PROVIDER_ERROR');
  assert.equal(result.providerCode, 1001);
  assert.equal(result.message.includes('secret'), false);
});

test('a missing result is INVALID_RESPONSE', async () => {
  server.setHandler((_req, res) => res.end(JSON.stringify({ success: true })));
  assert.equal((await inApp(withUrl(), decide)).error, 'INVALID_RESPONSE');
});

test('a null result is INVALID_RESPONSE with the missing result message', async () => {
  server.setHandler((_req, res) => res.end(JSON.stringify({ success: true, result: null })));
  const result = await inApp(withUrl(), decide);
  assert.equal(result.error, 'INVALID_RESPONSE');
  assert.equal(result.message, 'Cloudflare response is missing result');
});

test('a response that is not an object is INVALID_RESPONSE', async () => {
  for (const body of ['"text"', 'null', '[1]']) {
    server.setHandler((_req, res) => res.end(body));
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'INVALID_RESPONSE', body);
  }
});

test('an invalid provider code is not exposed', async () => {
  server.setHandler((_req, res) =>
    res.end(JSON.stringify({ success: false, errors: [{ code: 'has spaces and secrets' }] })),
  );
  const result = await inApp(withUrl(), decide);
  assert.equal(result.error, 'PROVIDER_ERROR');
  assert.equal(result.providerCode, undefined);
});

test('an HTTP error reads errors[0].code into providerCode', async () => {
  server.setHandler((_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'secret details' }] }));
  });
  const result = await inApp(withUrl(), decide);
  assert.equal(result.error, 'HTTP_ERROR');
  assert.equal(result.status, 400);
  assert.equal(result.providerCode, 10000);
  assert.equal(result.message.includes('secret'), false);
});

test('a failed request without usable errors has no provider code', async () => {
  for (const body of [
    { success: false },
    { success: false, errors: 'bad' },
    { success: false, errors: [] },
    { success: false, errors: ['x'] },
  ]) {
    server.setHandler((_req, res) => res.end(JSON.stringify(body)));
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'PROVIDER_ERROR', JSON.stringify(body));
    assert.equal(result.providerCode, undefined, JSON.stringify(body));
  }
});

test('an HTTP error with a body that is not a Cloudflare envelope has no provider code', async () => {
  for (const body of ['[]', '{"errors":[null]}', 'not json']) {
    server.setHandler((_req, res) => {
      res.writeHead(400);
      res.end(body);
    });
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'HTTP_ERROR', body);
    assert.equal(result.providerCode, undefined, body);
  }
});
