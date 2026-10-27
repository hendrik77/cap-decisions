import type { MockSettings, DecisionsSettings } from '../src';
import MockService, { MockService as NamedMockService } from '../src/providers/mock';

export const full: MockSettings = {
  fixtures: 'test/data/rules.json',
  strategy: 'seeded',
  latencyMs: 50,
  fail: 'TIMEOUT',
  allowInProduction: true,
  timeoutMs: 1000,
  credentials: { url: 'http://127.0.0.1:1' },
};
export const detailedFail: MockSettings = { fail: { code: 'HTTP_ERROR', status: 503, providerCode: 'overloaded' } };
export const empty: MockSettings = {};
export const asBase: DecisionsSettings = full;

// @ts-expect-error The strategy is limited to keywords and seeded.
export const wrongStrategy: MockSettings = { strategy: 'random' };
// @ts-expect-error fail takes a System One error code.
export const wrongFail: MockSettings = { fail: 'UNKNOWN' };
// @ts-expect-error latencyMs is a number.
export const wrongLatency: MockSettings = { latencyMs: '50' };

export const sameClass: typeof MockService = NamedMockService;
export const keys: readonly string[] = MockService.settingsKeys;
