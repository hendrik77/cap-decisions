const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseFixtures, findRule, ruleAnswer, ruleError } = require('../dist/providers/mock-fixtures');
const { SystemOneError, validateResult } = require('../dist/validation');

const department = {
  type: 'choice',
  instructions: 'Which department?',
  criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
};
const rating = { type: 'score', instructions: 'Rate', criteria: ['Poor', 'Fair', 'Good'] };
const urgent = { type: 'noul', instructions: 'Is it urgent?' };

const invalidConfig = (message) => ({ name: 'SystemOneError', code: 'INVALID_CONFIG', message });
const reasonAt = (source, index) => (error) => {
  assert.ok(error instanceof SystemOneError);
  assert.equal(error.code, 'INVALID_CONFIG');
  assert.match(error.message, new RegExp(`^${source.replace('.', '\\.')} rule ${index}: \\S`));
  return true;
};
const rule = (extra) => ({ answer: { choice: 'billing' }, when: { question: 'department' }, ...extra });

describe('parseFixtures', () => {
  test('parses a valid file and normalises stateIncludes', () => {
    const rules = parseFixtures([
      { when: { stateIncludes: 'refund', question: 'department' }, answer: { choice: 'billing' } },
      { when: { stateIncludes: ['Down', 'outage'] }, fail: 'HTTP_ERROR', status: 503, providerCode: 'BUSY' },
      { fail: 'TIMEOUT' },
      { when: { question: 'rating' }, answer: { score: 2 } },
      { fail: 'PROVIDER_ERROR', providerCode: 'X1' },
    ]);
    assert.equal(rules.length, 5);
    assert.deepEqual(rules[0], {
      when: { stateIncludes: ['refund'], question: 'department' },
      answer: { choice: 'billing' },
    });
    assert.deepEqual(rules[1].when.stateIncludes, ['Down', 'outage']);
    assert.equal(rules[1].fail, 'HTTP_ERROR');
    assert.equal(rules[1].status, 503);
    assert.equal(rules[1].providerCode, 'BUSY');
    assert.equal(rules[2].fail, 'TIMEOUT');
    assert.equal(rules[2].when, undefined);
    assert.deepEqual(parseFixtures([]), []);
  });

  test('a non-array top level is rejected', () => {
    for (const raw of [{}, 'rules', null, undefined, 3]) {
      assert.throws(() => parseFixtures(raw), invalidConfig('fixtures must be an array of rules'));
    }
    assert.throws(() => parseFixtures({}, 'test/data/systemone.json'), {
      code: 'INVALID_CONFIG',
      message: 'test/data/systemone.json must be an array of rules',
    });
  });

  test('malformed rules name the rule index and the source', () => {
    const good = rule();
    const malformed = {
      'not an object': 'refund',
      'an array': [],
      null: null,
      'answer and fail': { ...good, fail: 'TIMEOUT' },
      'neither answer nor fail': { when: { question: 'department' } },
      'answer without question': { answer: { choice: 'billing' } },
      'answer with when but no question': { when: { stateIncludes: 'x' }, answer: { choice: 'billing' } },
      'answer not an object': { when: { question: 'q' }, answer: 'billing' },
      'unknown fail code': { fail: 'EXPLODED' },
      'fail code not allowed': { fail: 'INVALID_CONFIG' },
      'fail not a string': { fail: 500 },
      'HTTP_ERROR without status': { fail: 'HTTP_ERROR' },
      'HTTP_ERROR with status 200': { fail: 'HTTP_ERROR', status: 200 },
      'HTTP_ERROR with status 600': { fail: 'HTTP_ERROR', status: 600 },
      'HTTP_ERROR with fractional status': { fail: 'HTTP_ERROR', status: 503.5 },
      'HTTP_ERROR with string status': { fail: 'HTTP_ERROR', status: '503' },
      'status on a non-HTTP failure': { fail: 'TIMEOUT', status: 503 },
      'status on an answer': { ...good, status: 503 },
      'providerCode not a string': { fail: 'PROVIDER_ERROR', providerCode: 5 },
      'stateIncludes a number': { when: { stateIncludes: 5 }, fail: 'TIMEOUT' },
      'stateIncludes with a non-string item': { when: { stateIncludes: ['a', 5] }, fail: 'TIMEOUT' },
      'stateIncludes empty array': { when: { stateIncludes: [] }, fail: 'TIMEOUT' },
      'question not a string': { when: { question: 3 }, fail: 'TIMEOUT' },
      'when not an object': { when: 'x', fail: 'TIMEOUT' },
      'unknown property': { fail: 'TIMEOUT', stateIncludes: 'x' },
      'unknown when property': { when: { includes: 'x' }, fail: 'TIMEOUT' },
    };
    for (const [name, bad] of Object.entries(malformed)) {
      assert.throws(() => parseFixtures([good, bad]), reasonAt('fixtures', 1), name);
    }
  });
});

