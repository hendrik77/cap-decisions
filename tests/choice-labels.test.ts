import type { Answers, ChoiceAnswer, ChoiceQuestion, Content, NoulAnswer, Questions, SystemOneService } from '../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team?',
    criteria: { billing: 'Payments', technical: 'Bugs' },
  },
  priority: { type: 'choice', instructions: 'Which priority?', criteria: { normal: null, urgent: 'Urgent' } },
  refund: { type: 'noul', instructions: 'Refund?' },
} satisfies Questions;

const readonlyQuestions = {
  department: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, technical: 'Bugs' } },
} as const;

type NumericQuestions = {
  rating: { type: 'choice'; instructions: string; criteria: { 0: string; 1: string } };
};
type UnionCriteria = {
  department: { type: 'choice'; instructions: string; criteria: { billing: string } | { technical: string } };
};
type OptionalCriteria = {
  department: { type: 'choice'; instructions: string; criteria: { billing: string; technical?: string } };
};
type DynamicCriteria = {
  department: { type: 'choice'; instructions: string; criteria: Record<string, Content | null> };
};

export type DepartmentAnswer = Assert<
  Equal<Answers<typeof questions>['department'], ChoiceAnswer<'billing' | 'technical'>>
>;
export type PriorityAnswer = Assert<Equal<Answers<typeof questions>['priority'], ChoiceAnswer<'normal' | 'urgent'>>>;
export type RefundAnswer = Assert<Equal<Answers<typeof questions>['refund'], NoulAnswer>>;
export type ReadonlyAnswer = Assert<
  Equal<Answers<typeof readonlyQuestions>['department'], ChoiceAnswer<'billing' | 'technical'>>
>;
export type NumericAnswer = Assert<Equal<Answers<NumericQuestions>['rating'], ChoiceAnswer<'0' | '1'>>>;
export type UnionAnswer = Assert<
  Equal<Answers<UnionCriteria>['department'], ChoiceAnswer<'billing'> | ChoiceAnswer<'technical'>>
>;
export type OptionalAnswer = Assert<
  Equal<Answers<OptionalCriteria>['department'], ChoiceAnswer<'billing' | 'technical', 'technical'>>
>;
export type OptionalProbability = Assert<
  Equal<Answers<OptionalCriteria>['department']['probabilities']['technical'], number | undefined>
>;
export type DynamicAnswer = Assert<Equal<Answers<DynamicCriteria>['department'], ChoiceAnswer>>;
export type BroadChoiceAnswer = Assert<Equal<Answers<Record<string, ChoiceQuestion>>[string], ChoiceAnswer>>;
export type DefaultChoice = Assert<Equal<ChoiceAnswer['choice'], string>>;
export type DefaultProbabilities = Assert<Equal<ChoiceAnswer['probabilities'], Record<string, number>>>;

export function exhaustiveDepartment(answer: Answers<typeof questions>['department']): number {
  switch (answer.choice) {
    case 'billing':
      return answer.probabilities.billing;
    case 'technical':
      return answer.probabilities.technical;
    default: {
      const unhandled: never = answer.choice;
      return unhandled;
    }
  }
}

export function narrowUnionCriteria(answer: Answers<UnionCriteria>['department']): number {
  // @ts-expect-error A union of criteria maps does not guarantee both keys are present.
  void answer.probabilities.billing;
  if (answer.choice === 'billing') return answer.probabilities.billing;
  return answer.probabilities.technical;
}

export function optionalCriteria(answer: Answers<OptionalCriteria>['department']): ChoiceAnswer {
  const billing: number = answer.probabilities.billing;
  // @ts-expect-error An optional criteria key may be absent from the probabilities.
  const technical: number = answer.probabilities.technical;
  void billing;
  void technical;
  return answer;
}

export async function inference(service: SystemOneService): Promise<void> {
  const serviceInline = await service.decide({
    state: 'Refund me',
    questions: {
      department: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: 'Bugs' } },
    },
  });
  const serviceVariable = await service.decide({ state: 'Refund me', questions });
  const otherVariable = await service.decide({ state: 'Refund me', questions }, { signal: AbortSignal.timeout(1000) });
  const readonly = await service.decide({ state: 'Refund me', questions: readonlyQuestions });
  exhaustiveDepartment(serviceInline.answers.department);
  exhaustiveDepartment(readonly.answers.department);
  const checks: [
    Assert<Equal<typeof serviceInline.answers.department.choice, 'billing' | 'technical'>>,
    Assert<Equal<typeof serviceVariable.answers.department.choice, 'billing' | 'technical'>>,
    Assert<Equal<typeof otherVariable.answers.department.choice, 'billing' | 'technical'>>,
    Assert<Equal<typeof serviceVariable.answers.department.probabilities, Record<'billing' | 'technical', number>>>,
  ] = [true, true, true, true];
  const department = serviceVariable.answers.department;
  const probability: number = department.probabilities[department.choice];
  // @ts-expect-error Only labels declared in the criteria are valid choices.
  department.choice = 'sales';
  // @ts-expect-error Another question's labels are not department labels.
  department.choice = otherVariable.answers.priority.choice;
  // @ts-expect-error Probability keys must be declared in this question's criteria.
  void department.probabilities.sales;
  const incomplete = { billing: 1 };
  // @ts-expect-error A handler map must cover every possible choice label.
  const handlers: Record<typeof department.choice, number> = incomplete;
  void handlers;
  void probability;
  void checks;
}
