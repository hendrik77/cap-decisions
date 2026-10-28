// CAP loads the TypeScript handler only when this is set before cds loads. A simulated failure makes the mock
// provider fail every call; it runs in its own file because the configuration is read once per process.
process.env.CDS_TYPESCRIPT = 'true';
process.env.CDS_REQUIRES_DECISIONS_FAIL = 'NETWORK_ERROR';
const path = require('node:path');
const cds = require('@sap/cds');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('example app with a simulated provider failure', () => {
  const alice = { auth: { username: 'alice', password: '' } };

  const { POST } = cds.test(path.resolve(__dirname, '../examples/cap-app'));

  test('maps a provider failure to 502', async () => {
    const { status } = await POST(
      '/odata/v4/decision/classify',
      { message: 'The API returns errors' },
      { validateStatus: () => true, ...alice },
    );
    assert.equal(status, 502);
  });
});
