const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SystemOneTransport, SystemOneError } = require('../dist');

const questions = {
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'High'] },
  refund: { type: 'noul', instructions: 'Refund requested?' }
};
const result = {
  model: 'jev-1.13.0',
  answers: {
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, technical: 0.2 }, confidence: 0.6 },
    urgency: { type: 'score', score: 0.9, legend: { 0: 'Low', 1: 'High' }, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.5 },
    refund: { type: 'noul', noul: 0.95 }
  },
  usage: { input_tokens: 12, output_tokens: 3 }
};

let handler = (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); };
const server = http.createServer((request, response) => handler(request, response));
const ready = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const endpoint = async () => { await ready; return `http://127.0.0.1:${server.address().port}/v1/systemone`; };
const decide = async (credentials = {}, request = { state: { text: 'Refund me' }, questions }) =>
  new SystemOneTransport({ url: await endpoint(), ...credentials }).decide(request);

test('sends multiple typed questions and returns TypeSafe answers', async () => {
  handler = async (req, res) => {
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.headers.authorization, 'Bearer secret');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { state: { text: 'Refund me' }, questions, model: 'jev-latest' });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
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
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
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
    { ...result, answers: { ...result.answers, team: { ...result.answers.team, probabilities: { billing: 0.8, technical: 0.8 } } } }
  ]) {
    handler = (_req, res) => res.end(JSON.stringify(invalid));
    await assert.rejects(decide(), error => error instanceof SystemOneError && error.code === 'INVALID_RESPONSE');
  }
});

test('rejects invalid input before sending', async () => {
  await assert.rejects(decide({}, { state: 'x', questions: { bad: { type: 'choice', instructions: 'x', criteria: {} } } }),
    error => error.code === 'INVALID_REQUEST');
});

test('reports authentication errors without leaking response body', async () => {
  handler = (_req, res) => { res.writeHead(401); res.end('secret response'); };
  await assert.rejects(decide({ token: 'secret' }), error => error.code === 'HTTP_ERROR' && error.status === 401 && !error.message.includes('secret'));
});

test('retries 429 and 529 twice at most', async () => {
  let calls = 0;
  handler = (_req, res) => { calls++; if (calls < 3) { res.writeHead(calls === 1 ? 429 : 529); res.end(); } else res.end(JSON.stringify(result)); };
  assert.deepEqual(await decide(), result);
  assert.equal(calls, 3);
  calls = 0;
  handler = (_req, res) => { calls++; res.writeHead(429); res.end(); };
  await assert.rejects(decide(), error => error.code === 'HTTP_ERROR' && error.status === 429);
  assert.equal(calls, 3);
});

test('reports timeout', async () => {
  handler = (_req, res) => setTimeout(() => res.end(JSON.stringify(result)), 100);
  await assert.rejects(decide({ timeoutMs: 10 }), error => error.code === 'TIMEOUT');
});
