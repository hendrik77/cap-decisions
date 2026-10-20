import { readFile } from 'node:fs/promises';
import path from 'node:path';
import cds from '@sap/cds';
import { SystemOneService } from '../index';
import type { DecideOptions } from '../index';
import type { Answer, DecisionRequest, MockSettings } from '../types';
import { SystemOneError } from '../validation';
import { mockResult } from './mock-engine';
import type { MockStrategy } from './mock-engine';
import { findRule, parseFixtures, ruleAnswer, ruleError } from './mock-fixtures';
import type { MockRule } from './mock-fixtures';

const DEFAULT_FIXTURES = 'test/data/systemone.json';
const FAIL_SOURCE = 'cds.requires.systemone.fail';
const WARNING =
  'Using the mock provider: answers are simulated. Set a kind such as systemone-laya to use a real endpoint in development.';

const invalidConfig = (message: string, cause?: unknown) => new SystemOneError('INVALID_CONFIG', message, { cause });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseFail(fail: unknown): MockRule {
  if (typeof fail === 'string') return parseFixtures([{ fail }], FAIL_SOURCE)[0];
  if (!record(fail)) throw invalidConfig('fail must be an error code or an object with a code');
  const unknown = Object.keys(fail).find((key) => !['code', 'status', 'providerCode'].includes(key));
  if (unknown) throw invalidConfig(`Unknown property "${unknown}" in fail`);
  return parseFixtures([{ fail: fail.code, status: fail.status, providerCode: fail.providerCode }], FAIL_SOURCE)[0];
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new SystemOneError('ABORTED', 'System One request was cancelled', { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Answers in-process from fixtures and a deterministic engine; it never touches the network.
export default class MockService extends SystemOneService {
  static override settingsKeys = ['fixtures', 'strategy', 'latencyMs', 'fail', 'allowInProduction'];

  private strategy: MockStrategy = 'keywords';
  private latencyMs = 0;
  private fail?: MockRule;
  private rules: MockRule[] = [];
  private fixtureSource = DEFAULT_FIXTURES;

  protected override async setup(settings: MockSettings): Promise<void> {
    const { fixtures, strategy = 'keywords', latencyMs = 0, fail, allowInProduction = false } = settings;
    if (typeof allowInProduction !== 'boolean') throw invalidConfig('allowInProduction must be a boolean');
    if (cds.env.profiles?.includes('production') && !allowInProduction) {
      throw invalidConfig('The mock provider is disabled in production; set allowInProduction: true to use it');
    }
    if (strategy !== 'keywords' && strategy !== 'seeded') throw invalidConfig('strategy must be keywords or seeded');
    if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) {
      throw invalidConfig('latencyMs must be a non-negative integer');
    }
    if (fixtures !== undefined && (typeof fixtures !== 'string' || !fixtures)) {
      throw invalidConfig('fixtures must be a non-empty file path');
    }
    this.strategy = strategy;
    this.latencyMs = latencyMs;
    if (fail !== undefined) this.fail = parseFail(fail);
    this.fixtureSource = fixtures ?? DEFAULT_FIXTURES;
    this.rules = await this.loadFixtures(fixtures !== undefined);
    cds.log('systemone').warn(WARNING);
  }

  private async loadFixtures(configured: boolean): Promise<MockRule[]> {
    let text: string;
    try {
      text = await readFile(path.resolve(cds.root, this.fixtureSource), 'utf8');
    } catch (error) {
      if (!configured && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw invalidConfig(`Cannot read the fixtures file ${this.fixtureSource}`, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw invalidConfig(`${this.fixtureSource} is not valid JSON`, error);
    }
    return parseFixtures(parsed, this.fixtureSource);
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new SystemOneError('ABORTED', 'System One request was cancelled', { cause: signal.reason });
    }
    if (this.latencyMs <= 0) return;
    const { timeoutMs } = this.settings;
    const timesOut = timeoutMs !== undefined && this.latencyMs >= timeoutMs;
    await wait(timesOut ? timeoutMs : this.latencyMs, signal);
    if (timesOut) throw new SystemOneError('TIMEOUT', 'System One request timed out');
  }

  protected override async call(
    request: DecisionRequest,
    options: DecideOptions,
  ): Promise<{ result: unknown; attempts: number }> {
    await this.delay(options.signal);
    if (this.fail) throw ruleError(this.fail);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const match = findRule(this.rules, request.state, id);
      if (!match) continue;
      if (match.rule.fail) throw ruleError(match.rule);
      answers[id] = ruleAnswer(match.rule, match.index, question, request.state, id, this.fixtureSource);
    }
    return { result: mockResult(request, this.strategy, answers), attempts: 1 };
  }
}

export { MockService };
