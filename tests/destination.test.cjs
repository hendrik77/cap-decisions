const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SystemOneTransport } = require('../dist');

const request = { state: 'x', questions: { answer: { type: 'noul', instructions: 'Yes?' } } };
const result = {
  model: 'test',
  answers: { answer: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};

test('destination supplies URL and URL.headers.Authorization without local caching', async () => {
  const original = globalThis.fetch;
  const seen = [];
  let resolutions = 0;
  const resolver = async (name) => {
    assert.equal(name, 'test-destination');
    resolutions++;
    return { url: `https://example.com/${resolutions}`, headers: { Authorization: 'Bearer destination-token' } };
  };
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), authorization: options.headers.authorization });
    return new globalThis.Response(JSON.stringify(result));
  };
  try {
    const transport = new SystemOneTransport(
      {
        provider: 'typesafe',
        model: 'jev-latest',
        timeoutMs: 1000,
        credentials: { destination: 'test-destination' },
      },
      resolver,
    );
    await transport.validateDestination();
    assert.deepEqual(await transport.decide(request), result);
    assert.deepEqual(await transport.decide(request), result);
    assert.equal(resolutions, 3);
    assert.deepEqual(seen, [
      { url: 'https://example.com/2', authorization: 'Bearer destination-token' },
      { url: 'https://example.com/3', authorization: 'Bearer destination-token' },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('missing optional SDK reports an install hint', async () => {
  const transport = new SystemOneTransport({ timeoutMs: 1000, credentials: { destination: 'test-destination' } });
  await assert.rejects(
    transport.validateDestination(),
    (error) => error.code === 'INVALID_CONFIG' && error.message.includes('Install @sap-cloud-sdk/connectivity'),
  );
});

test('destination token cannot be sent to non-loopback HTTP', async () => {
  const transport = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'test-destination' } },
    async () => ({ url: 'http://example.com/post', headers: { Authorization: 'Bearer secret' } }),
  );
  await assert.rejects(transport.validateDestination(), (error) => error.code === 'INVALID_CONFIG');
});

test('destination resolution and caller cancellation obey the call deadline', async () => {
  const resolver = async () =>
    new Promise((resolve) => globalThis.setTimeout(() => resolve({ url: 'https://example.com/post' }), 100));
  const transport = new SystemOneTransport({ timeoutMs: 20, credentials: { destination: 'slow' } }, resolver);
  await assert.rejects(transport.decide(request), (error) => error.code === 'TIMEOUT');
  const controller = new globalThis.AbortController();
  const cancelled = new SystemOneTransport({ timeoutMs: 1000, credentials: { destination: 'slow' } }, resolver).decide(
    request,
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'ABORTED');
});
