const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRandom, seedFor, mockAnswer, completeAnswer, mockResult } = require('../dist/providers/mock-engine');
const { validateResult } = require('../dist/validation');

const department = {
  type: 'choice',
  instructions: 'Which department?',
  criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
};
const rating = { type: 'score', instructions: 'Rate', criteria: ['Poor', 'Fair', 'Good'] };
const urgent = { type: 'noul', instructions: 'Is it urgent?' };

const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0);
const check = (question, answer, id = 'q') =>
  validateResult(
    { model: 'mock', answers: { [id]: answer }, usage: { input_tokens: 1, output_tokens: 1 } },
    { [id]: question },
  );

describe('createRandom', () => {
  test('is reproducible and stays in [0, 1)', () => {
    const first = createRandom('seed');
    const second = createRandom('seed');
    const values = Array.from({ length: 200 }, () => first());
    assert.deepEqual(
      values,
      Array.from({ length: 200 }, () => second()),
    );
    assert.ok(values.every((value) => value >= 0 && value < 1));
    assert.ok(new Set(values).size > 190);
  });

  test('different seeds give different sequences', () => {
    assert.notEqual(createRandom('a')(), createRandom('b')());
  });

  test('seedFor combines state and question id', () => {
    assert.equal(seedFor({ a: 1 }, 'q'), '{"a":1}\u0000q');
    assert.equal(seedFor('text', 'q'), '"text"\u0000q');
  });
});

describe('determinism', () => {
  test('same state and question id give identical answers', () => {
    for (const question of [department, rating, urgent]) {
      for (const strategy of ['keywords', 'seeded']) {
        assert.deepEqual(mockAnswer(question, 'hello', 'q', strategy), mockAnswer(question, 'hello', 'q', strategy));
      }
    }
  });

  test('a different state or question id changes seeded values', () => {
    const base = mockAnswer(rating, 'hello', 'q', 'seeded');
    assert.notDeepEqual(base.probabilities, mockAnswer(rating, 'hello!', 'q', 'seeded').probabilities);
    assert.notDeepEqual(base.probabilities, mockAnswer(rating, 'hello', 'other', 'seeded').probabilities);
    const noul = mockAnswer(urgent, 'hello', 'q').noul;
    assert.notEqual(noul, mockAnswer(urgent, 'hello!', 'q').noul);
    assert.notEqual(noul, mockAnswer(urgent, 'hello', 'other').noul);
  });
});

describe('answers validate', () => {
  const choices = {
    plain: department,
    numeric: { type: 'choice', instructions: 'Pick', criteria: { 0: 'a', 1: 'b' } },
    nullValues: { type: 'choice', instructions: 'Pick', criteria: { yes: null, no: null } },
    jsonContent: {
      type: 'choice',
      instructions: 'Pick',
      criteria: { first: { description: 'refund requests', examples: ['money back'] }, second: ['other', 'stuff'] },
    },
    single: { type: 'choice', instructions: 'Pick', criteria: { only: 'one' } },
    // An optional key that is absent at runtime is simply not in the criteria.
    optionalAbsent: { type: 'choice', instructions: 'Pick', criteria: { required: 'x' } },
  };
  const scores = {
    one: { type: 'score', instructions: 'Rate', criteria: ['only'] },
    three: rating,
    ten: { type: 'score', instructions: 'Rate', criteria: Array.from({ length: 10 }, (_, index) => `Level ${index}`) },
    json: { type: 'score', instructions: 'Rate', criteria: [{ level: 'low' }, { level: 'high' }] },
  };
  const states = ['', 'I was billed twice', { message: 'The API returns errors', tags: ['a', 'b'] }, ['x', { y: 'z' }]];

  test('every question type validates', () => {
    for (const [name, question] of [...Object.entries(choices), ...Object.entries(scores), ['noul', urgent]]) {
      for (const state of states) {
        for (const strategy of ['keywords', 'seeded']) {
          const answer = mockAnswer(question, state, name, strategy);
          check(question, answer, name);
          if (question.type !== 'noul') assert.ok(Math.abs(sum(answer.probabilities) - 1) < 1e-9, name);
        }
      }
    }
  });

  test('choice probabilities: confidence is the largest and belongs to the choice', () => {
    for (const state of states) {
      const answer = mockAnswer(department, state, 'q');
      assert.equal(answer.type, 'choice');
      assert.equal(answer.confidence, answer.probabilities[answer.choice]);
      assert.equal(answer.confidence, Math.max(...Object.values(answer.probabilities)));
      assert.deepEqual(Object.keys(answer.probabilities).sort(), ['billing', 'technical']);
    }
  });

  test('score fields', () => {
    for (const question of Object.values(scores)) {
      const answer = mockAnswer(question, 'text', 'q');
      const count = question.criteria.length;
      assert.deepEqual(
        Object.keys(answer.probabilities),
        Array.from({ length: count }, (_, index) => String(index)),
      );
      const expected = Object.entries(answer.probabilities).reduce((total, [index, p]) => total + Number(index) * p, 0);
      assert.ok(Math.abs(answer.score - expected) < 1e-9);
      assert.ok(answer.score >= 0 && answer.score <= count - 1);
      assert.equal(answer.confidence, Math.max(...Object.values(answer.probabilities)));
    }
    const legend = mockAnswer(scores.json, 'text', 'q').legend;
    assert.deepEqual(legend, { 0: '{"level":"low"}', 1: '{"level":"high"}' });
    assert.deepEqual(mockAnswer(rating, 'text', 'q').legend, { 0: 'Poor', 1: 'Fair', 2: 'Good' });
  });

  test('noul is within [0, 1]', () => {
    for (let index = 0; index < 50; index++) {
      const answer = mockAnswer(urgent, `state ${index}`, 'q');
      assert.equal(answer.type, 'noul');
      assert.ok(answer.noul >= 0 && answer.noul <= 1);
    }
  });
});

