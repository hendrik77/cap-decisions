const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMockOptions, loadFixtures, mockDecision, DEFAULT_FIXTURES } = require('../dist/providers/mock-core');
const { mockResult } = require('../dist/providers/mock-engine');
const { DecisionsError } = require('../dist/validation');

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

const invalidConfig = (message) => (error) => {
  assert.ok(error instanceof DecisionsError);
  assert.equal(error.code, 'INVALID_CONFIG');
  assert.match(error.message, message);
  return true;
};
const failsWith = (code, status) => (error) => {
  assert.ok(error instanceof DecisionsError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};

describe('parseMockOptions', () => {
  test('applies defaults', () => {
    assert.deepEqual(parseMockOptions({}), { strategy: 'keywords', latencyMs: 0 });
  });

  test('normalizes all options', () => {
    const options = parseMockOptions({ strategy: 'seeded', latencyMs: 25, fixtures: 'a.json', fail: 'TIMEOUT' });
    assert.equal(options.strategy, 'seeded');
    assert.equal(options.latencyMs, 25);
    assert.equal(options.fixtures, 'a.json');
    assert.equal(options.fail.fail, 'TIMEOUT');
  });

  test('accepts a fail object', () => {
    const { fail } = parseMockOptions({ fail: { code: 'HTTP_ERROR', status: 503, providerCode: 'BUSY' } });
    assert.equal(fail.fail, 'HTTP_ERROR');
    assert.equal(fail.status, 503);
    assert.equal(fail.providerCode, 'BUSY');
  });

  test('rejects an unknown strategy', () => {
    assert.throws(() => parseMockOptions({ strategy: 'random' }), invalidConfig(/strategy must be keywords or seeded/));
  });

  test('rejects a negative or non-integer latencyMs', () => {
    for (const latencyMs of [-1, 1.5, '10', Number.NaN]) {
      assert.throws(
        () => parseMockOptions({ latencyMs }),
        invalidConfig(/latencyMs must be a non-negative integer/),
        String(latencyMs),
      );
    }
  });

  test('rejects empty or non-string fixtures', () => {
    for (const fixtures of ['', 5]) {
      assert.throws(() => parseMockOptions({ fixtures }), invalidConfig(/fixtures must be a non-empty file path/));
    }
  });

  test('rejects a fail that is neither string nor object', () => {
    assert.throws(() => parseMockOptions({ fail: 5 }), invalidConfig(/fail must be an error code or an object/));
    assert.throws(() => parseMockOptions({ fail: [] }), invalidConfig(/fail must be an error code or an object/));
  });

  test('rejects a fail object with an unknown key', () => {
    assert.throws(
      () => parseMockOptions({ fail: { code: 'TIMEOUT', retry: true } }),
      invalidConfig(/Unknown property "retry" in fail/),
    );
  });

  test('rejects an unknown fail code and HTTP_ERROR without status with messages for the setting', () => {
    assert.throws(
      () => parseMockOptions({ fail: 'BOOM' }),
      invalidConfig(/^cds\.requires\.decisions\.fail: code must be one of INVALID_RESPONSE, HTTP_ERROR/),
    );
    assert.throws(
      () => parseMockOptions({ fail: { code: 'HTTP_ERROR' } }),
      invalidConfig(/^cds\.requires\.decisions\.fail: HTTP_ERROR needs a status from 400 to 599$/),
    );
    assert.throws(
      () => parseMockOptions({ fail: { status: 503 } }),
      invalidConfig(/^cds\.requires\.decisions\.fail needs a code$/),
    );
    assert.throws(
      () => parseMockOptions({ fail: { code: 'TIMEOUT', status: 503 } }),
      invalidConfig(/^cds\.requires\.decisions\.fail: status only goes with HTTP_ERROR$/),
    );
  });
});

describe('loadFixtures', () => {
  const dirs = [];
  const tempDir = (files = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-core-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };
  test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  test('exports the default path', () => {
    assert.equal(DEFAULT_FIXTURES, 'test/data/decisions.json');
  });

  test('a missing default file gives no rules', async () => {
    assert.deepEqual(await loadFixtures(tempDir(), DEFAULT_FIXTURES, false), []);
  });

  test('a missing configured file fails', async () => {
    await assert.rejects(
      loadFixtures(tempDir(), 'missing.json', true),
      invalidConfig(/^Cannot read the fixtures file missing\.json$/),
    );
  });

  test('invalid JSON fails', async () => {
    const root = tempDir({ 'bad.json': '{nope' });
    await assert.rejects(loadFixtures(root, 'bad.json', true), invalidConfig(/^bad\.json is not valid JSON$/));
  });

  test('a non-array fails', async () => {
    const root = tempDir({ 'obj.json': '{}' });
    await assert.rejects(loadFixtures(root, 'obj.json', true), invalidConfig(/^obj\.json must be an array of rules$/));
  });

  test('a malformed rule names its index', async () => {
    const root = tempDir({ 'rules.json': '[{"fail":"BOOM"}]' });
    await assert.rejects(loadFixtures(root, 'rules.json', true), invalidConfig(/^rules\.json rule 0: /));
  });

  test('loads the default file and resolves nested paths against the root', async () => {
    const rules = JSON.stringify([{ when: { question: 'department' }, answer: { choice: 'billing' } }]);
    const root = tempDir({ [DEFAULT_FIXTURES]: rules, 'other/rules.json': '[{"fail":"TIMEOUT"}]' });
    assert.equal((await loadFixtures(root, DEFAULT_FIXTURES, false))[0].answer.choice, 'billing');
    assert.equal((await loadFixtures(root, 'other/rules.json', true))[0].fail, 'TIMEOUT');
  });
});

describe('mockDecision', () => {
  const source = 'rules.json';
  const base = { strategy: 'keywords', rules: [], source };

  test('without rules it equals mockResult', () => {
    assert.deepEqual(mockDecision(request, base), mockResult(request, 'keywords'));
    assert.deepEqual(mockDecision(request, { ...base, strategy: 'seeded' }), mockResult(request, 'seeded'));
  });

  test('is deterministic', () => {
    const options = { ...base, rules: [{ when: { question: 'urgency' }, answer: { score: 2 } }] };
    assert.deepEqual(mockDecision(request, options), mockDecision(request, options));
  });

  test('the global fail comes before the rules', () => {
    const options = { ...base, fail: { fail: 'HTTP_ERROR', status: 503 }, rules: [{ fail: 'TIMEOUT' }] };
    assert.throws(() => mockDecision(request, options), failsWith('HTTP_ERROR', 503));
  });

  test('a fail rule comes before the engine', () => {
    const options = { ...base, rules: [{ when: { stateIncludes: ['refund'] }, fail: 'NETWORK_ERROR' }] };
    assert.throws(() => mockDecision(request, options), failsWith('NETWORK_ERROR'));
  });

  test('a fail rule for another question does not fire', () => {
    const options = { ...base, rules: [{ when: { question: 'missing' }, fail: 'TIMEOUT' }] };
    assert.deepEqual(mockDecision(request, options), mockResult(request, 'keywords'));
  });

  test('a rule answer is used for its question, the engine for the rest', () => {
    const options = { ...base, rules: [{ when: { question: 'department' }, answer: { choice: 'technical' } }] };
    const result = mockDecision(request, options);
    const expected = mockResult(request, 'keywords');
    assert.equal(result.answers.department.choice, 'technical');
    assert.deepEqual(result.answers.urgency, expected.answers.urgency);
    assert.deepEqual(result.answers.refund, expected.answers.refund);
    assert.equal(result.model, 'mock');
  });

  test('a rule answer that does not fit names the source and rule', () => {
    const options = { ...base, rules: [{ when: { question: 'department' }, answer: { choice: 'nowhere' } }] };
    assert.throws(
      () => mockDecision(request, options),
      invalidConfig(/^rules\.json rule 0: answer does not fit question department/),
    );
  });
});
