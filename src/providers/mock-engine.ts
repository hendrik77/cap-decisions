import { createHash } from 'node:crypto';
import { DecisionsError } from '../validation';
import type {
  Answer,
  ChoiceQuestion,
  Content,
  DecisionRequest,
  DecisionResult,
  Question,
  ScoreQuestion,
} from '../types';

export type MockStrategy = 'keywords' | 'seeded';

const STOP_WORDS = new Set([
  ...['the', 'and', 'was', 'for', 'you', 'with', 'this', 'that', 'are', 'not', 'but'],
  ...['have', 'has', 'had', 'from', 'our', 'your', 'its', 'can', 'will', 'please'],
]);
const MIN_SHARED_PREFIX = 4;

// mulberry32, seeded with the first four bytes of the SHA-256 of the text.
export function createRandom(seedText: string): () => number {
  let seed = createHash('sha256').update(seedText).digest().readUInt32BE(0);
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedFor = (state: Content, questionId: string): string => `${JSON.stringify(state)}\u0000${questionId}`;

// All string values of a JSON value, nested ones included.
export function stateStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stateStrings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stateStrings);
  return [];
}

const tokens = (texts: string[]): string[] =>
  texts
    .flatMap((text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

// Two words match when equal or when they share a prefix, so "refund" finds "refunds".
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= MIN_SHARED_PREFIX;
}

// How many words of the state match the label or its criteria; the best-scoring label is favoured.
function keywordScore(stateTokens: Set<string>, label: string, criteria: unknown): number {
  const labelTokens = tokens([label, ...stateStrings(criteria)]);
  let score = 0;
  for (const token of stateTokens) if (labelTokens.some((candidate) => similar(token, candidate))) score++;
  return score;
}

const normalise = (weights: number[]): number[] => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
};
const randomWeights = (random: () => number, count: number): number[] =>
  Array.from({ length: count }, () => 0.1 + 0.9 * random());
const largest = (values: number[]): number => values.reduce((max, value) => Math.max(max, value), 0);

// Lifts one weight above all the others, so that its normalised probability is the largest.
function favour(weights: number[], index: number, bonus = 0): number[] {
  if (index < 0 || index >= weights.length) return weights;
  const others = largest(weights.filter((_, other) => other !== index));
  return weights.map((weight, position) => (position === index ? others + 1 + bonus : weight));
}

const byLabel = (labels: string[], probabilities: number[]): Record<string, number> =>
  Object.fromEntries(labels.map((label, index) => [label, probabilities[index]]));

const text = (criterion: Content): string => (typeof criterion === 'string' ? criterion : JSON.stringify(criterion));

// Probabilities for a choice: random weights with the chosen label lifted to the top.
function choiceFields(
  question: ChoiceQuestion,
  choice: string,
  score: number,
  random: () => number,
): Record<string, unknown> {
  const labels = Object.keys(question.criteria);
  const probabilities = normalise(favour(randomWeights(random, labels.length), labels.indexOf(choice), score));
  const named = byLabel(labels, probabilities);
  return { choice, probabilities: named, confidence: named[choice] ?? largest(probabilities) };
}

// Probabilities, expected value and legend for a score question.
function scoreFields(question: ScoreQuestion, favoured: number | undefined, random: () => number) {
  const count = question.criteria.length;
  const weights = randomWeights(random, count);
  const probabilities = normalise(favoured === undefined ? weights : favour(weights, favoured));
  const labels = probabilities.map((_, index) => String(index));
  return {
    expected: Math.min(
      count - 1,
      probabilities.reduce((sum, probability, index) => sum + index * probability, 0),
    ),
    fields: {
      probabilities: byLabel(labels, probabilities),
      legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), text(criterion)])),
      confidence: largest(probabilities),
    },
  };
}

// A deterministic answer: the same state and question id always give the same result (seeded random).
export function mockAnswer(
  question: Question,
  state: Content,
  questionId: string,
  strategy: MockStrategy = 'keywords',
): Answer {
  const random = createRandom(seedFor(state, questionId));
  if (question.type === 'noul') return { type: 'noul', noul: random() };
  if (question.type === 'score') {
    const { expected, fields } = scoreFields(question, undefined, random);
    return { type: 'score', score: expected, ...fields };
  }
  const labels = Object.keys(question.criteria);
  const stateTokens = new Set(tokens(stateStrings(state)));
  const scores = labels.map((label) =>
    strategy === 'keywords' ? keywordScore(stateTokens, label, question.criteria[label]) : 0,
  );
  const best = Math.max(...scores);
  const candidates = labels.filter((_, index) => scores[index] === best);
  const choice = candidates[Math.floor(random() * candidates.length)];
  return { type: 'choice', ...choiceFields(question, choice, best, random) } as Answer;
}

// Fills the fields a fixture leaves out; the caller validates the result.
export function completeAnswer(
  question: Question,
  partial: Record<string, unknown>,
  state: Content,
  questionId: string,
): Answer {
  const random = createRandom(seedFor(state, questionId));
  const missing = (field: string) => new DecisionsError('INVALID_CONFIG', `A ${question.type} answer needs ${field}`);
  let generated: Record<string, unknown>;
  if (question.type === 'noul') {
    if (typeof partial.noul !== 'number') throw missing('noul');
    generated = {};
  } else if (question.type === 'score') {
    if (typeof partial.score !== 'number') throw missing('score');
    const favoured = Math.min(question.criteria.length - 1, Math.max(0, Math.round(partial.score)));
    generated = scoreFields(question, favoured, random).fields;
  } else {
    if (typeof partial.choice !== 'string') throw missing('choice');
    generated = choiceFields(question, partial.choice, 0, random);
  }
  const answer: Record<string, unknown> = { type: question.type, ...generated, ...partial };
  const given = partial.probabilities;
  if (partial.confidence === undefined && typeof given === 'object' && given !== null) {
    answer.confidence = largest(Object.values(given).filter((value): value is number => typeof value === 'number'));
  }
  return answer as unknown as Answer;
}

// The complete result for a request; `answers` holds the ones fixed by fixtures, the rest are generated.
export function mockResult(
  request: DecisionRequest,
  strategy: MockStrategy = 'keywords',
  answers: Record<string, Answer> = {},
): DecisionResult {
  const ids = Object.keys(request.questions);
  return {
    model: 'mock',
    answers: Object.fromEntries(
      ids.map((id) => [id, answers[id] ?? mockAnswer(request.questions[id], request.state, id, strategy)]),
    ),
    usage: { input_tokens: Math.ceil(JSON.stringify(request).length / 4), output_tokens: ids.length },
  } as DecisionResult;
}