describe('keywords strategy', () => {
  test('matches the state to label and criteria text', () => {
    assert.equal(mockAnswer(department, 'I was billed twice. Please refund me.', 'q').choice, 'billing');
    assert.equal(mockAnswer(department, { message: 'The API returns errors' }, 'q').choice, 'technical');
    assert.equal(mockAnswer(department, ['Two refunds', { note: 'Nothing else' }], 'q').choice, 'billing');
  });

  test('matches labels themselves and prefixes', () => {
    const labels = { type: 'choice', instructions: 'Pick', criteria: { shipping: null, invoice: null } };
    assert.equal(mockAnswer(labels, 'Where is my shipment', 'q').choice, 'shipping');
    assert.equal(mockAnswer(labels, 'The invoices are wrong', 'q').choice, 'invoice');
  });

  test('matches JSON criteria content', () => {
    const question = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { a: { description: 'password reset' }, b: ['shipping', 'delivery delays'] },
    };
    assert.equal(mockAnswer(question, 'Forgot my password', 'q').choice, 'a');
    assert.equal(mockAnswer(question, 'delivery is late', 'q').choice, 'b');
  });

  test('stop words and short tokens do not count', () => {
    const question = {
      type: 'choice',
      instructions: 'Pick',
      criteria: { other: 'the and for you with', mine: 'a b zz' },
    };
    const first = mockAnswer(question, 'the and for you with a b zz', 'q');
    // No scoring tokens on either side: the choice comes from the seed only, so it matches the seeded strategy.
    assert.equal(first.choice, mockAnswer(question, 'the and for you with a b zz', 'q', 'seeded').choice);
  });

  test('the matching label gets the highest probability', () => {
    const answer = mockAnswer(department, 'I was billed twice. Please refund me.', 'q');
    assert.equal(answer.probabilities.billing > answer.probabilities.technical, true);
    assert.equal(answer.confidence, answer.probabilities.billing);
  });

  test('no overlap gives a stable choice among the labels', () => {
    const first = mockAnswer(department, 'xyz', 'q');
    assert.deepEqual(first, mockAnswer(department, 'xyz', 'q'));
    assert.ok(['billing', 'technical'].includes(first.choice));
  });

  test('ties stay stable', () => {
    const tie = { type: 'choice', instructions: 'Pick', criteria: { alpha: 'weather', beta: 'weather' } };
    const first = mockAnswer(tie, 'what is the weather', 'q');
    assert.deepEqual(first, mockAnswer(tie, 'what is the weather', 'q'));
    assert.ok(['alpha', 'beta'].includes(first.choice));
  });
});

