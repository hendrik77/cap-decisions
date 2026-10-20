import type { DecisionRequest, DecisionResult, Questions, SystemOneProvider } from './types';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const content = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'object' && value !== null && json(value));

function json(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return true;
  if (typeof value !== 'object') return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SystemOneError('INVALID_REQUEST', 'Request content contains an unsupported object; use plain JSON data');
  }
  if (ancestors.has(value))
    throw new SystemOneError('INVALID_REQUEST', 'Request content contains a circular reference');
  ancestors.add(value);
  try {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (!json(child, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export type SystemOneErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'HTTP_ERROR'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED';

export class SystemOneError extends Error {
  readonly status?: number;
  readonly providerCode?: string | number;

  constructor(
    public readonly code: SystemOneErrorCode,
    message: string,
    options: { status?: number; providerCode?: string | number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SystemOneError';
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

export function validateRequest(
  input: unknown,
  provider: SystemOneProvider = 'generic',
): asserts input is DecisionRequest {
  if (!record(input) || !content(input.state) || !record(input.questions) || !Object.keys(input.questions).length) {
    throw new SystemOneError('INVALID_REQUEST', 'state and a non-empty questions map are required');
  }
  if (provider === 'cloudflare' && Object.keys(input.questions).length > 64) {
    throw new SystemOneError('INVALID_REQUEST', 'Cloudflare supports at most 64 questions');
  }
  for (const [id, raw] of Object.entries(input.questions)) {
    if (!id || !record(raw) || !content(raw.instructions)) {
      throw new SystemOneError('INVALID_REQUEST', 'Each question needs an id and instructions');
    }
    const question = raw as Record<string, unknown>;
    if (question.criteria !== undefined && !json(question.criteria)) {
      throw new SystemOneError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
    }
    if (question.type === 'choice') {
      if (
        !record(question.criteria) ||
        !Object.keys(question.criteria).length ||
        (provider === 'typesafe' && Object.keys(question.criteria).length > 255) ||
        (provider === 'laya' && Object.keys(question.criteria).length > 100) ||
        Object.entries(question.criteria).some(([label, value]) => !label || (value !== null && !content(value)))
      ) {
        throw new SystemOneError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else if (question.type === 'score') {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < (provider === 'typesafe' ? 2 : 1) ||
        (provider === 'typesafe' && question.criteria.length > 10) ||
        !question.criteria.every(content)
      ) {
        throw new SystemOneError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else if (question.type === 'noul') {
      if (
        question.criteria !== undefined &&
        (!record(question.criteria) ||
          Object.entries(question.criteria).some(([key, value]) => !['true', 'false'].includes(key) || !content(value)))
      ) {
        throw new SystemOneError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else {
      throw new SystemOneError('INVALID_REQUEST', `Unknown question type for ${id}`);
    }
  }
}

function distribution(raw: unknown, labels: string[]): raw is Record<string, number> {
  return (
    record(raw) &&
    Object.keys(raw).length === labels.length &&
    labels.every((label) => probability(raw[label])) &&
    Object.keys(raw).every((label) => labels.includes(label)) &&
    Math.abs(labels.reduce((sum, label) => sum + (raw[label] as number), 0) - 1) < 0.02
  );
}

export function validateResult(raw: unknown, questions: Questions): asserts raw is DecisionResult {
  if (
    !record(raw) ||
    typeof raw.model !== 'string' ||
    !raw.model ||
    !record(raw.answers) ||
    !record(raw.usage) ||
    !Number.isSafeInteger(raw.usage.input_tokens) ||
    (raw.usage.input_tokens as number) < 0 ||
    !Number.isSafeInteger(raw.usage.output_tokens) ||
    (raw.usage.output_tokens as number) < 0 ||
    Object.keys(raw.answers).length !== Object.keys(questions).length
  ) {
    throw new SystemOneError('INVALID_RESPONSE', 'System One response has invalid metadata or answers');
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    if (!record(answer) || answer.type !== question.type) {
      throw new SystemOneError('INVALID_RESPONSE', `Missing or mismatched answer for ${id}`);
    }
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new SystemOneError('INVALID_RESPONSE', `Invalid noul answer for ${id}`);
    } else if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (
        typeof answer.choice !== 'string' ||
        !labels.includes(answer.choice) ||
        !distribution(answer.probabilities, labels) ||
        !probability(answer.confidence)
      ) {
        throw new SystemOneError('INVALID_RESPONSE', `Invalid choice answer for ${id}`);
      }
    } else {
      const labels = question.criteria.map((_, index) => String(index));
      if (
        !finite(answer.score) ||
        answer.score < 0 ||
        answer.score > labels.length - 1 ||
        !record(answer.legend) ||
        Object.keys(answer.legend).length !== labels.length ||
        !labels.every((label) => typeof (answer.legend as Record<string, unknown>)[label] === 'string') ||
        !distribution(answer.probabilities, labels) ||
        !probability(answer.confidence)
      ) {
        throw new SystemOneError('INVALID_RESPONSE', `Invalid score answer for ${id}`);
      }
    }
  }
}
