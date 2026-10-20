import type { SystemOneErrorCode } from './validation';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Content = string | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: 'noul';
  instructions: Content;
  criteria?: { true?: Content; false?: Content };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: Content;
  criteria: Record<string, Content | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: Content;
  criteria: Content[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}
export interface ChoiceAnswer<Label extends string = string, OptionalLabel extends Label = never> {
  type: 'choice';
  choice: Label;
  probabilities: [OptionalLabel] extends [never]
    ? Record<Label, number>
    : Record<Exclude<Label, OptionalLabel>, number> & Partial<Record<OptionalLabel, number>>;
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

type Label<Key> = `${Extract<Key, string | number>}`;
// Literal keys that may be absent; index signatures are not treated as optional.
type OptionalKeys<T> = {
  [K in keyof T]-?: string extends K
    ? never
    : number extends K
      ? never
      : Record<never, never> extends Pick<T, K>
        ? K
        : never;
}[keyof T];

type ChoiceAnswerFor<Criteria> = Criteria extends unknown
  ? ChoiceAnswer<Label<keyof Criteria>, Label<OptionalKeys<Criteria>>>
  : never;

type AnswerFor<T> = T extends ChoiceQuestion
  ? ChoiceAnswerFor<T['criteria']>
  : T extends ScoreQuestion
    ? ScoreAnswer
    : T extends NoulQuestion
      ? NoulAnswer
      : never;
export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface DecisionRequest<Q extends Questions = Questions> {
  state: Content;
  questions: Q;
}

export interface DecisionResult<Q extends Questions = Questions> {
  model: string;
  answers: Answers<Q>;
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
}

export interface SystemOneCredentials {
  url?: string;
  token?: string;
  accountId?: string;
  destination?: string;
}

export interface ProviderLimits {
  questions?: number;
  choiceOptions?: number;
  scoreCriteria?: { min?: number; max?: number };
}

export interface SystemOneSettings {
  modelId?: string;
  timeoutMs?: number;
  requiresToken?: boolean;
  limits?: ProviderLimits;
  credentials?: SystemOneCredentials;
}

export interface MockSettings extends SystemOneSettings {
  fixtures?: string;
  strategy?: 'keywords' | 'seeded';
  latencyMs?: number;
  fail?: SystemOneErrorCode | { code: SystemOneErrorCode; status?: number; providerCode?: string };
  allowInProduction?: boolean;
}