describe('parseFixtures source', () => {
  test('the source name prefixes the message', () => {
    for (const bad of [{ fail: 'EXPLODED' }, { answer: {} }, 'x']) {
      assert.throws(() => parseFixtures([bad], 'my.json'), reasonAt('my.json', 0));
    }
  });
});

describe('findRule', () => {
  const rules = parseFixtures([
    { when: { stateIncludes: 'refund', question: 'department' }, answer: { choice: 'billing' } },
    { when: { stateIncludes: ['Outage', 'down'] }, fail: 'HTTP_ERROR', status: 503 },
    { when: { question: 'urgent' }, answer: { noul: 1 } },
    { fail: 'TIMEOUT' },
  ]);

  test('the first match wins', () => {
    const match = findRule(rules, 'I want a refund, the service is down', 'department');
    assert.equal(match.index, 0);
    assert.equal(match.rule, rules[0]);
    assert.equal(findRule(rules, 'I want a refund, the service is down', 'other').index, 1);
    assert.equal(findRule(rules, 'nothing special', 'department').index, 3);
  });

  test('question filtering', () => {
    assert.equal(findRule(rules, 'a refund', 'urgent').index, 2);
    assert.equal(findRule(rules, 'a refund', 'department').index, 0);
    assert.equal(findRule(rules, 'plain', 'urgent').index, 2);
    assert.equal(findRule(rules, 'plain', 'department').index, 3);
  });

  test('string and array stateIncludes', () => {
    assert.equal(findRule(rules, 'the system is down', 'x').index, 1);
    assert.equal(findRule(rules, 'a major outage', 'x').index, 1);
    assert.equal(findRule(rules, 'all fine', 'x').index, 3);
  });

  test('matching is case-insensitive and by substring', () => {
    assert.equal(findRule(rules, 'REFUNDS please', 'department').index, 0);
    assert.equal(findRule(rules, 'a major OUTAGE', 'x').index, 1);
    const upper = parseFixtures([{ when: { stateIncludes: 'ReFuNd' }, fail: 'TIMEOUT' }]);
    assert.equal(findRule(upper, 'refund', 'x').index, 0);
  });

  test('matches object and array states through their string values', () => {
    assert.equal(findRule(rules, { message: 'Refund me', customer: { id: 7 } }, 'department').index, 0);
    assert.equal(findRule(rules, ['hello', { note: 'down' }], 'x').index, 1);
    assert.equal(findRule(rules, { refund: 'no', other: 1 }, 'department').index, 3);
  });

  test('string values of the state are joined with a space', () => {
    const joined = parseFixtures([{ when: { stateIncludes: 'refund order' }, fail: 'TIMEOUT' }]);
    assert.equal(findRule(joined, { a: 'refund', b: 'order' }, 'x').index, 0);
  });

  test('unmatched gives undefined', () => {
    const only = parseFixtures([{ when: { stateIncludes: 'refund', question: 'department' }, fail: 'TIMEOUT' }]);
    assert.equal(findRule(only, 'nothing', 'department'), undefined);
    assert.equal(findRule(only, 'refund', 'other'), undefined);
    assert.equal(findRule([], 'refund', 'department'), undefined);
  });
});

