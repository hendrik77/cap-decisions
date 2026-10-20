const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SystemOneTransport } = require('../dist/transport');
const { SystemOneError } = require('../dist');

const questions = {
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'High'] },
  refund: { type: 'noul', instructions: 'Refund requested?' },
};
const result = {
  model: 'jev-1.13.0',
  answers: {
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, technical: 0.2 }, confidence: 0.6 },
    urgency: {
      type: 'score',
      score: 0.9,
      legend: { 0: 'Low', 1: 'High' },
      probabilities: { 0: 0.1, 1: 0.9 },
      confidence: 0.5,
    },
    refund: { type: 'noul', noul: 0.95 },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

let handler = (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result));
};
const server = http.createServer((request, response) => handler(request, response));
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const endpoint = async () => {
  await ready;
  return `http://127.0.0.1:${server.address().port}/v1/systemone`;
};
const settingsFor = async (options = {}) => {
  const { modelId = 'jev-latest', timeoutMs = 10000, url, token, requiresToken, accountId } = options;
  return {
    modelId: modelId === null ? undefined : modelId,
    timeoutMs,
    requiresToken,
    credentials: { url: url ?? (await endpoint()), token, accountId },
  };
};
const decide = async (options = {}, request = { state: { text: 'Refund me' }, questions }, transportOptions) =>
  (await post(options, request, transportOptions)).payload;
const post = async (options = {}, request = { state: { text: 'Refund me' }, questions }, transportOptions) =>
  new SystemOneTransport(await settingsFor(options), transportOptions).post(request);

test('sends multiple typed questions and returns TypeSafe answers', async () => {
  handler = async (req, res) => {
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, 'Bearer secret');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      state: { text: 'Refund me' },
      questions,
      model: 'jev-latest',
    });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  };
  assert.deepEqual(await post({ requiresToken: true, token: 'secret' }), { payload: result, attempts: 1 });
});

test('the unwrap hook receives the parsed payload and its result is returned', async () => {
  handler = (_req, res) => res.end(JSON.stringify({ success: true, result }));
  const seen = [];
  const hooks = {
    unwrap: (payload) => {
      seen.push(payload);
      return payload.result;
    },
  };
  assert.deepEqual(await decide({}, undefined, { hooks }), result);
  assert.deepEqual(seen, [{ success: true, result }]);
});

test('without an unwrap result the payload itself is returned', async () => {
  handler = (_req, res) => res.end(JSON.stringify(result));
  assert.deepEqual(await decide({}, undefined, { hooks: { unwrap: () => undefined } }), result);
  assert.deepEqual(await decide({}, undefined, { hooks: {} }), result);
});

test('an unwrap hook error is passed on without a retry', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    res.end(JSON.stringify(result));
  };
  const hooks = {
    unwrap: () => {
      throw new SystemOneError('PROVIDER_ERROR', 'from hook', { providerCode: 7 });
    },
  };
  await assert.rejects(decide({}, undefined, { hooks }), (error) => error.code === 'PROVIDER_ERROR');
  assert.equal(calls, 1);
});

test('the endpoint hook supplies the URL and falls back to credentials.url', async () => {
  const url = await endpoint();
  const settings = { timeoutMs: 1000, credentials: { accountId: 'acct' } };
  let seen;
  const hooks = {
    endpoint: (credentials) => {
      seen = credentials;
      return `${url}?account=${credentials.accountId}`;
    },
  };
  handler = (req, res) => {
    assert.equal(req.url, '/v1/systemone?account=acct');
    res.end(JSON.stringify(result));
  };
  assert.deepEqual((await new SystemOneTransport(settings, { hooks }).post({ state: 'x', questions })).payload, result);
  assert.equal(seen.accountId, 'acct');
  const fallback = { timeoutMs: 1000, credentials: { url } };
  handler = (req, res) => {
    assert.equal(req.url, '/v1/systemone');
    res.end(JSON.stringify(result));
  };
  const transport = new SystemOneTransport(fallback, { hooks: { endpoint: () => undefined } });
  assert.deepEqual((await transport.post({ state: 'x', questions })).payload, result);
  assert.throws(
    () => new SystemOneTransport({ timeoutMs: 1000 }, { hooks: { endpoint: () => 'not a URL' } }),
    (error) => error.code === 'INVALID_CONFIG',
  );
});