describe('seeded strategy', () => {
  const labels = { type: 'choice', instructions: 'Pick', criteria: { one: 'refund', two: 'refund', three: 'refund' } };

  test('ignores keywords but is reproducible', () => {
    const states = Array.from({ length: 12 }, (_, index) => `please refund order ${index}`);
    const choices = states.map((state) => mockAnswer(labels, state, 'q', 'seeded').choice);
    assert.ok(new Set(choices).size > 1);
    assert.deepEqual(
      choices,
      states.map((state) => mockAnswer(labels, state, 'q', 'seeded').choice),
    );
    const sameDepartment = states.map((state) => mockAnswer(department, state, 'q', 'seeded').choice);
    assert.ok(new Set(sameDepartment).size > 1);
  });
});

describe('completeAnswer', () => {
  test('keeps given fields and fills the rest for choice', () => {
    const answer = completeAnswer(department, { choice: 'billing' }, 'text', 'q');
    assert.equal(answer.choice, 'billing');
    assert.equal(answer.confidence, answer.probabilities.billing);
    assert.equal(answer.confidence, Math.max(...Object.values(answer.probabilities)));
    check(department, { type: 'choice', ...answer });
    assert.deepEqual(answer, completeAnswer(department, { choice: 'billing' }, 'text', 'q'));

    const given = { choice: 'technical', probabilities: { billing: 0.25, technical: 0.75 }, confidence: 0.75 };
    assert.deepEqual(completeAnswer(department, given, 'text', 'q'), { type: 'choice', ...given });
    const partial = completeAnswer(department, { choice: 'technical', confidence: 0.5 }, 'text', 'q');
    assert.equal(partial.confidence, 0.5);
    assert.equal(partial.choice, 'technical');
    assert.ok(Math.abs(sum(partial.probabilities) - 1) < 1e-9);
  });

  test('keeps given fields and fills the rest for score', () => {
    const answer = completeAnswer(rating, { score: 2 }, 'text', 'q');
    assert.equal(answer.score, 2);
    assert.deepEqual(answer.legend, { 0: 'Poor', 1: 'Fair', 2: 'Good' });
    assert.ok(Math.abs(sum(answer.probabilities) - 1) < 1e-9);
    check(rating, { type: 'score', ...answer });

    const legend = { 0: 'a', 1: 'b', 2: 'c' };
    const kept = completeAnswer(rating, { score: 1, legend }, 'text', 'q');
    assert.deepEqual(kept.legend, legend);
  });

  test('keeps given fields for noul', () => {
    assert.equal(completeAnswer(urgent, { noul: 0.9 }, 'text', 'q').noul, 0.9);
    check(urgent, { type: 'noul', ...completeAnswer(urgent, { noul: 0.9 }, 'text', 'q') });
  });

  test('requires the main field', () => {
    assert.throws(() => completeAnswer(department, {}, 'text', 'q'));
    assert.throws(() => completeAnswer(rating, { choice: 'x' }, 'text', 'q'));
    assert.throws(() => completeAnswer(urgent, {}, 'text', 'q'));
  });
});

describe('mockResult', () => {
  const request = { state: 'I was billed twice', questions: { department, rating, urgent } };

  test('answers every question and validates', () => {
    const result = mockResult(request);
    validateResult(result, request.questions);
    assert.equal(result.model, 'mock');
    assert.deepEqual(Object.keys(result.answers), ['department', 'rating', 'urgent']);
    assert.equal(result.answers.department.choice, 'billing');
  });

  test('usage estimate', () => {
    const result = mockResult(request);
    assert.deepEqual(result.usage, {
      input_tokens: Math.ceil(JSON.stringify(request).length / 4),
      output_tokens: 3,
    });
  });

  test('strategy is passed on', () => {
    const states = Array.from({ length: 12 }, (_, index) => ({ state: `refund ${index}`, questions: { department } }));
    const keywords = states.map((item) => mockResult(item).answers.department.choice);
    assert.deepEqual(new Set(keywords), new Set(['billing']));
    const seeded = states.map((item) => mockResult(item, 'seeded').answers.department.choice);
    assert.ok(new Set(seeded).size > 1);
  });

  test('given answers override generated ones', () => {
    const given = completeAnswer(department, { choice: 'technical' }, request.state, 'department');
    const result = mockResult(request, 'keywords', { department: { type: 'choice', ...given } });
    assert.equal(result.answers.department.choice, 'technical');
    assert.equal(result.answers.rating.type, 'score');
    validateResult(result, request.questions);
  });
});
