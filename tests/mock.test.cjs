const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

// Runs `body` inside an async function of a temporary app; the body prints one JSON line through out().
async function inApp(systemone, body, { files, env, extra } = {}) {
  const dir = createApp(
    { name: 'mock-app', private: true, cds: systemone === undefined ? {} : { requires: { systemone } }, ...extra },
    files,
  );
  const script = `
    const cds = require('@sap/cds');
    const out = (value) => console.log(JSON.stringify(value));
    const fail = (e) => out({ error: e.code || e.name, message: e.message, status: e.status, providerCode: e.providerCode });
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
    const departmentOnly = (state) => ({ state, questions: { department: request.questions.department } });
    (async () => {
      await cds.plugins;
      try {
        ${body}
      } catch (e) { fail(e); }
    })().catch((e) => { console.error(e); process.exit(1); });`;
  try {
    return await runInApp(dir, script, { env });
  } finally {
    removeApp(dir);
  }
}

const connect = `const srv = await cds.connect.to('systemone');`;
const decide = `${connect} const result = await srv.decide(request); out(result);`;
const expectError = (actual, code, message) => {
  assert.equal(actual.error, code, JSON.stringify(actual));
  if (message) assert.match(actual.message, message);
};
const json = (value) => JSON.stringify(value);

describe('activation', () => {
  const probe = `
    const impl = cds.env.requires.systemone.impl;
    const modelId = cds.env.requires.systemone.modelId;
    const url = cds.env.requires.systemone.credentials && cds.env.requires.systemone.credentials.url;
    let name;
    let error;
    try { name = (await cds.connect.to('systemone')).constructor.name; } catch (e) { error = e.code || e.name; }
    out({ impl, modelId, url, name, error });`;
  const MOCK = 'cap-jev/providers/mock';
  const mock = { impl: MOCK, name: 'MockService' };
  const token = { token: 't' };

  const rows = [
    {
      title: 'no systemone entry',
      config: undefined,
      development: mock,
      test: mock,
      production: { impl: 'cap-jev', error: 'INVALID_CONFIG' },
    },
    {
      title: 'an explicit kind',
      config: { kind: 'systemone-typesafe', credentials: token },
      development: { impl: 'cap-jev', modelId: 'jev-latest', name: 'DecisionsService' },
      test: { impl: 'cap-jev', modelId: 'jev-latest', name: 'DecisionsService' },
      production: { impl: 'cap-jev', modelId: 'jev-latest', name: 'DecisionsService' },
    },
    {
      title: 'a kind only for production',
      config: { '[production]': { kind: 'systemone-typesafe' }, credentials: token },
      development: mock,
      test: mock,
      production: { impl: 'cap-jev', modelId: 'jev-latest', name: 'DecisionsService' },
    },
    {
      title: 'only credentials.url and no kind',
      config: { credentials: { url: 'https://example.com/v1/systemone' } },
      development: mock,
      test: mock,
      production: { impl: 'cap-jev', url: 'https://example.com/v1/systemone', name: 'DecisionsService' },
    },
  ];

  for (const row of rows) {
    for (const profile of ['development', 'test', 'production']) {
      test(`${row.title} in ${profile}`, async () => {
        const result = await inApp(row.config, probe, { env: { CDS_ENV: profile } });
        const expected = { error: undefined, ...row[profile] };
        assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, result[key]])), expected);
      });
    }
  }

  test('the package exports the provider entry point', async () => {
    const result = await inApp(
      undefined,
      `const m = require('cap-jev/providers/mock');
       out({ same: m.default === m.MockService, name: m.default.name, base: Object.getPrototypeOf(m.default) === require('cap-jev').DecisionsService, keys: m.default.settingsKeys });`,
    );
    assert.deepEqual(result, {
      same: true,
      name: 'MockService',
      base: true,
      keys: ['fixtures', 'strategy', 'latencyMs', 'fail', 'allowInProduction'],
    });
  });
});

describe('production', () => {
  test('the mock kind is refused in production', async () => {
    const result = await inApp({ kind: 'systemone-mock' }, `${connect} out({ ok: true });`, {
      env: { CDS_ENV: 'production' },
    });
    expectError(result, 'INVALID_CONFIG', /disabled in production.*allowInProduction: true/);
  });

  test('allowInProduction lets the mock answer in production', async () => {
    const result = await inApp({ kind: 'systemone-mock', allowInProduction: true }, decide, {
      env: { CDS_ENV: 'production' },
    });
    assert.equal(result.model, 'mock');
    assert.equal(result.answers.department.type, 'choice');
  });

  test('allowInProduction must be a boolean', async () => {
    const result = await inApp({ kind: 'systemone-mock', allowInProduction: 'yes' }, connect, {
      env: { CDS_ENV: 'production' },
    });
    expectError(result, 'INVALID_CONFIG', /allowInProduction/);
  });
});

