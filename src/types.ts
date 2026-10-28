import type { DecisionsErrorCode } from './validation';

/** Any value that survives `JSON.stringify` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** Text or plain JSON data (an array or a plain object) used for state, instructions and criteria. */
export type Content = string | JsonValue[] | { [key: string]: JsonValue };

/** A yes/no question; the answer is the probability that it is true. */
export interface NoulQuestion {
  type: 'noul';
  /** What to decide. */
  instructions: Content;
  /** Optional descriptions of what a true and a false answer mean. */
  criteria?: { true?: Content; false?: Content };
}

/** A question with named options; the answer picks one of them. */
export interface ChoiceQuestion {
  type: 'choice';
  /** What to decide. */
  instructions: Content;
  /** The options, by label, each with an optional description (`null` for none); a label is the answer's `choice`. */
  criteria: Record<string, Content | null>;
}

/** A question answered with a score along a scale. */
export interface ScoreQuestion {
  type: 'score';
  /** What to decide. */
  instructions: Content;
  /** The scale: the text of each criterion, by index; the score runs from 0 to the last index. */
  criteria: Content[];
}

/** Any of the question types, told apart by `type`. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
/** The questions of a request, by name; the answers use the same names. */
export type Questions = Record<string, Question>;

/** The answer to a {@link NoulQuestion}. */
export interface NoulAnswer {
  type: 'noul';
  /** The probability, from 0 to 1, that the answer is true. */
  noul: number;
}
/** The answer to a {@link ChoiceQuestion}; typed with the labels of the question's criteria. */
export interface ChoiceAnswer<Label extends string = string, OptionalLabel extends Label = never> {
  type: 'choice';
  /** The label of the chosen option. */
  choice: Label;
  /** The probability (0 to 1) of each option; they sum to 1. An optional criteria key may be absent. */
  probabilities: [OptionalLabel] extends [never]
    ? Record<Label, number>
    : Record<Exclude<Label, OptionalLabel>, number> & Partial<Record<OptionalLabel, number>>;
  /** The model's confidence (0 to 1). */
  confidence: number;
}
/** The answer to a {@link ScoreQuestion}. */
export interface ScoreAnswer {
  type: 'score';
  /** A number from 0 to the last criteria index. */
  score: number;
  /** The criteria text by index (`'0'`, `'1'`, ...). */
  legend: Record<string, string>;
  /** The probability (0 to 1) of each index; they sum to 1. */
  probabilities: Record<string, number>;
  /** The model's confidence (0 to 1). */
  confidence: number;
}
/** Any of the answer types, told apart by `type`. */
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
/** The answers for the questions `Q`, by name, each typed after its question. */
export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

/** What `decide()` takes: a state and the questions to answer about it. */
export interface DecisionRequest<Q extends Questions = Questions> {
  /** The situation to decide on. */
  state: Content;
  /** The questions, by name. */
  questions: Q;
}

/** What `decide()` returns. */
export interface DecisionResult<Q extends Questions = Questions> {
  /** The model that answered, as the provider reports it. */
  model: string;
  /** The answers, by the names of the questions. */
  answers: Answers<Q>;
  /** Token counts; a provider may add further fields. */
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
}

/** Secrets and the endpoint, under `credentials` in the service settings. */
export interface DecisionsCredentials {
  /** Full POST URL of the endpoint. */
  url?: string;
  /** Bearer token. */
  token?: string;
  /** Account ID; `decisions-cloudflare` builds the URL from it. */
  accountId?: string;
  /** Name of a BTP Destination service entry that supplies the URL and headers. */
  destination?: string;
}

/** Request limits of a provider, checked before anything is sent (positive integers). */
export interface ProviderLimits {
  /** Maximum number of questions per request. */
  questions?: number;
  /** Maximum number of criteria in a `choice` question. */
  choiceOptions?: number;
  /** Allowed number of criteria in a `score` question. */
  scoreCriteria?: { min?: number; max?: number };
}

/** The settings of the `decisions` service, under `cds.requires.decisions`. */
export interface DecisionsSettings {
  /** Model name, sent as `model` in the request body. */
  modelId?: string;
  /** Time limit for the whole call including retries, 1 to 2,147,483,647 ms (default 10,000). */
  timeoutMs?: number;
  /** When true, connecting fails with `INVALID_CONFIG` unless a token or a destination supplies one. */
  requiresToken?: boolean;
  /** Request limits. */
  limits?: ProviderLimits;
  /** The endpoint and its secrets. */
  credentials?: DecisionsCredentials;
}

/** The settings of the `decisions-mock` kind. */
export interface MockSettings extends DecisionsSettings {
  /** Path of the fixtures file, relative to the project root (default `test/data/decisions.json`). */
  fixtures?: string;
  /** How answers are made when no rule matches: `keywords` matches words of the state to the choices, `seeded` uses the seed alone. */
  strategy?: 'keywords' | 'seeded';
  /** Simulated latency in ms; a latency of `timeoutMs` or more ends in `TIMEOUT`. */
  latencyMs?: number;
  /** Makes every call fail with this code, optionally with a status and provider code. */
  fail?: DecisionsErrorCode | { code: DecisionsErrorCode; status?: number; providerCode?: string };
  /** The mock refuses the `production` profile unless this is true. */
  allowInProduction?: boolean;
}
