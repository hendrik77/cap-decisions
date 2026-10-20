import cds from '@sap/cds';
import { SystemOneTransport } from './transport';
import type { DecisionRequest, DecisionResult, Questions, SystemOneCredentials } from './types';

const signalKey = Symbol('systemone.callerSignal');
type SignalRequest<Q extends Questions = Questions> = cds.Request<DecisionRequest<Q>> & { [signalKey]?: AbortSignal };

export class SystemOneService extends cds.Service {
  private transport!: SystemOneTransport;

  async init(): Promise<void> {
    const credentials =
      (this as cds.Service & { options?: { credentials?: SystemOneCredentials } }).options?.credentials ?? {};
    this.transport = new SystemOneTransport(credentials);
    this.on('decide', async (request: SignalRequest) => {
      const started = performance.now();
      return this.transport.decide(request.data, {
        signal: request[signalKey],
        onComplete: (attempts, result) => {
          cds.log('systemone').debug('decision completed', {
            latencyMs: Math.round(performance.now() - started),
            attempts,
            model: result.model,
            usage: {
              input_tokens: result.usage.input_tokens,
              output_tokens: result.usage.output_tokens,
            },
          });
        },
      });
    });
    await super.init();
  }

  decide<Q extends Questions>(
    request: DecisionRequest<Q>,
    options: { signal?: AbortSignal } = {},
  ): Promise<DecisionResult<Q>> {
    const event = new cds.Request({ event: 'decide', data: request }) as SignalRequest<Q>;
    if (options.signal) event[signalKey] = options.signal;
    return this.send<DecisionResult<Q>>(event as unknown as { event: string; data: DecisionRequest<Q> });
  }
}

export { SystemOneTransport } from './transport';
export { SystemOneError } from './validation';
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
  SystemOneCredentials,
} from './types';

export default SystemOneService;
