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
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
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

type AnswerFor<T> = T extends ChoiceQuestion
  ? ChoiceAnswer
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

export type SystemOneProvider = 'generic' | 'typesafe' | 'cloudflare' | 'laya';

export interface SystemOneSettings {
  provider?: SystemOneProvider;
  model?: string;
  timeoutMs?: number;
  credentials?: SystemOneCredentials;
}
