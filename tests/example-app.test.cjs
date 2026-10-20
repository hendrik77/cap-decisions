// CAP loads the TypeScript handler only when this is set before cds loads.
process.env.CDS_TYPESCRIPT = 'true';
const path = require('node:path');
const cds = require('@sap/cds');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('example app with cds.test on the mock provider', () => {
  const alice = { auth: { username: 'alice', password: '' } };
  const url = '/odata/v4/decision/classify';

  const { POST } = cds.test(path.resolve(__dirname, '../examples/cap-app'));
  const call = (data, config) => POST(url, data, { validateStatus: () => true, ...config });

  test('rejects an anonymous call', async () => {
    const { status } = await call({ message: 'The API returns errors' });
    assert.equal(status, 401);
  });

  test('routes a technical message to support through the mock keywords', async () => {
    const { status, data } = await call({ message: 'The API returns errors' }, alice);
    assert.equal(status, 200);
    assert.equal(data.value, 'support');
  });

  test('routes a refund message to accounts through the fixture rule', async () => {
    const { status, data } = await call({ message: 'Please give me my money back' }, alice);
    assert.equal(status, 200);
    assert.equal(data.value, 'accounts');
  });

  test('rejects an empty message with 400', async () => {
    const { status } = await call({ message: ' ' }, alice);
    assert.equal(status, 400);
  });
});
