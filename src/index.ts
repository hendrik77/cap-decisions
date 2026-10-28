// The main entry of the package, `cap-decisions`: the service, `DecisionsError` and the types, nothing else. The HTTP mock
// server, its command line (`bin` `cap-decisions-mock`), the providers and the test kit are separate entry points in
// `exports` of package.json (see the README and docs/decisions/0006).
import cds from '@sap/cds';
import { DestinationResolveError, DecisionsTransport } from './transport';
import type { DecisionRequest, DecisionResult, Questions, DecisionsCredentials, DecisionsSettings } from './types';
import { DecisionsError, validateRequest, validateResult, validateSettings } from './validation';

const signalKey = Symbol('decisions.callerSignal');
type SignalRequest<Q extends Questions = Questions> = cds.Request<DecisionRequest<Q>> & { [signalKey]?: AbortSignal };

/** Options of {@link DecisionsService.decide}. */
export interface DecideOptions {
  /** Cancels the call; it then fails with `ABORTED`. */
  signal?: AbortSignal;
}

/**
 * The CAP service behind `cds.connect.to('decisions')`. It validates the settings, sends a decision request to the
 * configured Jev endpoint with retries and a deadline, and checks the answers. A provider whose protocol differs
 * extends it and overrides the hooks `endpoint`, `unwrap` and `errorCode`.
 */
export class DecisionsService extends cds.Service {
  /**
   * Setting keys a subclass accepts in addition to the built-in ones, so they do not produce a warning.
   */
  static settingsKeys: readonly string[] = [];
  /**
   * Credential keys a subclass accepts in addition to `url`, `token`, `accountId` and `destination` (string values).
   */
  static credentialKeys: readonly string[] = [];

  /**
   * The validated settings of this service, a snapshot taken in `init()`.
   * @internal Not part of the public API; it may change in any release.
   */
  protected settings!: DecisionsSettings;
  /**
   * The HTTP transport created by `setup()`.
   * @internal Not part of the public API; its type is internal and may change in any release.
   */
  protected transport?: DecisionsTransport;

  async init(): Promise<void> {
    this.settings = (this as cds.Service & { options?: DecisionsSettings }).options ?? {};
    const { settingsKeys, credentialKeys } = this.constructor as typeof DecisionsService;
    const warnings = validateSettings(this.settings, settingsKeys, credentialKeys);
    for (const warning of warnings) cds.log('decisions').warn(warning);
    await this.setup(this.settings);
    // CAP's `on` handler that does the work: validates the request, calls the provider and checks the result.
    this.on('decide', async (request: SignalRequest) => {
      const started = performance.now();
      validateRequest(request.data, this.settings.limits);
      const { result, attempts } = await this.call(request.data, { signal: request[signalKey] });
      validateResult(result, request.data.questions);
      cds.log('decisions').debug('decision completed', {
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

  /**
   * Prepares the service after the settings are validated; the default creates the transport and checks the
   * destination. Call `super.setup()` when overriding it.
   * @experimental May change in a minor release.
   */
  protected async setup(settings: DecisionsSettings): Promise<void> {
    this.transport = new DecisionsTransport(settings, {
      hooks: {
        endpoint: (credentials) => this.endpoint(credentials),
        unwrap: (payload) => this.unwrap(payload),
        errorCode: (payload) => this.errorCode(payload),
      },
    });
    try {
      await this.transport.validateDestination();
    } catch (error) {
      if (!(error instanceof DestinationResolveError)) throw error;
      cds
        .log('decisions')
        .warn(
          `Could not resolve destination ${settings.credentials?.destination} at start-up; it is resolved again for each call`,
        );
    }
  }

  /**
   * Sends one validated request and returns the provider's raw payload with the number of attempts. The default posts
   * through the transport; a subclass can answer differently, as `MockService` does.
   * @experimental May change in a minor release.
   */
  protected async call(
    request: DecisionRequest,
    options: DecideOptions,
  ): Promise<{ result: unknown; attempts: number }> {
    if (!this.transport) {
      throw new DecisionsError(
        'INVALID_CONFIG',
        'setup() did not create the transport; call super.setup() or override call()',
      );
    }
    const { payload, attempts } = await this.transport.post(request, options);
    return { result: payload, attempts };
  }

  /**
   * Returns the full POST URL for the credentials, or `undefined` when there is none (the connection then fails with
   * `INVALID_CONFIG`, unless a destination supplies it). The default returns `credentials.url`.
   */
  protected endpoint(credentials: DecisionsCredentials): string | undefined {
    return credentials.url;
  }

  /**
   * Turns the provider's response body into the Jev answer. The default is for a Jev-compatible provider and returns
   * the body unchanged; a subclass overrides it. Throw a `DecisionsError` for a failure the body reports.
   */
  protected unwrap(payload: unknown): unknown {
    return payload;
  }

  /**
   * Reads a machine-readable error code from an error response body; it becomes `providerCode`. The default is for a
   * Jev-compatible provider, which reports none, so it returns `undefined`; a subclass overrides it. The message of
   * the body is never exposed.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected errorCode(payload: unknown): string | number | undefined {
    return undefined;
  }

  /**
   * Asks the provider to answer the questions about the state. The answers are typed from the questions.
   * This is the typed public API. It wraps the request in a `cds.Request` and sends it with `this.send`, so CAP's
   * `before`, `on` and `after` handlers (including the one of `init`) and `cds.context` apply; the abort signal
   * reaches the handler through a symbol on that request.
   * Rejects with a {@link DecisionsError}; the `ABORTED` code follows `options.signal`.
   */
  decide<Q extends Questions>(request: DecisionRequest<Q>, options: DecideOptions = {}): Promise<DecisionResult<Q>> {
    const event = new cds.Request({ event: 'decide', data: request }) as SignalRequest<Q>;
    if (options.signal) event[signalKey] = options.signal;
    return this.send<DecisionResult<Q>>(event as unknown as { event: string; data: DecisionRequest<Q> });
  }
}

export { DecisionsError } from './validation';
export type { DecisionsErrorCode } from './validation';
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
  DecisionsCredentials,
  DecisionsSettings,
  MockSettings,
} from './types';

export default DecisionsService;
