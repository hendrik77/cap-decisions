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
    name: 'subq-app',
    private: true,
    cds: { requires: { decisions: { kind: 'decisions-subq', credentials } } },
  });
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const request = { state: 'Refund me', questions: { answer: { type: 'noul', instructions: 'Refund?' } } };
    const labels = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => ['label' + i, 'Option ' + i]));
    const levels = (count) => Array.from({ length: count }, (_, i) => 'Level ' + i);
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

const withUrl = () => ({ token: 'secret-key', url: server.url });
const reset = (handler) => {
  server.received.length = 0;
  server.requests.length = 0;
  server.setHandler(handler);
};
const answerWith = (result) => (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(result));
};
const failWith =
  (status, body, headers = {}) =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
const decide = `const result = await srv.decide(request); out({ model: result.model });`;
const decideWith = (questions) =>
  `await srv.decide({ state: 'Refund me', questions: ${questions} }); out({ ok: true });`;

const detail = (errorType, message = 'questions/queue: must have required property criteria') => ({
  detail: { error_type: errorType, message },
});

// The first test is the probe of the plan (H2): SubQ's error body, which the shared transport does not read.
test('HTTP 422 is HTTP_ERROR with the status and the error type as providerCode', async () => {
  reset(failWith(422, detail('validation_error')));
  const result = await inApp(withUrl(), decide);
  assert.equal(result.error, 'HTTP_ERROR');
  assert.equal(result.status, 422);
  assert.equal(result.providerCode, 'validation_error');
});

test('a choice, a score and a noul answer come back typed', async () => {
  reset(
    answerWith({
      model: 'subq-snap-preview',
      answers: {
        department: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.75, tech: 0.25 },
          confidence: 0.5,
        },
        urgency: {
          type: 'score',
          score: 2,
          legend: { 0: 'Low', 1: 'Mid', 2: 'High' },
          probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
          confidence: 0.6,
        },
        refund: { type: 'noul', noul: 0.9 },
      },
      usage: { input_tokens: 12, output_tokens: 0 },
    }),
  );
  const result = await inApp(
    withUrl(),
    `const result = await srv.decide({
       state: 'Refund me',
       questions: {
         department: { type: 'choice', instructions: 'Which?', criteria: { billing: 'Money', tech: 'Bugs' } },
         urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'Mid', 'High'] },
         refund: { type: 'noul', instructions: 'Refund?' },
       },
     });
     out({ answers: result.answers, usage: result.usage, model: result.model });`,
  );
  assert.equal(result.answers.department.choice, 'billing');
  assert.equal(result.answers.urgency.score, 2);
  assert.equal(result.answers.refund.noul, 0.9);
  assert.equal(result.model, 'subq-snap-preview');
  assert.equal(result.usage.output_tokens, 0);
});

test('sends the model subq-snap-preview and the token as a bearer header', async () => {
  reset(answerWith({ ...noulResult, model: 'subq-snap-preview' }));
  await inApp(withUrl(), decide);
  assert.equal(server.received.length, 1);
  assert.equal(server.received[0].model, 'subq-snap-preview');
  assert.equal(server.requests[0].headers.authorization, 'Bearer secret-key');
  assert.equal(server.requests[0].headers['content-type'], 'application/json');
});

test('a missing token is INVALID_CONFIG and sends nothing', async () => {
  reset(answerWith(noulResult));
  const result = await inApp({ url: server.url }, decide);
  assert.equal(result.error, 'INVALID_CONFIG');
  assert.equal(server.received.length, 0);
});

const noulQuestions = (count) =>
  `Object.fromEntries(Array.from({ length: ${count} }, (_, i) => ['q' + i, { type: 'noul', instructions: 'Q' + i }]))`;
const choice = (count) => `{ q: { type: 'choice', instructions: 'Which?', criteria: labels(${count}) } }`;
const score = (count) => `{ q: { type: 'score', instructions: 'How?', criteria: levels(${count}) } }`;

// At the limits only the request matters, so the fake server's answer does not have to fit the questions: the
// service then fails with INVALID_RESPONSE after the request was sent, which is not what these tests check.
const limitCases = [
  ['questions', 16, 17, noulQuestions],
  ['choice options', 255, 256, choice],
  ['score levels, upper bound', 10, 11, score],
  ['score levels, lower bound', 2, 1, score],
];

for (const [name, valid, invalid, build] of limitCases) {
  test(`${name}: ${valid} are sent, ${invalid} are rejected before any request`, async () => {
    reset(answerWith(noulResult));
    const rejected = await inApp(withUrl(), decideWith(build(invalid)));
    assert.equal(rejected.error, 'INVALID_REQUEST', name);
    assert.equal(server.received.length, 0, `${name}: rejected before sending`);

    reset(answerWith(noulResult));
    await inApp(withUrl(), decideWith(build(valid)));
    assert.equal(server.received.length, 1, `${name}: sent at the limit`);
  });
}

for (const [status, errorType] of [
  [400, 'token_limit_exceeded'],
  [401, 'authentication_error'],
  [402, 'insufficient_credits'],
  [403, 'permission_error'],
  [422, 'validation_error'],
]) {
  test(`HTTP ${status} is HTTP_ERROR with the error type as providerCode, without a retry`, async () => {
    reset(failWith(status, detail(errorType, 'secret-key leaked here')));
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, status);
    assert.equal(result.providerCode, errorType);
    assert.equal(result.message.includes('secret'), false);
    assert.equal(server.received.length, 1);
  });
}

for (const status of [429, 503]) {
  test(`HTTP ${status} is retried twice, then reported with its error type`, async () => {
    reset(failWith(status, detail('rate_limit_error'), { 'retry-after': '0' }));
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, status);
    assert.equal(result.providerCode, 'rate_limit_error');
    assert.equal(server.received.length, 3);
  });
}

test('a retried 503 can succeed', async () => {
  reset((req, res) =>
    server.received.length === 1
      ? failWith(503, detail('unavailable'), { 'retry-after': '0' })(req, res)
      : answerWith(noulResult)(req, res),
  );
  assert.deepEqual(await inApp(withUrl(), decide), { model: 'fake-model' });
  assert.equal(server.received.length, 2);
});

test('an error body without a usable detail is HTTP_ERROR without providerCode', async () => {
  const bodies = [
    { message: 'nope' },
    '{}',
    'plain text',
    { detail: 'text' },
    { detail: { error_type: 'has spaces' } },
  ];
  for (const body of bodies) {
    reset(failWith(422, body));
    const result = await inApp(withUrl(), decide);
    assert.equal(result.error, 'HTTP_ERROR', JSON.stringify(body));
    assert.equal(result.status, 422);
    assert.equal(result.providerCode, undefined, JSON.stringify(body));
  }
});