test('a hook that throws while building the endpoint fails the construction', () => {
  const hooks = {
    endpoint: () => {
      throw new SystemOneError('INVALID_CONFIG', 'Hook needs more');
    },
  };
  assert.throws(
    () => new SystemOneTransport({ timeoutMs: 1000 }, { hooks }),
    (error) => error.code === 'INVALID_CONFIG' && error.message === 'Hook needs more',
  );
});

test('requiresToken needs a token without a destination', async () => {
  assert.throws(
    () => new SystemOneTransport({ timeoutMs: 1000, requiresToken: true, credentials: { url: 'https://example.com' } }),
    (error) => error.code === 'INVALID_CONFIG' && /token/.test(error.message),
  );
  assert.doesNotThrow(
    () =>
      new SystemOneTransport({
        timeoutMs: 1000,
        requiresToken: true,
        credentials: { url: 'https://example.com', token: 't' },
      }),
  );
  assert.doesNotThrow(() => new SystemOneTransport({ timeoutMs: 1000, credentials: { url: 'https://example.com' } }));
});

test('works without token or model', async () => {
  handler = async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal('model' in JSON.parse(Buffer.concat(chunks).toString()), false);
    res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide({ modelId: null }, { state: 'refund', questions }), result);
});

test('serialises shared references and null-prototype request content', async () => {
  const shared = { label: 'Refund', values: [null, true, 1] };
  const state = Object.assign(Object.create(null), { first: shared, second: shared });
  const request = { state, questions };
  handler = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
      ...JSON.parse(JSON.stringify(request)),
      model: 'jev-latest',
    });
    res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide({}, request), result);
});

test('rejects invalid endpoint and timeout settings', () => {
  for (const settings of [
    { timeoutMs: 1000, credentials: { url: 'not a URL' } },
    { timeoutMs: 0, credentials: { url: 'https://example.com' } },
    { timeoutMs: 1.5, credentials: { url: 'https://example.com' } },
    { timeoutMs: 2 ** 31, credentials: { url: 'https://example.com' } },
    { timeoutMs: 2 ** 32, credentials: { url: 'https://example.com' } },
    { credentials: { url: 'https://example.com' } },
  ]) {
    assert.throws(
      () => new SystemOneTransport(settings),
      (error) => error.code === 'INVALID_CONFIG',
    );
  }
});

test('accepts the maximum supported timeout', () => {
  assert.doesNotThrow(
    () => new SystemOneTransport({ timeoutMs: 2_147_483_647, credentials: { url: 'https://example.com' } }),
  );
});

test('snapshots endpoint, token, destination, modelId and timeout settings', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), authorization: options.headers.authorization, body: JSON.parse(options.body) });
    return new globalThis.Response(JSON.stringify(result));
  };
  try {
    for (const [url, token] of [
      ['http://example.com/', undefined],
      ['https://example.com/', 'original-token'],
      ['http://127.0.0.1/', 'original-token'],
    ]) {
      const settings = { timeoutMs: 1000, modelId: 'original-model', credentials: { url, token } };
      const transport = new SystemOneTransport(settings, {
        destinationResolver: async () => assert.fail('unexpected destination resolution'),
      });
      settings.credentials.token = 'changed-token';
      settings.credentials.url = 'http://changed.example.com';
      settings.credentials.destination = 'added-destination';
      settings.modelId = 'changed-model';
      settings.timeoutMs = 2 ** 32;
      assert.deepEqual((await transport.post({ state: 'x', questions })).payload, result);
      assert.deepEqual(seen.at(-1), {
        url,
        authorization: token ? `Bearer ${token}` : undefined,
        body: { state: 'x', questions, model: 'original-model' },
      });
    }
    assert.equal(seen.length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('reports authentication errors without leaking response body', async () => {
  handler = (_req, res) => {
    res.writeHead(401);
    res.end('secret response');
  };
  await assert.rejects(
    decide({ token: 'secret' }),
    (error) => error.code === 'HTTP_ERROR' && error.status === 401 && !error.message.includes('secret'),
  );
});

test('retries 429 and 529 twice at most', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(calls === 1 ? 429 : 529);
      res.end();
    } else res.end(JSON.stringify(result));
  };
  assert.deepEqual(await post(), { payload: result, attempts: 3 });
  assert.equal(calls, 3);
  calls = 0;
  handler = (_req, res) => {
    calls++;
    res.writeHead(429);
    res.end();
  };
  await assert.rejects(decide(), (error) => error.code === 'HTTP_ERROR' && error.status === 429);
  assert.equal(calls, 3);
});

