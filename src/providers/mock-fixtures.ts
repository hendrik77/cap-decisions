import { SystemOneError, validateResult } from '../validation';
import type { SystemOneErrorCode } from '../validation';
import type { Answer, Content, Question } from '../types';
import { completeAnswer, stateStrings } from './mock-engine';

export interface MockRule {
  when?: { stateIncludes?: string[]; question?: string };
  answer?: Record<string, unknown>;
  fail?: SystemOneErrorCode;
  status?: number;
  providerCode?: string;
}

export const FAIL_CODES: readonly string[] = [
  'INVALID_RESPONSE',
  'HTTP_ERROR',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
];
const RULE_KEYS = ['when', 'answer', 'fail', 'status', 'providerCode'];
const WHEN_KEYS = ['stateIncludes', 'question'];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the failure part of a rule or of the `fail` setting; the caller names the source in the message. */
export function parseFailure(raw: { fail?: unknown; status?: unknown; providerCode?: unknown }): MockRule {
  const rule: MockRule = {};
  if (typeof raw.fail !== 'string' || !FAIL_CODES.includes(raw.fail)) {
    throw new Error(`fail must be one of ${FAIL_CODES.join(', ')}`);
  }
  rule.fail = raw.fail as SystemOneErrorCode;
  if (raw.fail === 'HTTP_ERROR') {
    const { status } = raw;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
      throw new Error('HTTP_ERROR needs a status from 400 to 599');
    }
    rule.status = status;
  } else if (raw.status !== undefined) {
    throw new Error('status only goes with HTTP_ERROR');
  }
  if (raw.providerCode !== undefined) {
    if (typeof raw.providerCode !== 'string') throw new Error('providerCode must be a string');
    rule.providerCode = raw.providerCode;
  }
  return rule;
}

function parseRule(raw: unknown): MockRule {
  if (!record(raw)) throw new Error('must be an object');
  const unknown = Object.keys(raw).find((key) => !RULE_KEYS.includes(key));
  if (unknown) throw new Error(`unknown property "${unknown}"`);

  let when: MockRule['when'];
  if (raw.when !== undefined) {
    if (!record(raw.when)) throw new Error('when must be an object');
    const unknownWhen = Object.keys(raw.when).find((key) => !WHEN_KEYS.includes(key));
    if (unknownWhen) throw new Error(`unknown property "when.${unknownWhen}"`);
    const { stateIncludes, question } = raw.when;
    when = {};
    if (stateIncludes !== undefined) {
      const items = Array.isArray(stateIncludes) ? stateIncludes : [stateIncludes];
      if (!items.length || items.some((item) => typeof item !== 'string')) {
        throw new Error('when.stateIncludes must be a string or a non-empty array of strings');
      }
      when.stateIncludes = items as string[];
    }
    if (question !== undefined) {
      if (typeof question !== 'string' || !question) throw new Error('when.question must be a non-empty string');
      when.question = question;
    }
  }

  const rule: MockRule = {};
  if (when) rule.when = when;
  if ((raw.answer === undefined) === (raw.fail === undefined)) throw new Error('needs exactly one of answer or fail');
  if (raw.answer !== undefined) {
    if (!record(raw.answer)) throw new Error('answer must be an object');
    if (!when?.question) throw new Error('an answer needs when.question, because answers depend on the question type');
    if (raw.status !== undefined || raw.providerCode !== undefined) {
      throw new Error('status and providerCode only go with fail');
    }
    rule.answer = raw.answer;
    return rule;
  }

  return Object.assign(rule, parseFailure(raw));
}

export function parseFixtures(raw: unknown, source = 'fixtures'): MockRule[] {
  if (!Array.isArray(raw)) throw new SystemOneError('INVALID_CONFIG', `${source} must be an array of rules`);
  return raw.map((item: unknown, index) => {
    try {
      return parseRule(item);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SystemOneError('INVALID_CONFIG', `${source} rule ${index}: ${reason}`, { cause: error });
    }
  });
}

export function findRule(
  rules: MockRule[],
  state: Content,
  questionId: string,
): { rule: MockRule; index: number } | undefined {
  const haystack = stateStrings(state).join('\n').toLowerCase();
  const index = rules.findIndex(
    ({ when }) =>
      (when?.question === undefined || when.question === questionId) &&
      (when?.stateIncludes === undefined || when.stateIncludes.some((text) => haystack.includes(text.toLowerCase()))),
  );
  return index < 0 ? undefined : { rule: rules[index], index };
}

export function ruleAnswer(
  rule: MockRule,
  index: number,
  question: Question,
  state: Content,
  questionId: string,
  source = 'fixtures',
): Answer {
  const misfit = (cause?: unknown) =>
    new SystemOneError('INVALID_CONFIG', `${source} rule ${index}: answer does not fit question ${questionId}`, {
      cause,
    });
  try {
    const answer = completeAnswer(question, rule.answer ?? {}, state, questionId);
    const result = { model: 'mock', answers: { [questionId]: answer }, usage: { input_tokens: 0, output_tokens: 1 } };
    validateResult(result, { [questionId]: question });
    return answer;
  } catch (error) {
    throw misfit(error);
  }
}

export function ruleError(rule: MockRule): SystemOneError {
  const code = rule.fail ?? 'PROVIDER_ERROR';
  return new SystemOneError(code, `Simulated ${code} from the mock provider`, {
    status: rule.status,
    providerCode: rule.providerCode,
  });
}
