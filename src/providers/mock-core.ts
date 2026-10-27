import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Answer, DecisionRequest, DecisionResult, MockSettings } from '../types';
import { DecisionsError } from '../validation';
import { mockResult } from './mock-engine';
import type { MockStrategy } from './mock-engine';
import { FAIL_CODES, findRule, parseFailure, parseFixtures, ruleAnswer, ruleError } from './mock-fixtures';
import type { MockRule } from './mock-fixtures';

export const DEFAULT_FIXTURES = 'test/data/systemone.json';
const FAIL_SOURCE = 'cds.requires.systemone.fail';

export interface MockOptions {
  strategy: MockStrategy;
  latencyMs: number;
  fixtures?: string;
  fail?: MockRule;
}

const invalidConfig = (message: string, cause?: unknown) => new DecisionsError('INVALID_CONFIG', message, { cause });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseFail(fail: unknown, source: string): MockRule {
  if (typeof fail !== 'string' && !record(fail)) {
    throw invalidConfig('fail must be an error code or an object with a code');
  }
  if (record(fail)) {
    const unknown = Object.keys(fail).find((key) => !['code', 'status', 'providerCode'].includes(key));
    if (unknown) throw invalidConfig(`Unknown property "${unknown}" in fail`);
    if (fail.code === undefined) throw invalidConfig(`${source} needs a code`);
  }
  const { code, status, providerCode } = record(fail)
    ? fail
    : { code: fail, status: undefined, providerCode: undefined };
  if (typeof code !== 'string' || !FAIL_CODES.includes(code)) {
    throw invalidConfig(`${source}: code must be one of ${FAIL_CODES.join(', ')}`);
  }
  try {
    return parseFailure({ fail: code, status, providerCode });
  } catch (error) {
    throw invalidConfig(`${source}: ${(error as Error).message}`, error);
  }
}

// Checks the mock settings (`fixtures`, `strategy`, `latencyMs`, `fail`) shared by `MockService` and the HTTP mock server.
export function parseMockOptions(
  settings: Pick<MockSettings, 'fixtures' | 'strategy' | 'latencyMs' | 'fail'>,
  failSource = FAIL_SOURCE,
): MockOptions {
  const { fixtures, strategy = 'keywords', latencyMs = 0, fail } = settings;
  if (strategy !== 'keywords' && strategy !== 'seeded') throw invalidConfig('strategy must be keywords or seeded');
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) {
    throw invalidConfig('latencyMs must be a non-negative integer');
  }
  if (fixtures !== undefined && (typeof fixtures !== 'string' || !fixtures)) {
    throw invalidConfig('fixtures must be a non-empty file path');
  }
  const options: MockOptions = { strategy, latencyMs };
  if (fixtures !== undefined) options.fixtures = fixtures;
  if (fail !== undefined) options.fail = parseFail(fail, failSource);
  return options;
}

// Reads the fixtures file; a missing file is fine only when the path was not configured explicitly.
export async function loadFixtures(root: string, source: string, configured: boolean): Promise<MockRule[]> {
  let text: string;
  try {
    text = await readFile(path.resolve(root, source), 'utf8');
  } catch (error) {
    if (!configured && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw invalidConfig(`Cannot read the fixtures file ${source}`, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidConfig(`${source} is not valid JSON`, error);
  }
  return parseFixtures(parsed, source);
}

// The decision order of the mock: a global failure, then the first matching rule, then the generated answer.
export function mockDecision(
  request: DecisionRequest,
  options: { strategy: MockStrategy; rules: MockRule[]; fail?: MockRule; source: string },
): DecisionResult {
  const { strategy, rules, fail, source } = options;
  if (fail) throw ruleError(fail);
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const match = findRule(rules, request.state, id);
    if (!match) continue;
    if (match.rule.fail) throw ruleError(match.rule);
    answers[id] = ruleAnswer(match.rule, match.index, question, request.state, id, source);
  }
  return mockResult(request, strategy, answers);
}
