import cds from '@sap/cds';
import { SystemOneService } from '../index';
import type { DecideOptions } from '../index';
import type { DecisionRequest, MockSettings } from '../types';
import { SystemOneError } from '../validation';
import type { MockStrategy } from './mock-engine';
import { DEFAULT_FIXTURES, loadFixtures, mockDecision, parseMockOptions } from './mock-core';
import type { MockRule } from './mock-fixtures';

const WARNING =
  'Using the mock provider: answers are simulated. Set a kind such as systemone-laya to use a real endpoint in development.';

const invalidConfig = (message: string) => new SystemOneError('INVALID_CONFIG', message);

// The simulated latency; ends early with the caller's abort signal.
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

/**
 * The provider class of `systemone-mock`. It answers in-process from fixtures and a deterministic engine, never
 * touches the network, and refuses the `production` profile unless `allowInProduction` is true.
 */
export default class MockService extends SystemOneService {
  /** The mock's own settings (see `MockSettings`), accepted without a warning. */
  static override settingsKeys = ['fixtures', 'strategy', 'latencyMs', 'fail', 'allowInProduction'];

  private strategy: MockStrategy = 'keywords';
  private latencyMs = 0;
  private fail?: MockRule;
  private rules: MockRule[] = [];
  private fixtureSource = DEFAULT_FIXTURES;

  protected override async setup(settings: MockSettings): Promise<void> {
    const { allowInProduction = false } = settings;
    if (typeof allowInProduction !== 'boolean') throw invalidConfig('allowInProduction must be a boolean');
    if (cds.env.profiles?.includes('production') && !allowInProduction) {
      throw invalidConfig('The mock provider is disabled in production; set allowInProduction: true to use it');
    }
    const { strategy, latencyMs, fixtures, fail } = parseMockOptions(settings);
    this.strategy = strategy;
    this.latencyMs = latencyMs;
    this.fail = fail;
    this.fixtureSource = fixtures ?? DEFAULT_FIXTURES;
    this.rules = await loadFixtures(cds.root, this.fixtureSource, fixtures !== undefined);
    cds.log('systemone').warn(WARNING);
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
    const { strategy, rules, fail, fixtureSource: source } = this;
    return { result: mockDecision(request, { strategy, rules, fail, source }), attempts: 1 };
  }
}

export { MockService };