test('reports timeout', async () => {
  handler = (_req, res) => setTimeout(() => res.end(JSON.stringify(result)), 100);
  await assert.rejects(decide({ timeoutMs: 10 }), (error) => error.code === 'TIMEOUT');
});

test('rejects a token over non-loopback HTTP before sending', async () => {
  assert.throws(
    () => new SystemOneTransport({ timeoutMs: 1000, credentials: { url: 'http://example.com', token: 'secret' } }),
    (error) => error.code === 'INVALID_CONFIG',
  );
});

test('requires an endpoint and never calls fetch when it is missing', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected request');
  };
  try {
    assert.throws(
      () => new SystemOneTransport({ timeoutMs: 1000 }),
      (error) => error.code === 'INVALID_CONFIG',
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('retries 503 after cancelling its response body', async () => {
  let closed = false;
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(503);
      res.write('temporary failure');
      res.on('close', () => {
        closed = true;
      });
    } else res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide(), result);
  assert.equal(calls, 2);
  assert.equal(closed, true);
});

test('repeated retriable failures release their response streams', async () => {
  let calls = 0;
  let closed = 0;
  handler = (_req, res) => {
    calls++;
    if (calls % 3) {
      res.writeHead(503, { 'retry-after': '0' });
      res.write('retry');
      res.on('close', () => {
        closed++;
      });
    } else res.end(JSON.stringify(result));
  };
  for (let i = 0; i < 8; i++) assert.deepEqual(await decide(), result);
  assert.equal(calls, 24);
  assert.equal(closed, 16);
});

test('honours Retry-After and fails with the HTTP error when it exceeds the deadline', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    res.writeHead(503, { 'retry-after': '0.12' });
    res.end();
  };
  const started = Date.now();
  await assert.rejects(decide({ timeoutMs: 1000 }), (error) => error.code === 'HTTP_ERROR' && error.status === 503);
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 200);
  calls = 0;
  for (const status of [429, 529]) {
    calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(status, { 'retry-after': '10', 'set-cookie': 'private-cookie' });
      res.end(JSON.stringify({ error: { type: 'rate_limited' } }));
    };
    const started = Date.now();
    await assert.rejects(decide({ timeoutMs: 200 }), (error) => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, status);
      assert.equal(error.providerCode, 'rate_limited');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(Date.now() - started < 150, 'should fail before waiting for the deadline');
    assert.equal(calls, 1);
  }
});

test('retries a closed connection and preserves the final network cause', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    if (calls < 3) res.destroy();
    else res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide({ timeoutMs: 5000 }), result);
  assert.equal(calls, 3);
  calls = 0;
  handler = (_req, res) => {
    calls++;
    res.destroy();
  };
  await assert.rejects(
    decide({ timeoutMs: 5000 }),
    (error) => error.code === 'NETWORK_ERROR' && error.cause instanceof Error,
  );
  assert.equal(calls, 3);
});

test('uses one deadline across retries and supports caller abort', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    res.destroy();
  };
  await assert.rejects(decide({ timeoutMs: 150 }), (error) => error.code === 'TIMEOUT');
  assert.ok(calls <= 2);
  const controller = new globalThis.AbortController();
  handler = (_req, res) => {
    setTimeout(() => res.end(JSON.stringify(result)), 200);
  };
  const cancelled = new SystemOneTransport({ timeoutMs: 1000, credentials: { url: await endpoint() } }).post(
    { state: 'x', questions },
    { signal: controller.signal },
  );
  controller.abort(new Error('caller stopped'));
  await assert.rejects(cancelled, (error) => error.code === 'ABORTED' && !!error.cause);
});

