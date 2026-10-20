const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SystemOneTransport, SystemOneError } = require('../dist');

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
const decide = async (options = {}, request = { state: { text: 'Refund me' }, questions }) => {
  const { provider = 'generic', model = 'jev-latest', timeoutMs = 10000, url, token, accountId } = options;
  return new SystemOneTransport({
    provider,
    model: model === null ? undefined : model,
    timeoutMs,
    credentials: { url: url ?? (await endpoint()), token, accountId },
  }).decide(request);
};

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
  assert.deepEqual(await decide({ provider: 'typesafe', token: 'secret' }), result);
});

test('unwraps Cloudflare result', async () => {
  handler = (_req, res) => res.end(JSON.stringify({ success: true, result }));
  assert.deepEqual(await decide({ provider: 'cloudflare', accountId: 'test', token: 'secret', model: 'clef' }), result);
});

test('Laya works without token or model', async () => {
  handler = async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal('model' in JSON.parse(Buffer.concat(chunks).toString()), false);
    res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide({ provider: 'laya', model: null }, { state: 'refund', questions }), result);
});

test('rejects missing, mismatched, and unknown choice answers', async () => {
  for (const invalid of [
    { ...result, answers: { ...result.answers, refund: undefined } },
    { ...result, answers: { ...result.answers, refund: { type: 'score', score: 1 } } },
    { ...result, answers: { ...result.answers, team: { ...result.answers.team, choice: 'invented' } } },
    {
      ...result,
      answers: { ...result.answers, team: { ...result.answers.team, probabilities: { billing: 0.8, technical: 0.8 } } },
    },
  ]) {
    handler = (_req, res) => res.end(JSON.stringify(invalid));
    await assert.rejects(decide(), (error) => error instanceof SystemOneError && error.code === 'INVALID_RESPONSE');
  }
});

test('rejects score answers outside range and with incorrect legends', async () => {
  for (const answer of [
    { ...result.answers.urgency, score: 2 },
    { ...result.answers.urgency, legend: { 0: 'Low', 2: 'High' } },
  ]) {
    handler = (_req, res) => res.end(JSON.stringify({ ...result, answers: { ...result.answers, urgency: answer } }));
    await assert.rejects(decide(), (error) => error.code === 'INVALID_RESPONSE');
  }
});

test('rejects invalid input before sending', async () => {
  await assert.rejects(
    decide({}, { state: 'x', questions: { bad: { type: 'choice', instructions: 'x', criteria: {} } } }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('rejects circular and unsupported request content before sending', async () => {
  const circular = {};
  circular.self = circular;
  const array = [];
  array.push(array);
  class Criteria {
    constructor() {
      this.label = 'High';
    }
  }
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected request');
  };
  try {
    const invalid = [
      [{ state: circular, questions }, /circular/],
      [{ state: { items: array }, questions }, /circular/],
      [
        { state: 'x', questions: { answer: { type: 'choice', instructions: 'Choose', criteria: { a: circular } } } },
        /circular/,
      ],
      [{ state: 'x', questions: { answer: { type: 'noul', instructions: circular } } }, /circular/],
    ];
    for (const value of [new Map([['a', 1]]), new Set(['a']), new Criteria(), new Date()]) {
      invalid.push(
        [{ state: { items: value }, questions }, /unsupported object/],
        [{ state: 'x', questions: { answer: { type: 'noul', instructions: value } } }, /unsupported object/],
        [
          { state: 'x', questions: { answer: { type: 'score', instructions: 'Rate', criteria: [value] } } },
          /unsupported object/,
        ],
        [
          { state: 'x', questions: { answer: { type: 'noul', instructions: 'Yes?', criteria: value } } },
          /unsupported object/,
        ],
      );
    }
    for (const [request, message] of invalid) {
      await assert.rejects(decide({}, request), (error) => {
        assert.ok(error instanceof SystemOneError);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.match(error.message, message);
        return true;
      });
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('accepts shared references and null-prototype request content', async () => {
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

test('rejects invalid noul criteria before sending', async () => {
  for (const criteria of [{ maybe: 'yes' }, { true: 42, false: undefined }]) {
    await assert.rejects(
      decide({}, { state: 'x', questions: { answer: { type: 'noul', instructions: 'Yes?', criteria } } }),
      (error) => error.code === 'INVALID_REQUEST',
    );
  }
});

test('rejects invalid endpoint, timeout, provider and legacy response format settings', () => {
  for (const settings of [
    { timeoutMs: 1000, credentials: { url: 'not a URL' } },
    { timeoutMs: 0, credentials: { url: 'https://example.com' } },
    { timeoutMs: 1.5, credentials: { url: 'https://example.com' } },
    { timeoutMs: 2 ** 31, credentials: { url: 'https://example.com' } },
    { timeoutMs: 2 ** 32, credentials: { url: 'https://example.com' } },
    { timeoutMs: 1000, provider: 'unknown', credentials: { url: 'https://example.com' } },
    { timeoutMs: 1000, responseFormat: 'cloudflare', credentials: { url: 'https://example.com' } },
    { timeoutMs: 1000, credentials: { url: 'https://example.com', responseFormat: 'cloudflare' } },
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

test('snapshots endpoint, token, destination, model and timeout settings', async () => {
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
      const settings = { timeoutMs: 1000, model: 'original-model', credentials: { url, token } };
      const transport = new SystemOneTransport(settings, async () => assert.fail('unexpected destination resolution'));
      settings.credentials.token = 'changed-token';
      settings.credentials.url = 'http://changed.example.com';
      settings.credentials.destination = 'added-destination';
      settings.model = 'changed-model';
      settings.timeoutMs = 2 ** 32;
      assert.deepEqual(await transport.decide({ state: 'x', questions }), result);
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
  assert.deepEqual(await decide(), result);
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
  const cancelled = new SystemOneTransport({ timeoutMs: 1000, credentials: { url: await endpoint() } }).decide(
    { state: 'x', questions },
    { signal: controller.signal },
  );
  controller.abort(new Error('caller stopped'));
  await assert.rejects(cancelled, (error) => error.code === 'ABORTED' && !!error.cause);
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
  handler = (_req, res) =>
    res.end(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'secret details' }] }));
  await assert.rejects(
    decide({ provider: 'cloudflare', accountId: 'test', token: 'secret' }),
    (error) => error.code === 'PROVIDER_ERROR' && error.providerCode === 1001 && !error.message.includes('secret'),
  );
  handler = (_req, res) => res.end(JSON.stringify({ success: true }));
  await assert.rejects(
    decide({ provider: 'cloudflare', accountId: 'test', token: 'secret' }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
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
    const decision = transport.decide({ state: 'x', questions }, { signal: controller.signal });
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
