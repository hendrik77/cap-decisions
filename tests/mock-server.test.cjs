const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { startMockServer } = require('../dist/mock-server');
const { mockDecision } = require('../dist/providers/mock-core');
const { SystemOneError } = require('../dist/validation');

const { fetch, AbortSignal } = globalThis;

const request = {
  state: 'I was billed twice. Please refund me.',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
    },
    urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Low', 'Medium', 'High'] },
    refund: { type: 'noul', instructions: 'Does the customer request a refund?' },
  },
};
const noulRequest = { state: 'Refund me', questions: { refund: request.questions.refund } };

async function withServer(options, body) {
  const server = await startMockServer({ port: 0, ...options });
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

const post = (server, body, init = {}) =>
  fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: init.signal,
  });
const jevError = (type, message) => ({ error: { type, ...(message ? { message } : {}) } });
const cloudflareError = (code, message) => ({
  success: false,
  errors: [{ code, ...(message ? { message } : {}) }],
  result: null,
});
const rejectsWith = (code, message) => (error) => {
  assert.ok(error instanceof SystemOneError, String(error));
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};
const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-mock-server-')));

describe('request table', () => {
  test('answers a valid request like the in-process mock', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      const expected = mockDecision(request, { strategy: 'keywords', rules: [], source: 'rules' });
      assert.deepEqual(await response.json(), expected);
    });
  });

  test('is deterministic across calls', async () => {
    await withServer({ strategy: 'seeded' }, async (server) => {
      const first = await (await post(server, request)).json();
      const second = await (await post(server, request)).json();
      assert.deepEqual(first, second);
      const expected = mockDecision(request, { strategy: 'seeded', rules: [], source: 'rules' });
      assert.deepEqual(first, expected);
    });
  });

  test('ignores model in the request', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, { ...request, model: 'something-else' });
      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        mockDecision(request, { strategy: 'keywords', rules: [], source: 'rules' }),
      );
    });
  });

  test('uses a fixture rule', async () => {
    const rules = [{ when: { question: 'department' }, answer: { choice: 'technical' } }];
    await withServer({ rules }, async (server) => {
      const body = await (await post(server, request)).json();
      assert.equal(body.answers.department.choice, 'technical');
      assert.deepEqual(
        body,
        mockDecision(request, {
          strategy: 'keywords',
          rules: require('../dist/providers/mock-fixtures').parseFixtures(rules),
          source: 'rules',
        }),
      );
    });
  });

  test('other path is 404', async () => {
    await withServer({}, async (server) => {
      const response = await fetch(new URL('/other', server.url), { method: 'POST', body: '{}' });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), jevError('not_found_error'));
    });
  });

  test('a query string does not change the path', async () => {
    await withServer({}, async (server) => {
      const response = await post({ url: `${server.url}?x=1` }, request);
      assert.equal(response.status, 200);
    });
  });

  test('other method is 405 with Allow: POST', async () => {
    await withServer({}, async (server) => {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await fetch(server.url, { method });
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.get('allow'), 'POST');
        await response.arrayBuffer();
      }
    });
  });

  test('a body larger than 1 MiB is 413', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, 'x'.repeat(1024 * 1024 + 1));
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), jevError('request_too_large'));
    });
  });

  test('a body of exactly 1 MiB is read', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, ' '.repeat(1024 * 1024));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.type, 'invalid_request_error');
    });
  });

  test('a chunked body that grows past 1 MiB is 413 and the server keeps working', async () => {
    await withServer({}, async (server) => {
      const outcome = await new Promise((resolve) => {
        const req = http.request(server.url, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
        req.on('response', (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', (error) => resolve(error.code));
        const chunk = Buffer.alloc(256 * 1024, 32);
        for (let i = 0; i < 8; i++) req.write(chunk);
        req.end();
      });
      assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(outcome), String(outcome));
      assert.equal((await post(server, request)).status, 200);
    });
  });

  test('invalid JSON is 400', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, '{nope');
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.type, 'invalid_request_error');
      assert.equal(typeof body.error.message, 'string');
    });
  });

  test('a request validateRequest rejects is 400 with its message', async () => {
    await withServer({}, async (server) => {
      const response = await post(server, { state: 'x', questions: {} });
      assert.equal(response.status, 400);
      assert.deepEqual(
        await response.json(),
        jevError('invalid_request_error', 'state and a non-empty questions map are required'),
      );
    });
  });

  test('a fixture answer that does not fit is 500 mock_fixture_error', async () => {
    const rules = [{ when: { question: 'department' }, answer: { choice: 'nowhere' } }];
    await withServer({ rules }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error.type, 'mock_fixture_error');
      assert.match(body.error.message, /^rules rule 0: answer does not fit question department/);
    });
  });

  test('checks path, then method, then token, then body', async () => {
    await withServer({ token: 'secret' }, async (server) => {
      const other = new URL('/other', server.url);
      assert.equal((await fetch(other, { method: 'GET' })).status, 404);
      assert.equal((await fetch(server.url, { method: 'GET' })).status, 405);
      assert.equal((await post(server, '{nope')).status, 401);
      const authorized = { headers: { authorization: 'Bearer secret' } };
      assert.equal((await post(server, '{nope', authorized)).status, 400);
      assert.equal((await post(server, request, authorized)).status, 200);
    });
  });
});

