const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SystemOneError, validateRequest, validateSettings, CAP_SETTINGS_KEYS } = require('../dist/validation');
const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

const choice = (count) => ({
  type: 'choice',
  instructions: 'Choose',
  criteria: Object.fromEntries(Array.from({ length: count }, (_, index) => [`label${index}`, `Option ${index}`])),
});
const score = (count) => ({
  type: 'score',
  instructions: 'Rate',
  criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
});
const request = (questions) => ({ state: 'text', questions });
const invalidRequest = { name: 'SystemOneError', code: 'INVALID_REQUEST' };
const invalidConfig = { name: 'SystemOneError', code: 'INVALID_CONFIG' };

describe('validateRequest limits', () => {
  const typesafe = { choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } };

  test('choiceOptions limit', () => {
    validateRequest(request({ q: choice(255) }), typesafe);
    assert.throws(() => validateRequest(request({ q: choice(256) }), typesafe), invalidRequest);
    validateRequest(request({ q: choice(100) }), { choiceOptions: 100 });
    assert.throws(() => validateRequest(request({ q: choice(101) }), { choiceOptions: 100 }), invalidRequest);
  });

  test('scoreCriteria limits', () => {
    validateRequest(request({ q: score(2) }), typesafe);
    validateRequest(request({ q: score(10) }), typesafe);
    assert.throws(() => validateRequest(request({ q: score(1) }), typesafe), invalidRequest);
    assert.throws(() => validateRequest(request({ q: score(11) }), typesafe), invalidRequest);
  });

  test('questions limit', () => {
    const many = (count) => request(Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, choice(1)])));
    validateRequest(many(64), { questions: 64 });
    assert.throws(() => validateRequest(many(65), { questions: 64 }), {
      ...invalidRequest,
      message: 'At most 64 questions are supported',
    });
  });

  test('without limits only the protocol minimums apply', () => {
    validateRequest(request({ a: choice(1), b: score(1) }));
    validateRequest(request({ a: choice(300), b: score(30) }), {});
    assert.throws(() => validateRequest(request({ q: choice(0) })), invalidRequest);
    assert.throws(() => validateRequest(request({ q: score(0) })), invalidRequest);
    assert.throws(() => validateRequest(request({})), invalidRequest);
  });

  test('a score minimum below 1 is treated as 1', () => {
    validateRequest(request({ q: score(1) }), { scoreCriteria: { min: 0 } });
    assert.throws(() => validateRequest(request({ q: score(0) }), { scoreCriteria: { min: 0 } }), invalidRequest);
  });

  test('limit violations name the question', () => {
    assert.throws(() => validateRequest(request({ team: choice(3) }), { choiceOptions: 2 }), {
      ...invalidRequest,
      message: 'Invalid criteria for question team',
    });
  });
});

