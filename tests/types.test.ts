import type {
  Answer,
  Answers,
  ChoiceAnswer,
  DecisionOptions,
  DecisionRequest,
  NoulAnswer,
  ProviderLimits,
  Questions,
  ScoreAnswer,
  SystemOneError,
  SystemOneErrorCode,
  SystemOneService,
  SystemOneSettings,
  SystemOneTransport,
} from '../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ErrorCode = Assert<Equal<SystemOneError['code'], SystemOneErrorCode>>;
export type TransportOptions = Assert<Equal<Parameters<SystemOneTransport['decide']>[1], DecisionOptions | undefined>>;

export function errorStatus(code: SystemOneErrorCode): number {
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
  service: SystemOneService,
  transport: SystemOneTransport,
  questions: Questions,
  request: DecisionRequest,
): Promise<void> {
  const dynamic = await service.decide({ state: 'x', questions });
  const dynamicRequest = await transport.decide(request);
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
  const satisfies = await transport.decide({ state: 'x', questions: precise });
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

export const settings: SystemOneSettings = {
  modelId: 'jev-latest',
  requiresToken: true,
  timeoutMs: 1000,
  limits: { questions: 64, choiceOptions: 255, scoreCriteria: { min: 2, max: 10 } },
  credentials: { url: 'https://example.test', token: 'secret' },
};
export const limits: ProviderLimits = { scoreCriteria: { max: 10 } };
// @ts-expect-error The provider setting was replaced by kinds.
export const withProvider: SystemOneSettings = { provider: 'laya' };
// @ts-expect-error The model setting was renamed to modelId.
export const withModel: SystemOneSettings = { model: 'jev-latest' };