describe('failures', () => {
  test('HTTP_ERROR answers with its status and type', async () => {
    const fail = { code: 'HTTP_ERROR', status: 503, providerCode: 'overloaded' };
    await withServer({ fail }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), jevError('overloaded'));
    });
  });

  test('HTTP_ERROR without providerCode uses mock_error, also from a rule', async () => {
    const rules = [{ when: { question: 'refund' }, fail: 'HTTP_ERROR', status: 418 }];
    await withServer({ rules }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 418);
      assert.deepEqual(await response.json(), jevError('mock_error'));
    });
  });

  test('NETWORK_ERROR destroys the connection', async () => {
    await withServer({ fail: 'NETWORK_ERROR' }, async (server) => {
      await assert.rejects(post(server, request));
    });
  });

  test('TIMEOUT never answers, and close ends the held connection promptly', async () => {
    await withServer({ fail: 'TIMEOUT' }, async (server) => {
      await assert.rejects(post(server, request, { signal: AbortSignal.timeout(300) }));
      const held = post(server, request).then(
        () => 'answered',
        () => 'rejected',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      await server.close();
      assert.ok(Date.now() - started < 1000);
      assert.equal(await held, 'rejected');
    });
  });

  test('INVALID_RESPONSE answers 200 with a body that is not JSON', async () => {
    await withServer({ fail: 'INVALID_RESPONSE' }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      assert.equal(await response.text(), 'not json');
    });
  });

  test('PROVIDER_ERROR in jev format is a 500', async () => {
    await withServer({ fail: 'PROVIDER_ERROR' }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.type, 'provider_error');
    });
    await withServer({ fail: { code: 'PROVIDER_ERROR', providerCode: 'E42' } }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.type, 'E42');
    });
  });

  test('PROVIDER_ERROR in cloudflare format is a 200 with success false', async () => {
    await withServer(
      { format: 'cloudflare', fail: { code: 'PROVIDER_ERROR', providerCode: 'E42' } },
      async (server) => {
        const response = await post(server, request);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.success, false);
        assert.equal(body.result, null);
        assert.equal(body.errors[0].code, 'E42');
        assert.equal(typeof body.errors[0].message, 'string');
      },
    );
    await withServer({ format: 'cloudflare', fail: 'PROVIDER_ERROR' }, async (server) => {
      const body = await (await post(server, request)).json();
      assert.equal(body.errors[0].code, 'provider_error');
    });
  });

  test('a rule fail applies to the matching question only', async () => {
    const rules = [{ when: { question: 'urgency' }, fail: 'HTTP_ERROR', status: 500 }];
    await withServer({ rules }, async (server) => {
      assert.equal((await post(server, request)).status, 500);
      assert.equal((await post(server, noulRequest)).status, 200);
    });
  });
});

