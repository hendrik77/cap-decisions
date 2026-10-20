// CAP loads the TypeScript handler only when this is set before cds loads.
process.env.CDS_TYPESCRIPT = 'true';
const path = require('node:path');
const cds = require('@sap/cds');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/fake-server.cjs');

const technical = {
  model: 'laya',
  answers: {
    department: {
      type: 'choice',
      choice: 'technical',
      probabilities: { billing: 0.2, technical: 0.8 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 3, output_tokens: 1 },
};

const answer = (body) => (_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
};

describe('example app with cds.test', () => {
  let provider;
  const alice = { auth: { username: 'alice', password: '' } };
  const url = '/odata/v4/decision/classify';

  // Registered before cds.test() so that the fake server's port is known before the service connects in init().
  before(async () => {
    provider = await startServer(answer(technical));
    process.env.CDS_REQUIRES_SYSTEMONE_CREDENTIALS_URL = provider.url;
  });
  after(() => provider.close());

  const { POST } = cds.test(path.resolve(__dirname, '../examples/cap-app'));
  const call = (data, config) => POST(url, data, { validateStatus: () => true, ...config });

  test('rejects an anonymous call without reaching the provider', async () => {
    const { status } = await call({ message: 'The API returns errors' });
    assert.equal(status, 401);
    assert.equal(provider.received.length, 0);
  });

  test('routes a technical message to support for an authenticated user', async () => {
    provider.setHandler(answer(technical));
    const { status, data } = await call({ message: 'The API returns errors' }, alice);
    assert.equal(status, 200);
    assert.equal(data.value, 'support');
    assert.equal(provider.received.at(-1).state, 'The API returns errors');
  });

  test('rejects an empty message with 400', async () => {
    const count = provider.received.length;
    const { status } = await call({ message: ' ' }, alice);
    assert.equal(status, 400);
    assert.equal(provider.received.length, count);
  });

  test('maps a provider failure to 502', async () => {
    provider.setHandler((_request, response) => {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'bad_request' } }));
    });
    const { status } = await call({ message: 'The API returns errors' }, alice);
    assert.equal(status, 502);
  });
});