test('no request starts after a network retry used up the deadline', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    res.destroy();
  };
  const original = globalThis.fetch;
  const starts = [];
  globalThis.fetch = (...args) => {
    starts.push(Date.now());
    return original(...args);
  };
  try {
    // The retry pause and the deadline end at the same moment; repeat to cover both timer orders.
    for (let run = 0; run < 20; run++) {
      starts.length = 0;
      const started = Date.now();
      await assert.rejects(decide({ timeoutMs: 40 }), (error) => error.code === 'TIMEOUT');
      for (const start of starts) assert.ok(start - started < 40, `a request started after the deadline in run ${run}`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(calls > 0);
});

test('handles invalid JSON and provider codes without response messages', async () => {
  let calls = 0;
  handler = (_req, res) => {
    calls++;
    res.end('{broken');
  };
  await assert.rejects(decide(), (error) => error.code === 'INVALID_RESPONSE' && error.cause instanceof Error);
  assert.equal(calls, 1);
  handler = (_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'secret details' } }));
  };
  await assert.rejects(
    decide(),
    (error) =>
      error.code === 'HTTP_ERROR' &&
      error.status === 400 &&
      error.providerCode === 'invalid_request' &&
      error.cause === undefined &&
      !error.message.includes('secret'),
  );
});

test('the errorCode hook supplies the provider code and its result is sanitised', async () => {
  handler = (_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ errors: [{ code: 1001 }], error: { type: 'ignored' } }));
  };
  const code = (value) => ({ hooks: { errorCode: () => value } });
  await assert.rejects(decide({}, undefined, code(1001)), (error) => error.providerCode === 1001);
  await assert.rejects(
    decide({}, undefined, code('rate.limited:1')),
    (error) => error.providerCode === 'rate.limited:1',
  );
  for (const unsafe of ['has spaces', 'x'.repeat(101), 1.5, { code: 1 }]) {
    await assert.rejects(
      decide({}, undefined, code(unsafe)),
      (error) => error.code === 'HTTP_ERROR' && error.providerCode === undefined,
    );
  }
  const payloads = [];
  const hooks = {
    errorCode: (payload) => {
      payloads.push(payload);
      return payload.errors[0].code;
    },
  };
  await assert.rejects(decide({}, undefined, { hooks }), (error) => error.providerCode === 1001);
  assert.deepEqual(payloads, [{ errors: [{ code: 1001 }], error: { type: 'ignored' } }]);
});

test('without an errorCode result the default reads error.type', async () => {
  handler = (_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ error: { type: 'invalid_request' } }));
  };
  await assert.rejects(
    decide({}, undefined, { hooks: { errorCode: () => undefined } }),
    (error) => error.providerCode === 'invalid_request',
  );
  handler = (_req, res) => {
    res.writeHead(400);
    res.end('not json');
  };
  await assert.rejects(decide(), (error) => error.code === 'HTTP_ERROR' && error.providerCode === undefined);
});

test('retries an interrupted response body and preserves exhausted transfer failures', async () => {
  let calls = 0;
  const closures = [];
  const partial = (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"model":');
    closures.push(new Promise((resolve) => res.on('close', resolve)));
    setTimeout(() => res.destroy(), 20);
  };
  handler = (_req, res) => {
    calls++;
    if (calls === 1) partial(res);
    else res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide(), result);
  await Promise.all(closures);
  assert.equal(calls, 2);
  assert.equal(closures.length, 1);
  calls = 0;
  closures.length = 0;
  handler = (_req, res) => {
    calls++;
    partial(res);
  };
  await assert.rejects(decide(), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.ok(error.cause instanceof TypeError);
    assert.match(error.cause.message, /terminated/);
    return true;
  });
  await Promise.all(closures);
  assert.equal(calls, 3);
  assert.equal(closures.length, 3);
});

test('timeout and caller cancellation interrupt response body reading without retrying', async () => {
  for (const cancelled of [false, true]) {
    let calls = 0;
    let received;
    const reading = new Promise((resolve) => {
      received = resolve;
    });
    let closed;
    const released = new Promise((resolve) => {
      closed = resolve;
    });
    handler = (_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"model":');
      res.on('close', closed);
      received();
    };
    const controller = new globalThis.AbortController();
    const transport = new SystemOneTransport({
      timeoutMs: cancelled ? 1000 : 100,
      credentials: { url: await endpoint() },
    });
    const decision = transport.post({ state: 'x', questions }, { signal: controller.signal });
    const rejected = assert.rejects(decision, (error) => {
      assert.equal(error.code, cancelled ? 'ABORTED' : 'TIMEOUT');
      assert.ok(error.cause instanceof Error);
      return true;
    });
    await reading;
    if (cancelled) setTimeout(() => controller.abort(), 20);
    await rejected;
    await released;
    assert.equal(calls, 1);
  }
});