describe('formats', () => {
  test('cloudflare wraps the answer in the envelope', async () => {
    await withServer({ format: 'cloudflare' }, async (server) => {
      const response = await post(server, request);
      assert.equal(response.status, 200);
      const expected = mockDecision(request, { strategy: 'keywords', rules: [], source: 'rules' });
      assert.deepEqual(await response.json(), { success: true, errors: [], result: expected });
    });
  });

  test('cloudflare uses its envelope for error bodies', async () => {
    await withServer({ format: 'cloudflare', token: 'secret' }, async (server) => {
      const missing = await fetch(new URL('/other', server.url), { method: 'POST', body: '{}' });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), cloudflareError('not_found_error'));
      const denied = await post(server, request);
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), cloudflareError('authentication_error'));
      const invalid = await post(
        server,
        { state: 'x', questions: {} },
        { headers: { authorization: 'Bearer secret' } },
      );
      assert.equal(invalid.status, 400);
      assert.deepEqual(
        await invalid.json(),
        cloudflareError('invalid_request_error', 'state and a non-empty questions map are required'),
      );
    });
    await withServer(
      { format: 'cloudflare', fail: { code: 'HTTP_ERROR', status: 429, providerCode: 'slow' } },
      async (server) => {
        const response = await post(server, request);
        assert.equal(response.status, 429);
        assert.equal((await response.json()).errors[0].code, 'slow');
      },
    );
  });
});

describe('token', () => {
  test('requires the bearer token', async () => {
    await withServer({ token: 'secret' }, async (server) => {
      const missing = await post(server, request);
      assert.equal(missing.status, 401);
      assert.deepEqual(await missing.json(), jevError('authentication_error'));
      for (const authorization of ['Bearer wrong', 'Bearer secre', 'Bearer secrett', 'secret', 'Basic secret']) {
        assert.equal((await post(server, request, { headers: { authorization } })).status, 401, authorization);
      }
      const right = await post(server, request, { headers: { authorization: 'Bearer secret' } });
      assert.equal(right.status, 200);
    });
  });

  test('is not required when unset', async () => {
    await withServer({}, async (server) => {
      assert.equal((await post(server, request, { headers: { authorization: 'Bearer anything' } })).status, 200);
    });
  });
});

