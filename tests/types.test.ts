import type {
  Answer,
  Answers,
  ChoiceAnswer,
  DecisionRequest,
  NoulAnswer,
  Questions,
  ScoreAnswer,
  SystemOneService,
  SystemOneTransport,
} from '../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

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
