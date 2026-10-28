import {
  DecisionsService,
  type Answer,
  type Answers,
  type ChoiceAnswer,
  type DecideOptions,
  type DecisionRequest,
  type NoulAnswer,
  type ProviderLimits,
  type Questions,
  type ScoreAnswer,
  type DecisionsCredentials,
  type DecisionsError,
  type DecisionsErrorCode,
  type DecisionsSettings,
} from '../src';
import type { DecisionsTransport, TransportHooks } from '../src/transport';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ErrorCode = Assert<Equal<DecisionsError['code'], DecisionsErrorCode>>;
export type ServiceOptions = Assert<Equal<Parameters<DecisionsService['decide']>[1], DecideOptions | undefined>>;
export type TransportPost = Assert<
  Equal<Parameters<DecisionsTransport['post']>[1], { signal?: AbortSignal } | undefined>
>;
export type HookEndpoint = Assert<
  Equal<TransportHooks['endpoint'], (credentials: DecisionsCredentials) => string | undefined>
>;

export function errorStatus(code: DecisionsErrorCode): number {
  // @ts-expect-error Error codes are limited to the documented values.
  if (code === 'UNKNOWN') return 0;
  return code === 'INVALID_REQUEST' ? 400 : 502;
}

export type BroadAnswer = Assert<Equal<Answers<Questions>[string], Answer>>;

export function narrow(answer: Answers<Questions>[string]): string | number {
  if (answer.type === 'choice') return answer.choice;
  if (answer.type === 'score') return answer.score;
  return answer.noul;
}

export async function inference(
  service: DecisionsService,
  questions: Questions,
  request: DecisionRequest,
): Promise<void> {
  const dynamic = await service.decide({ state: 'x', questions });
  const dynamicRequest = await service.decide(request, { signal: AbortSignal.timeout(1000) });
  const inline = await service.decide({
    state: 'x',
    questions: {
      choice: { type: 'choice', instructions: 'Choose', criteria: { a: 'A' } },
      score: { type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
      noul: { type: 'noul', instructions: 'Yes?' },
    },
  });
  const precise = {
    choice: { type: 'choice', instructions: 'Choose', criteria: { a: 'A' } },
    score: { type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
    noul: { type: 'noul', instructions: 'Yes?' },
  } satisfies Questions;
  const satisfies = await service.decide({ state: 'x', questions: precise });
  const checks: [
    Assert<Equal<(typeof dynamic.answers)[string], Answer>>,
    Assert<Equal<(typeof dynamicRequest.answers)[string], Answer>>,
    Assert<Equal<typeof inline.answers.choice, ChoiceAnswer<'a'>>>,
    Assert<Equal<typeof inline.answers.score, ScoreAnswer>>,
    Assert<Equal<typeof inline.answers.noul, NoulAnswer>>,
    Assert<Equal<typeof satisfies.answers.choice, ChoiceAnswer<'a'>>>,
    Assert<Equal<typeof satisfies.answers.score, ScoreAnswer>>,
    Assert<Equal<typeof satisfies.answers.noul, NoulAnswer>>,
  ] = [true, true, true, true, true, true, true, true];
  narrow(dynamic.answers.any);
  narrow(dynamicRequest.answers.any);
  // @ts-expect-error A noul answer has no choice property.
  void inline.answers.noul.choice;
  // @ts-expect-error A choice answer has no score property.
  void satisfies.answers.choice.score;
  void checks;
}

export const settings: DecisionsSettings = {
  modelId: 'jev-latest',
  requiresToken: true,
  timeoutMs: 1000,
  limits: { questions: 64, choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } },
  credentials: { url: 'https://example.test', token: 'secret' },
};
export const limits: ProviderLimits = { scoreCriteria: { max: 10 } };
// @ts-expect-error The provider setting was replaced by kinds.
export const withProvider: DecisionsSettings = { provider: 'laya' };
// @ts-expect-error The model setting was renamed to modelId.
export const withModel: DecisionsSettings = { model: 'jev-latest' };

export class FullSubclass extends DecisionsService {
  static override settingsKeys = ['fixtures'];
  static override credentialKeys = ['region'];
  protected override async setup(settings: DecisionsSettings): Promise<void> {
    await super.setup(settings);
    void this.settings.modelId;
  }
  protected override async call(
    request: DecisionRequest,
    options: DecideOptions,
  ): Promise<{ result: unknown; attempts: number }> {
    void request.state;
    void options.signal;
    return { result: {}, attempts: 1 };
  }
  protected override endpoint(credentials: DecisionsCredentials): string | undefined {
    return credentials.url;
  }
  protected override unwrap(payload: unknown): unknown {
    return payload;
  }
  protected override errorCode(payload: unknown): string | number | undefined {
    return typeof payload === 'string' ? payload : undefined;
  }
}

export class DefaultCall extends DecisionsService {
  protected override async call(request: DecisionRequest, options: DecideOptions) {
    return super.call(request, options);
  }
}

export class WrongEndpoint extends DecisionsService {
  // @ts-expect-error endpoint must return string | undefined
  protected override endpoint(): number {
    return 1;
  }
}

export class WrongUnwrap extends DecisionsService {
  // @ts-expect-error unwrap takes the payload
  protected override unwrap(payload: string, extra: number): unknown {
    return [payload, extra];
  }
}

export class WrongErrorCode extends DecisionsService {
  // @ts-expect-error errorCode must return string | number | undefined
  protected override errorCode(): boolean {
    return true;
  }
}

export class WrongCall extends DecisionsService {
  // @ts-expect-error call must return the result and attempts
  protected override async call(): Promise<string> {
    return 'x';
  }
}