describe('validateSettings errors', () => {
  const invalid = (settings, message) =>
    assert.throws(() => validateSettings(settings), message ? { ...invalidConfig, message } : invalidConfig);

  test('settings must be a plain object', () => {
    for (const value of [null, 'text', 1, [], true]) invalid(value);
    assert.deepEqual(validateSettings(undefined), []);
  });

  test('model is rejected in favour of modelId', () => {
    for (const model of ['jev-latest', null, undefined, 1]) {
      assert.throws(() => validateSettings({ model }), { ...invalidConfig, message: /modelId/ });
    }
  });

  test('secrets at service level are rejected', () => {
    for (const key of ['token', 'url', 'accountId', 'destination']) {
      assert.throws(() => validateSettings({ [key]: 'x' }), { ...invalidConfig, message: /credentials/ });
    }
  });

  test('credentials must be an object with known string values', () => {
    invalid({ credentials: 'x' });
    invalid({ credentials: [] });
    invalid({ credentials: null });
    assert.throws(() => validateSettings({ credentials: { apiKey: 'x' } }), { ...invalidConfig, message: /apiKey/ });
    for (const key of ['url', 'token', 'accountId', 'destination']) invalid({ credentials: { [key]: 1 } });
    invalid({ credentials: { destination: '  ' } });
    invalid({ credentials: { destination: '' } });
  });

  test('modelId must be a non-empty string', () => {
    for (const modelId of ['', 1, null, {}]) invalid({ modelId });
  });

  test('requiresToken must be a boolean', () => {
    for (const requiresToken of ['true', 1, null]) invalid({ requiresToken });
  });

  test('timeoutMs must be a positive safe integer up to 2147483647', () => {
    for (const timeoutMs of [0, -1, 1.5, 2 ** 31, '1000', null, NaN, Infinity]) invalid({ timeoutMs });
    assert.deepEqual(validateSettings({ timeoutMs: 1 }), []);
    assert.deepEqual(validateSettings({ timeoutMs: 2_147_483_647 }), []);
  });

  test('limits must be well formed', () => {
    invalid({ limits: 'x' });
    invalid({ limits: [] });
    invalid({ limits: null });
    invalid({ limits: { unknown: 1 } });
    for (const key of ['questions', 'choiceOptions']) {
      for (const value of [0, -1, 1.5, '3', null]) invalid({ limits: { [key]: value } });
    }
    invalid({ limits: { scoreCriteria: 'x' } });
    invalid({ limits: { scoreCriteria: { other: 1 } } });
    for (const key of ['min', 'max']) {
      for (const value of [0, 1.5, '2', null]) invalid({ limits: { scoreCriteria: { [key]: value } } });
    }
    invalid({ limits: { scoreCriteria: { min: 5, max: 4 } } });
  });
});

describe('validateSettings warnings', () => {
  const full = {
    kind: 'systemone-typesafe',
    impl: 'cap-jev',
    modelId: 'jev-latest',
    timeoutMs: 10000,
    requiresToken: true,
    limits: { questions: 64, choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } },
    credentials: { url: 'https://example.test', token: 'secret', accountId: 'acc', destination: 'dest' },
  };

  test('a full valid settings object has no warnings', () => {
    assert.deepEqual(validateSettings(full), []);
    assert.deepEqual(validateSettings({ limits: { scoreCriteria: { min: 3, max: 3 } } }), []);
    assert.deepEqual(validateSettings({}), []);
  });

  test('an unknown key produces one warning', () => {
    assert.deepEqual(validateSettings({ ...full, foo: 1 }), [
      'Unknown setting "foo" for cds.requires.systemone is ignored',
    ]);
  });

  test('extraKeys suppress the warning', () => {
    assert.deepEqual(validateSettings({ ...full, foo: 1 }, ['foo']), []);
    assert.equal(validateSettings({ foo: 1, bar: 2 }, ['foo']).length, 1);
  });

  test('keys added by CAP produce no warning', () => {
    assert.ok(Array.isArray(CAP_SETTINGS_KEYS));
    const settings = Object.fromEntries(CAP_SETTINGS_KEYS.map((key) => [key, true]));
    assert.deepEqual(validateSettings(settings), []);
  });

  test('the options of a connected service produce no warning', async () => {
    const dir = createApp({ name: 'settings-app', cds: { requires: { systemone: { kind: 'systemone-laya' } } } });
    try {
      const options = await runInApp(
        dir,
        `(async () => {
          const cds = require('@sap/cds');
          const srv = await cds.connect.to('systemone');
          console.log(JSON.stringify(srv.options));
        })();`,
      );
      // Temporary until T3: the kinds still carry provider and model.
      delete options.provider;
      delete options.model;
      assert.deepEqual(validateSettings(options), []);
    } finally {
      removeApp(dir);
    }
  });
});

test('SystemOneError is exported from validation', () => {
  assert.ok(new SystemOneError('INVALID_CONFIG', 'x') instanceof Error);
});
