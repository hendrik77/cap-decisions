const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { SystemOneTransport } = require('../dist');

const kinds = cds.env.requires.kinds;
const question = { answer: { type: 'noul', instructions: 'Yes?' } };
const direct = {
  model: 'model-1',
  answers: { answer: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 2, output_tokens: 1 },
};

test('CAP links the base and provider kinds', () => {
  for (const name of ['systemone', 'systemone-typesafe', 'systemone-cloudflare', 'systemone-laya']) {
    assert.equal(kinds[name].impl, 'cap-jev');
    assert.equal(kinds[name].timeoutMs, 10000);
  }
  assert.equal(kinds['systemone-typesafe'].provider, 'typesafe');
  assert.equal(kinds['systemone-cloudflare'].provider, 'cloudflare');
  assert.equal(kinds['systemone-laya'].provider, 'laya');
});

test('CAP connection rejects unsupported timeout values during initialization', async () => {
  for (const timeoutMs of [2 ** 31, 2 ** 32]) {
    await assert.rejects(
      cds.connect.to('systemone', {
        ...kinds.systemone,
        impl: require.resolve('../dist'),
        timeoutMs,
        credentials: { url: 'http://127.0.0.1:9999/custom' },
      }),
      (error) => error.code === 'INVALID_CONFIG',
    );
  }
});

test('each kind sends its endpoint, model and auth settings', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const payload = seen.length === 2 ? { success: true, result: direct } : direct;
    return new globalThis.Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    const typeSafe = new SystemOneTransport({
      ...kinds['systemone-typesafe'],
      credentials: { ...kinds['systemone-typesafe'].credentials, token: 'test-token' },
    });
    const cloudflare = new SystemOneTransport({
      ...kinds['systemone-cloudflare'],
      credentials: { accountId: 'test-account', token: 'test-token' },
    });
    const laya = new SystemOneTransport(kinds['systemone-laya']);
    const generic = new SystemOneTransport({
      ...kinds.systemone,
      credentials: { url: 'http://127.0.0.1:9999/custom' },
    });
    for (const transport of [typeSafe, cloudflare, laya, generic])
      assert.deepEqual(await transport.decide({ state: 'x', questions: question }), direct);
    assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen[0].body.model, 'jev-latest');
    assert.equal(seen[0].headers.authorization, 'Bearer test-token');
    assert.equal(seen[1].url, 'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef');
    assert.equal(seen[1].body.model, 'clef');
    assert.equal(seen[1].headers.authorization, 'Bearer test-token');
    assert.equal(seen[2].url, 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(seen[2].body.model, undefined);
    assert.equal(seen[2].headers.authorization, undefined);
    assert.equal(seen[3].url, 'http://127.0.0.1:9999/custom');
    assert.equal(seen[3].body.model, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('provider kinds require their secrets and enforce their limits before fetch', async () => {
  assert.throws(
    () => new SystemOneTransport(kinds.systemone),
    (error) => error.code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => new SystemOneTransport(kinds['systemone-typesafe']),
    (error) => error.code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => new SystemOneTransport({ ...kinds['systemone-cloudflare'], credentials: { token: 'test-token' } }),
    (error) => error.code === 'INVALID_CONFIG',
  );
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new globalThis.Response('{}');
  };
  try {
    const typeSafe = new SystemOneTransport({
      ...kinds['systemone-typesafe'],
      credentials: { ...kinds['systemone-typesafe'].credentials, token: 'test-token' },
    });
    const laya = new SystemOneTransport(kinds['systemone-laya']);
    const cloudflare = new SystemOneTransport({
      ...kinds['systemone-cloudflare'],
      credentials: { accountId: 'test-account', token: 'test-token' },
    });
    const choice = (count) => ({
      state: 'x',
      questions: {
        answer: {
          type: 'choice',
          instructions: 'Choose',
          criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`option${i}`, 'x'])),
        },
      },
    });
    const score = (count) => ({
      state: 'x',
      questions: { answer: { type: 'score', instructions: 'Rate', criteria: Array(count).fill('x') } },
    });
    for (const request of [choice(256), score(1), score(11)])
      await assert.rejects(typeSafe.decide(request), (error) => error.code === 'INVALID_REQUEST');
    await assert.rejects(laya.decide(choice(101)), (error) => error.code === 'INVALID_REQUEST');
    await assert.rejects(
      cloudflare.decide({
        state: 'x',
        questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, question.answer])),
      }),
      (error) => error.code === 'INVALID_REQUEST',
    );
    assert.equal(calls, 0);
    const generic = new SystemOneTransport({
      ...kinds.systemone,
      credentials: { url: 'http://127.0.0.1:9999/custom' },
    });
    await assert.rejects(generic.decide(choice(256)), (error) => error.code === 'INVALID_RESPONSE');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