describe('latency', () => {
  test('delays the answer by latencyMs', async () => {
    await withServer({ latencyMs: 250 }, async (server) => {
      const started = Date.now();
      const response = await post(server, request);
      assert.equal(response.status, 200);
      assert.ok(Date.now() - started >= 240, `took ${Date.now() - started} ms`);
    });
  });

  test('a client that disconnects ends the wait', async () => {
    const lines = [];
    await withServer({ latencyMs: 30_000, log: (line) => lines.push(line) }, async (server) => {
      await assert.rejects(post(server, request, { signal: AbortSignal.timeout(100) }));
      for (let i = 0; i < 50 && !lines.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lines.length, 1);
      const started = Date.now();
      await server.close();
      assert.ok(Date.now() - started < 1000);
    });
  });

  test('close ends a request held by latency', async () => {
    const server = await startMockServer({ port: 0, latencyMs: 30_000 });
    const held = post(server, request).then(
      () => 'answered',
      () => 'rejected',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await server.close();
    assert.ok(Date.now() - started < 1000);
    assert.equal(await held, 'rejected');
  });
});

describe('options', () => {
  test('defaults to 127.0.0.1 and /v1/systemone and reports the url', async () => {
    await withServer({}, async (server) => {
      assert.equal(server.host, '127.0.0.1');
      assert.ok(server.port > 0);
      assert.equal(server.url, `http://127.0.0.1:${server.port}/v1/systemone`);
    });
  });

  test('path and host are configurable', async () => {
    await withServer({ path: '/jev', host: 'localhost' }, async (server) => {
      assert.equal(server.url, `http://localhost:${server.port}/jev`);
      assert.equal((await post(server, request)).status, 200);
    });
  });

  test('close can be called twice', async () => {
    const server = await startMockServer({ port: 0 });
    await server.close();
    await server.close();
  });

  test('log gets one line per request', async () => {
    const lines = [];
    await withServer({ log: (line) => lines.push(line) }, async (server) => {
      await post(server, request);
      await fetch(new URL('/other', server.url), { method: 'POST', body: '{}' });
      await fetch(server.url);
      for (let i = 0; i < 50 && lines.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^POST \/v1\/systemone 200 \d+ms$/);
    assert.match(lines[1], /^POST \/other 404 \d+ms$/);
    assert.match(lines[2], /^GET \/v1\/systemone 405 \d+ms$/);
  });

  test('a throwing log function does not break the server', async () => {
    await withServer(
      {
        log: () => {
          throw new Error('log failed');
        },
      },
      async (server) => {
        assert.equal((await post(server, request)).status, 200);
        assert.equal((await post(server, request)).status, 200);
      },
    );
  });

  test('reads the default fixtures file from root', async () => {
    const root = tempDir();
    try {
      fs.mkdirSync(path.join(root, 'test/data'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'test/data/systemone.json'),
        JSON.stringify([{ when: { question: 'department' }, answer: { choice: 'technical' } }]),
      );
      await withServer({ root }, async (server) => {
        assert.equal((await (await post(server, request)).json()).answers.department.choice, 'technical');
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads a configured fixtures file relative to root', async () => {
    const root = tempDir();
    try {
      fs.writeFileSync(
        path.join(root, 'rules.json'),
        JSON.stringify([{ when: { question: 'refund' }, answer: { noul: 0.123 } }]),
      );
      await withServer({ root, fixtures: 'rules.json' }, async (server) => {
        assert.equal((await (await post(server, request)).json()).answers.refund.noul, 0.123);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing default fixtures file is fine', async () => {
    const root = tempDir();
    try {
      await withServer({ root }, async (server) => {
        assert.equal((await post(server, request)).status, 200);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a rule error names the fixtures file', async () => {
    const root = tempDir();
    try {
      fs.writeFileSync(
        path.join(root, 'rules.json'),
        JSON.stringify([{ when: { question: 'department' }, answer: { choice: 'nowhere' } }]),
      );
      await withServer({ root, fixtures: 'rules.json' }, async (server) => {
        const body = await (await post(server, request)).json();
        assert.match(body.error.message, /^rules\.json rule 0:/);
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('invalid options', () => {
  test('fixtures together with rules', async () => {
    await assert.rejects(
      startMockServer({ port: 0, fixtures: 'a.json', rules: [] }),
      rejectsWith('INVALID_CONFIG', /fixtures.*rules|rules.*fixtures/),
    );
  });

  test('a missing configured fixtures file', async () => {
    const root = tempDir();
    try {
      await assert.rejects(
        startMockServer({ port: 0, root, fixtures: 'missing.json' }),
        rejectsWith('INVALID_CONFIG', /missing\.json/),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('invalid rules name the option', async () => {
    await assert.rejects(
      startMockServer({ port: 0, rules: [{ nonsense: true }] }),
      rejectsWith('INVALID_CONFIG', /^rules rule 0:/),
    );
    await assert.rejects(
      startMockServer({ port: 0, rules: {} }),
      rejectsWith('INVALID_CONFIG', /^rules must be an array/),
    );
  });

  test('format, strategy, latencyMs and fail', async () => {
    await assert.rejects(startMockServer({ port: 0, format: 'xml' }), rejectsWith('INVALID_CONFIG', /format/));
    await assert.rejects(startMockServer({ port: 0, strategy: 'random' }), rejectsWith('INVALID_CONFIG', /strategy/));
    await assert.rejects(startMockServer({ port: 0, latencyMs: -1 }), rejectsWith('INVALID_CONFIG', /latencyMs/));
    await assert.rejects(startMockServer({ port: 0, fail: 'NOPE' }), rejectsWith('INVALID_CONFIG', /^fail rule 0:/));
    await assert.rejects(
      startMockServer({ port: 0, fail: { code: 'HTTP_ERROR' } }),
      rejectsWith('INVALID_CONFIG', /^fail rule 0:.*status/),
    );
  });

  test('port, host, path, root, token and log', async () => {
    await assert.rejects(startMockServer({ port: -1 }), rejectsWith('INVALID_CONFIG', /port/));
    await assert.rejects(startMockServer({ port: 70000 }), rejectsWith('INVALID_CONFIG', /port/));
    await assert.rejects(startMockServer({ port: '80' }), rejectsWith('INVALID_CONFIG', /port/));
    await assert.rejects(startMockServer({ port: 0, host: '' }), rejectsWith('INVALID_CONFIG', /host/));
    await assert.rejects(startMockServer({ port: 0, path: 'v1' }), rejectsWith('INVALID_CONFIG', /path/));
    await assert.rejects(startMockServer({ port: 0, root: 5 }), rejectsWith('INVALID_CONFIG', /root/));
    await assert.rejects(startMockServer({ port: 0, token: '' }), rejectsWith('INVALID_CONFIG', /token/));
    await assert.rejects(startMockServer({ port: 0, log: 'yes' }), rejectsWith('INVALID_CONFIG', /log/));
    await assert.rejects(startMockServer({ port: 0, fixtures: '' }), rejectsWith('INVALID_CONFIG', /fixtures/));
  });

  test('a port in use rejects', async () => {
    await withServer({}, async (server) => {
      await assert.rejects(startMockServer({ port: server.port }), (error) => error.code === 'EADDRINUSE');
    });
  });
});

test('the module loads without @sap/cds', () => {
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '../dist/mock-server.js'))});
    console.log(Object.keys(require.cache).some((key) => key.includes('@sap/cds') || key.includes('@sap' + require('path').sep + 'cds')));`;
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(output.trim(), 'false');
});

test('options must be an object', async () => {
  for (const options of [null, [], 'port', 5]) {
    await assert.rejects(startMockServer(options), rejectsWith('INVALID_CONFIG', /options must be an object/));
  }
});

test('a client that closes the connection in the middle of the body gets no answer and the server keeps working', async () => {
  const net = require('node:net');
  const lines = [];
  await withServer({ log: (line) => lines.push(line) }, async (server) => {
    const socket = net.connect(server.port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    const received = [];
    socket.on('data', (chunk) => received.push(chunk));
    socket.on('error', () => undefined);
    socket.write(
      'POST /v1/systemone HTTP/1.1\r\nhost: localhost\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"state"',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    for (let i = 0; i < 50 && lines.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^POST \/v1\/systemone - \d+ms$/);
    assert.equal((await post(server, request)).status, 200);
  });
});

test('an unknown option name is INVALID_CONFIG', async () => {
  await assert.rejects(
    startMockServer({ port: 0, latency: 5 }),
    rejectsWith('INVALID_CONFIG', /Unknown mock server option "latency"/),
  );
});

test('a body far beyond the limit is answered 413 and the server keeps working', async () => {
  await withServer({}, async (server) => {
    const outcome = await new Promise((resolve) => {
      const req = http.request(server.url, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', (error) => resolve(error.code));
      const chunk = Buffer.alloc(1024 * 1024, 32);
      let sent = 0;
      const write = () => {
        while (sent < 12) {
          sent++;
          if (!req.write(chunk)) return void req.once('drain', write);
        }
        req.end();
      };
      write();
    });
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(outcome), String(outcome));
    assert.equal((await post(server, request)).status, 200);
  });
});

test('an IPv6 host is written in brackets in the URL', async () => {
  let server;
  try {
    server = await startMockServer({ port: 0, host: '::1' });
  } catch (error) {
    if (error.code === 'EADDRNOTAVAIL') return;
    throw error;
  }
  try {
    assert.match(server.url, /^http:\/\/\[::1\]:\d+\/v1\/systemone$/);
    assert.equal((await post(server, request)).status, 200);
  } finally {
    await server.close();
  }
});
