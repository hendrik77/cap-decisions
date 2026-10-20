import cds from '@sap/cds';
import { SystemOneTransport } from './transport';
import type { DecisionRequest, DecisionResult, Questions, SystemOneCredentials, SystemOneSettings } from './types';
import { validateRequest, validateResult, validateSettings } from './validation';

const signalKey = Symbol('systemone.callerSignal');
type SignalRequest<Q extends Questions = Questions> = cds.Request<DecisionRequest<Q>> & { [signalKey]?: AbortSignal };

export interface DecideOptions {
  signal?: AbortSignal;
}

export class SystemOneService extends cds.Service {
  // Setting keys a subclass accepts in addition to the built-in ones, so they do not produce a warning.
  static settingsKeys: readonly string[] = [];
  // Credential keys a subclass accepts in addition to url, token, accountId and destination (string values).
  static credentialKeys: readonly string[] = [];

  protected settings!: SystemOneSettings;
  protected transport?: SystemOneTransport;

  async init(): Promise<void> {
    this.settings = (this as cds.Service & { options?: SystemOneSettings }).options ?? {};
    const { settingsKeys, credentialKeys } = this.constructor as typeof SystemOneService;
    const warnings = validateSettings(this.settings, settingsKeys, credentialKeys);
    for (const warning of warnings) cds.log('systemone').warn(warning);
    await this.setup(this.settings);
    this.on('decide', async (request: SignalRequest) => {
      const started = performance.now();
      validateRequest(request.data, this.settings.limits);
      const { result, attempts } = await this.call(request.data, { signal: request[signalKey] });
      validateResult(result, request.data.questions);
      cds.log('systemone').debug('decision completed', {
        latencyMs: Math.round(performance.now() - started),
        attempts,
        model: result.model,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        },
      });
      return result;
    });
    await super.init();
  }

  protected async setup(settings: SystemOneSettings): Promise<void> {
    this.transport = new SystemOneTransport(settings, {
      hooks: {
        endpoint: (credentials) => this.endpoint(credentials),
        unwrap: (payload) => this.unwrap(payload),
        errorCode: (payload) => this.errorCode(payload),
      },
    });
    await this.transport.validateDestination();
  }

  protected async call(
    request: DecisionRequest,
    options: DecideOptions,
  ): Promise<{ result: unknown; attempts: number }> {
    const { payload, attempts } = await (this.transport as SystemOneTransport).post(request, options);
    return { result: payload, attempts };
  }

  protected endpoint(credentials: SystemOneCredentials): string | undefined {
    return credentials.url;
  }

  protected unwrap(payload: unknown): unknown {
    return payload;
  }

  protected errorCode(payload: unknown): string | number | undefined {
    void payload;
    return undefined;
  }

  decide<Q extends Questions>(request: DecisionRequest<Q>, options: DecideOptions = {}): Promise<DecisionResult<Q>> {
    const event = new cds.Request({ event: 'decide', data: request }) as SignalRequest<Q>;
    if (options.signal) event[signalKey] = options.signal;
    return this.send<DecisionResult<Q>>(event as unknown as { event: string; data: DecisionRequest<Q> });
  }
}

export { SystemOneError } from './validation';
export type { SystemOneErrorCode } from './validation';
export type {
  JsonValue,
  Content,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  Question,
  Questions,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  Answer,
  Answers,
  DecisionRequest,
  DecisionResult,
  ProviderLimits,
  SystemOneCredentials,
  SystemOneSettings,
} from './types';

export default SystemOneService;