describe('answers', () => {
  test('the same request gives identical, valid answers', async () => {
    const result = await inApp(
      undefined,
      `${connect}
       const first = await srv.decide(request);
       const second = await srv.decide(JSON.parse(JSON.stringify(request)));
       out({ first, second });`,
    );
    assert.deepEqual(result.first, result.second);
    assert.equal(result.first.model, 'mock');
    assert.deepEqual(Object.keys(result.first.answers), ['department', 'urgency', 'refund']);
    assert.equal(result.first.answers.urgency.type, 'score');
    assert.equal(result.first.answers.refund.type, 'noul');
    assert.ok(result.first.usage.input_tokens > 0 && result.first.usage.output_tokens > 0);
  });

  test('the keywords strategy routes a billing message to billing', async () => {
    const result = await inApp(undefined, `${connect} out(await srv.decide(request));`);
    assert.equal(result.answers.department.choice, 'billing');
    assert.deepEqual(Object.keys(result.answers.department.probabilities).sort(), ['billing', 'technical']);
  });

  test('the seeded strategy answers deterministically with a valid choice', async () => {
    const result = await inApp(
      { kind: 'systemone-mock', strategy: 'seeded' },
      `${connect}
       const first = await srv.decide(request);
       const second = await srv.decide(request);
       out({ same: JSON.stringify(first) === JSON.stringify(second), choice: first.answers.department.choice });`,
    );
    assert.equal(result.same, true);
    assert.ok(['billing', 'technical'].includes(result.choice));
  });
});

describe('fixtures', () => {
  const refundToBilling = (answer = { choice: 'billing' }) =>
    json([{ when: { question: 'department', stateIncludes: 'refund' }, answer }]);
  const refundRun = `${connect}
    const matched = await srv.decide(departmentOnly('The integration errors need a refund'));
    const other = await srv.decide(departmentOnly('The integration errors'));
    out({ matched: matched.answers.department.choice, other: other.answers.department.choice });`;

  test('test/data/systemone.json is used by default', async () => {
    const result = await inApp(undefined, refundRun, { files: { 'test/data/systemone.json': refundToBilling() } });
    assert.deepEqual(result, { matched: 'billing', other: 'technical' });
  });

  test('fixtures names another file relative to the project root', async () => {
    const result = await inApp({ kind: 'systemone-mock', fixtures: 'srv/rules.json' }, refundRun, {
      files: {
        'srv/rules.json': refundToBilling(),
        'test/data/systemone.json': refundToBilling({ choice: 'technical' }),
      },
    });
    assert.deepEqual(result, { matched: 'billing', other: 'technical' });
  });

  test('a missing default file is not an error', async () => {
    const result = await inApp(undefined, refundRun);
    assert.equal(result.error, undefined, JSON.stringify(result));
  });

  test('a missing configured file fails with INVALID_CONFIG', async () => {
    const result = await inApp({ kind: 'systemone-mock', fixtures: 'srv/missing.json' }, connect);
    expectError(result, 'INVALID_CONFIG', /srv\/missing\.json/);
  });

  test('malformed JSON fails with INVALID_CONFIG on connect', async () => {
    const result = await inApp(undefined, `${connect} out({ ok: true });`, {
      files: { 'test/data/systemone.json': '[{ not json' },
    });
    expectError(result, 'INVALID_CONFIG', /test\/data\/systemone\.json/);
  });

  test('an invalid rule fails with INVALID_CONFIG naming the rule', async () => {
    const result = await inApp(undefined, `${connect} out({ ok: true });`, {
      files: { 'test/data/systemone.json': json([{ when: { question: 'q' }, answer: { choice: 'a' } }, { bogus: 1 }]) },
    });
    expectError(result, 'INVALID_CONFIG', /test\/data\/systemone\.json rule 1/);
  });

  test('a fixture answer that does not fit fails with INVALID_CONFIG on decide', async () => {
    const result = await inApp(undefined, decide, {
      files: { 'test/data/systemone.json': refundToBilling({ choice: 'nowhere' }) },
    });
    expectError(result, 'INVALID_CONFIG', /rule 0.*department/);
  });

  test('a fail rule throws its error with status and providerCode', async () => {
    const rules = json([
      { when: { stateIncludes: 'refund' }, fail: 'HTTP_ERROR', status: 503, providerCode: 'overloaded' },
    ]);
    const result = await inApp(undefined, decide, { files: { 'test/data/systemone.json': rules } });
    assert.equal(result.error, 'HTTP_ERROR');
    assert.equal(result.status, 503);
    assert.equal(result.providerCode, 'overloaded');
  });
});

