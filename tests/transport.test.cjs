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
const decide = async (credentials = {}, request = { state: { text: 'Refund me' }, questions }) =>
  new SystemOneTransport({ url: await endpoint(), model: 'jev-latest', ...credentials }).decide(request);

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
  assert.deepEqual(await decide({ token: 'secret' }), result);
});

test('unwraps Cloudflare result', async () => {
  handler = (_req, res) => res.end(JSON.stringify({ success: true, result }));
  assert.deepEqual(await decide({ responseFormat: 'cloudflare', model: 'clef' }), result);
});

test('Laya works without token or model', async () => {
  handler = async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal('model' in JSON.parse(Buffer.concat(chunks).toString()), false);
    res.end(JSON.stringify(result));
  };
  assert.deepEqual(await decide({ model: null }, { state: 'refund', questions }), result);
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

test('rejects invalid input before sending', async () => {
  await assert.rejects(
    decide({}, { state: 'x', questions: { bad: { type: 'choice', instructions: 'x', criteria: {} } } }),
    (error) => error.code === 'INVALID_REQUEST',
  );
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
  assert.throws(() => new SystemOneTransport({ url: 'http://example.com', token: 'secret' }),
    (error) => error.code === 'INVALID_CONFIG');
});

test('requires an endpoint and never calls fetch when it is missing', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('unexpected request');
  };
  try {
    assert.throws(() => new SystemOneTransport(), (error) => error.code === 'INVALID_CONFIG');
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

test('honours Retry-After and caps it at the overall deadline', async () => {
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
  handler = (_req, res) => {
    calls++;
    res.writeHead(429, { 'retry-after': '10' });
    res.end();
  };
  await assert.rejects(decide({ timeoutMs: 40 }), (error) => error.code === 'TIMEOUT' && !!error.cause);
  assert.equal(calls, 1);
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
    res.writeHead(503, { 'retry-after': '0.1' });
    res.end();
  };
  await assert.rejects(decide({ timeoutMs: 150 }), (error) => error.code === 'TIMEOUT');
  assert.ok(calls <= 2);
  const controller = new globalThis.AbortController();
  handler = (_req, res) => {
    setTimeout(() => res.end(JSON.stringify(result)), 200);
  };
  const cancelled = new SystemOneTransport({ url: await endpoint(), timeoutMs: 1000 }).decide(
    { state: 'x', questions },
    { signal: controller.signal },
  );
  controller.abort(new Error('caller stopped'));
  await assert.rejects(cancelled, (error) => error.code === 'ABORTED' && !!error.cause);
});

test('handles invalid JSON and provider codes without response messages', async () => {
  handler = (_req, res) => res.end('{broken');
  await assert.rejects(decide(), (error) => error.code === 'INVALID_RESPONSE' && error.cause instanceof Error);
  handler = (_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'secret details' } }));
  };
  await assert.rejects(
    decide(),
    (error) =>
      error.code === 'HTTP_ERROR' && error.providerCode === 'invalid_request' && !error.message.includes('secret'),
  );
  handler = (_req, res) =>
    res.end(JSON.stringify({ success: false, errors: [{ code: 1001, message: 'secret details' }] }));
  await assert.rejects(
    decide({ responseFormat: 'cloudflare' }),
    (error) => error.code === 'PROVIDER_ERROR' && error.providerCode === 1001 && !error.message.includes('secret'),
  );
  handler = (_req, res) => res.end(JSON.stringify({ success: true }));
  await assert.rejects(decide({ responseFormat: 'cloudflare' }), (error) => error.code === 'INVALID_RESPONSE');
});