describe('ruleAnswer', () => {
  const run = (question, answer, id = 'q', source) => {
    const parsed = parseFixtures([{ when: { question: id }, answer }]);
    return ruleAnswer(parsed[0], 0, question, 'a refund', id, source);
  };
  const check = (question, answer, id = 'q') =>
    validateResult(
      { model: 'mock', answers: { [id]: answer }, usage: { input_tokens: 1, output_tokens: 1 } },
      { [id]: question },
    );

  test('completes a partial choice answer', () => {
    const answer = run(department, { choice: 'billing' });
    assert.equal(answer.type, 'choice');
    assert.equal(answer.choice, 'billing');
    assert.equal(answer.confidence, Math.max(...Object.values(answer.probabilities)));
    check(department, answer);
  });

  test('completes score and noul answers', () => {
    const scored = run(rating, { score: 1.4 });
    assert.equal(scored.type, 'score');
    assert.equal(scored.score, 1.4);
    check(rating, scored);
    const noul = run(urgent, { noul: 0.25 });
    assert.deepEqual(noul, { type: 'noul', noul: 0.25 });
    check(urgent, noul);
  });

  test('keeps a complete answer as given', () => {
    const full = { choice: 'technical', probabilities: { billing: 0.2, technical: 0.8 }, confidence: 0.8 };
    assert.deepEqual(run(department, full), { type: 'choice', ...full });
  });

  test('is deterministic', () => {
    assert.deepEqual(run(department, { choice: 'billing' }), run(department, { choice: 'billing' }));
  });

  test('answers that do not fit the question name the rule', () => {
    const misfit = (question, answer, id = 'q') => {
      const parsed = parseFixtures([
        { when: { question: 'x' }, fail: 'TIMEOUT' },
        { when: { question: id }, answer },
      ]);
      assert.throws(
        () => ruleAnswer(parsed[1], 1, question, 'state', id, 'my.json'),
        invalidConfig(`my.json rule 1: answer does not fit question ${id}`),
        JSON.stringify(answer),
      );
    };
    misfit(department, { choice: 'sales' });
    misfit(department, { noul: 0.5 });
    misfit(department, { choice: 'billing', confidence: 2 });
    misfit(department, { choice: 'billing', probabilities: { billing: 0.5 } });
    misfit(rating, { score: 3 });
    misfit(rating, { score: -1 });
    misfit(rating, { choice: 'billing' });
    misfit(urgent, { noul: 1.5 });
    misfit(urgent, { score: 1 });
    misfit(department, { type: 'noul', noul: 0.5, choice: 'billing' }, 'department');
  });

  test('the default source is fixtures', () => {
    const parsed = parseFixtures([{ when: { question: 'q' }, answer: { choice: 'sales' } }]);
    assert.throws(() => ruleAnswer(parsed[0], 0, department, 'state', 'q'), {
      code: 'INVALID_CONFIG',
      message: 'fixtures rule 0: answer does not fit question q',
    });
  });
});

describe('ruleError', () => {
  test('HTTP_ERROR carries status and provider code', () => {
    const [http] = parseFixtures([{ fail: 'HTTP_ERROR', status: 503, providerCode: 'BUSY' }]);
    const error = ruleError(http);
    assert.ok(error instanceof SystemOneError);
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.providerCode, 'BUSY');
    assert.equal(error.message, 'Simulated HTTP_ERROR from the mock provider');
  });

  test('other codes carry the provider code where given', () => {
    const [timeout, provider] = parseFixtures([{ fail: 'TIMEOUT' }, { fail: 'PROVIDER_ERROR', providerCode: 'E42' }]);
    const first = ruleError(timeout);
    assert.equal(first.code, 'TIMEOUT');
    assert.equal(first.status, undefined);
    assert.equal(first.providerCode, undefined);
    assert.equal(first.message, 'Simulated TIMEOUT from the mock provider');
    const second = ruleError(provider);
    assert.equal(second.code, 'PROVIDER_ERROR');
    assert.equal(second.providerCode, 'E42');
    assert.equal(second.message, 'Simulated PROVIDER_ERROR from the mock provider');
  });

  test('every allowed code can be built', () => {
    for (const code of ['INVALID_RESPONSE', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'TIMEOUT']) {
      assert.equal(ruleError(parseFixtures([{ fail: code }])[0]).code, code);
    }
  });
});

describe('rules without the optional parts', () => {
  test('ruleAnswer treats a rule without an answer as an answer that does not fit', () => {
    assert.throws(() => ruleAnswer({}, 0, urgent, 'state', 'q', 'my.json'), {
      name: 'SystemOneError',
      code: 'INVALID_CONFIG',
      message: 'my.json rule 0: answer does not fit question q',
    });
  });

  test('ruleError without a fail code is a PROVIDER_ERROR', () => {
    const error = ruleError({});
    assert.equal(error.code, 'PROVIDER_ERROR');
    assert.equal(error.message, 'Simulated PROVIDER_ERROR from the mock provider');
  });
});