describe('global fail', () => {
  const cases = [
    ['INVALID_RESPONSE', 'INVALID_RESPONSE', {}],
    [{ code: 'HTTP_ERROR', status: 503 }, 'HTTP_ERROR', { status: 503 }],
    ['PROVIDER_ERROR', 'PROVIDER_ERROR', {}],
    [{ code: 'PROVIDER_ERROR', providerCode: 'quota' }, 'PROVIDER_ERROR', { providerCode: 'quota' }],
    ['NETWORK_ERROR', 'NETWORK_ERROR', {}],
    ['TIMEOUT', 'TIMEOUT', {}],
  ];
  for (const [fail, code, fields] of cases) {
    test(`fail ${json(fail)} throws ${code}`, async () => {
      const result = await inApp({ kind: 'systemone-mock', fail }, decide);
      assert.equal(result.error, code);
      assert.equal(result.status, fields.status);
      assert.equal(result.providerCode, fields.providerCode);
    });
  }

  test('a global fail wins over fixture rules', async () => {
    const rules = json([{ when: { question: 'department' }, answer: { choice: 'billing' } }]);
    const result = await inApp({ kind: 'systemone-mock', fail: 'NETWORK_ERROR' }, decide, {
      files: { 'test/data/systemone.json': rules },
    });
    assert.equal(result.error, 'NETWORK_ERROR');
  });

  test('invalid settings fail with INVALID_CONFIG', async () => {
    const configs = [
      { fail: 'UNKNOWN' },
      { fail: 'INVALID_REQUEST' },
      { fail: 'HTTP_ERROR' },
      { fail: { code: 'HTTP_ERROR', status: 200 } },
      { fail: { code: 'TIMEOUT', status: 503 } },
      { fail: { status: 503 } },
      { fail: 42 },
      { strategy: 'random' },
      { strategy: 7 },
      { latencyMs: -1 },
      { latencyMs: 1.5 },
      { latencyMs: '10' },
      { fixtures: '' },
      { fixtures: 5 },
      { allowInProduction: 'yes' },
    ];
    const result = await inApp(
      undefined,
      `const MockService = require('cap-jev/providers/mock').default;
       const codes = [];
       for (const settings of ${json(configs)}) {
         try { await new MockService('systemone', undefined, settings).init(); codes.push('ok'); } catch (e) { codes.push(e.code); }
       }
       out(codes);`,
    );
    assert.deepEqual(
      result,
      configs.map(() => 'INVALID_CONFIG'),
    );
  });

  test('an unknown strategy fails on connect', async () => {
    const result = await inApp({ kind: 'systemone-mock', strategy: 'random' }, connect);
    expectError(result, 'INVALID_CONFIG', /strategy/);
  });
});

describe('latency', () => {
  const timed = (tail = '') => `
    const started = performance.now();
    ${connect}
    ${tail}
    try {
      await srv.decide(request, ${tail ? '{ signal: controller.signal }' : '{}'});
      out({ ok: true, elapsed: performance.now() - started });
    } catch (e) {
      out({ error: e.code, elapsed: performance.now() - started });
    }`;

  test('latencyMs delays the answer', async () => {
    const result = await inApp({ kind: 'systemone-mock', latencyMs: 50, timeoutMs: 1000 }, timed());
    assert.equal(result.ok, true);
    assert.ok(result.elapsed >= 49, `elapsed ${result.elapsed}`);
  });

  test('latencyMs beyond timeoutMs gives TIMEOUT after about timeoutMs', async () => {
    const result = await inApp({ kind: 'systemone-mock', latencyMs: 200, timeoutMs: 50 }, timed());
    assert.equal(result.error, 'TIMEOUT');
    assert.ok(result.elapsed >= 49 && result.elapsed < 180, `elapsed ${result.elapsed}`);
  });

  test('aborting during the delay gives ABORTED', async () => {
    const result = await inApp(
      { kind: 'systemone-mock', latencyMs: 2000, timeoutMs: 5000 },
      timed(`const controller = new AbortController(); setTimeout(() => controller.abort(), 30);`),
    );
    assert.equal(result.error, 'ABORTED');
    assert.ok(result.elapsed < 1000, `elapsed ${result.elapsed}`);
  });

  test('an already aborted signal gives ABORTED at once, with the reason as cause', async () => {
    const result = await inApp(
      { kind: 'systemone-mock', latencyMs: 2000 },
      `${connect}
       const reason = new Error('stop');
       try { await srv.decide(request, { signal: AbortSignal.abort(reason) }); out({ ok: true }); }
       catch (e) { out({ error: e.code, cause: e.cause && e.cause.message }); }`,
    );
    assert.deepEqual(result, { error: 'ABORTED', cause: 'stop' });
  });

  test('without latencyMs an aborted signal still gives ABORTED', async () => {
    const result = await inApp(
      undefined,
      `${connect}
       try { await srv.decide(request, { signal: AbortSignal.abort() }); out({ ok: true }); }
       catch (e) { out({ error: e.code }); }`,
    );
    assert.deepEqual(result, { error: 'ABORTED' });
  });
});

describe('isolation from the network', () => {
  test('decide succeeds with a fetch that throws', async () => {
    const result = await inApp(
      undefined,
      `globalThis.fetch = () => { throw new Error('network is not allowed'); };
       ${connect}
       const result = await srv.decide(request);
       out({ model: result.model });`,
    );
    assert.deepEqual(result, { model: 'mock' });
  });
});

describe('base class behaviour', () => {
  test('before and after handlers run on decide', async () => {
    const result = await inApp(
      undefined,
      `${connect}
       const seen = [];
       srv.before('decide', (req) => { seen.push('before'); req.data.state = 'Technical errors in the API integration'; });
       srv.after('decide', (res) => { seen.push('after:' + res.model); });
       const result = await srv.decide(request);
       out({ seen, choice: result.answers.department.choice });`,
    );
    assert.deepEqual(result.seen, ['before', 'after:mock']);
    assert.equal(result.choice, 'technical');
  });

  test('an invalid request fails with INVALID_REQUEST before the mock answers or fails', async () => {
    const result = await inApp(
      { kind: 'systemone-mock', fail: 'PROVIDER_ERROR', latencyMs: 2000 },
      `${connect} await srv.decide({ state: 'x', questions: {} }); out({ ok: true });`,
    );
    expectError(result, 'INVALID_REQUEST');
  });

  test('limits apply to the mock', async () => {
    const result = await inApp(
      { kind: 'systemone-mock', limits: { questions: 1 } },
      `${connect} await srv.decide(request); out({ ok: true });`,
    );
    expectError(result, 'INVALID_REQUEST', /At most 1/);
  });
});

describe('startup warning', () => {
  const warned = `const warnings = [];
    cds.log('systemone').warn = (...args) => warnings.push(args.join(' '));`;

  test('logs exactly one warning on connect', async () => {
    const result = await inApp(undefined, `${warned} ${connect} await srv.decide(request); out({ warnings });`);
    assert.deepEqual(result.warnings, [
      'Using the mock provider: answers are simulated. Set a kind such as systemone-laya to use a real endpoint in development.',
    ]);
  });

  test('the mock settings keys are not reported as unknown', async () => {
    const result = await inApp(
      {
        kind: 'systemone-mock',
        fixtures: 'srv/rules.json',
        strategy: 'seeded',
        latencyMs: 1,
        fail: 'TIMEOUT',
        allowInProduction: true,
      },
      `${warned} ${connect} out({ warnings });`,
      { files: { 'srv/rules.json': '[]' } },
    );
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Using the mock provider/);
  });

  test('an unknown setting is still reported', async () => {
    const result = await inApp({ kind: 'systemone-mock', bogus: 1 }, `${warned} ${connect} out({ warnings });`);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((warning) => /bogus/.test(warning)));
  });
});

test('a signal that is never aborted does not disturb the delay', async () => {
  const result = await inApp(
    { kind: 'systemone-mock', latencyMs: 40, timeoutMs: 1000 },
    `${connect}
     const controller = new AbortController();
     const started = performance.now();
     const result = await srv.decide(request, { signal: controller.signal });
     out({ model: result.model, elapsed: performance.now() - started });`,
  );
  assert.equal(result.model, 'mock');
  assert.ok(result.elapsed >= 39, `elapsed ${result.elapsed}`);
});
