import type { DecisionRequest, DecisionResult, ProviderLimits, Questions } from './types';

export const MAX_TIMEOUT_MS = 2_147_483_647;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const probability = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const content = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'object' && value !== null && json(value));

// True for values that survive JSON: no cycles, no undefined, no non-finite numbers.
function json(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)) return true;
  if (typeof value !== 'object') return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DecisionsError('INVALID_REQUEST', 'Request content contains an unsupported object; use plain JSON data');
  }
  if (ancestors.has(value))
    throw new DecisionsError('INVALID_REQUEST', 'Request content contains a circular reference');
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

/**
 * The code of a {@link DecisionsError}.
 *
 * - `INVALID_CONFIG`: the settings, the token or the endpoint are invalid or missing.
 * - `INVALID_REQUEST`: the request does not match the question schema or the limits; nothing was sent.
 * - `INVALID_RESPONSE`: the response is malformed, too large or does not match the questions.
 * - `HTTP_ERROR`: the endpoint answered with an error status (or a redirect); see `status`.
 * - `PROVIDER_ERROR`: the provider reported a failure in a successful HTTP response.
 * - `NETWORK_ERROR`: the connection or the body failed after all retries.
 * - `TIMEOUT`: the call exceeded `timeoutMs`.
 * - `ABORTED`: the caller's `signal` cancelled the call.
 *
 * The union may grow in a minor release (ADR 0006); code that switches over it needs a default branch.
 */
export type DecisionsErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'HTTP_ERROR'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED';

/** The error every failure of `decide()` and of connecting the service is raised as. */
export class DecisionsError extends Error {
  /** The HTTP status of an `HTTP_ERROR`; otherwise usually unset. */
  readonly status?: number;
  /** The provider's machine-readable error code, when the response had one. */
  readonly providerCode?: string | number;

  constructor(
    /** What kind of failure this is; branch on it, not on the message. */
    public readonly code: DecisionsErrorCode,
    message: string,
    options: { status?: number; providerCode?: string | number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DecisionsError';
    this.status = options.status;
    this.providerCode = options.providerCode;
  }

  /**
   * `instanceof DecisionsError` also holds for an error of another copy of `cap-decisions`, as when an application and
   * CAP load the package through different paths (seen on Windows) or a provider package brings its own copy.
   * Subclasses keep the usual check.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === DecisionsError && typeof value === 'object' && value !== null && brand in value;
  }
}

// A global symbol, so that every copy of the module marks its errors the same way.
const brand = Symbol.for('cap-decisions.DecisionsError');
Object.defineProperty(DecisionsError.prototype, brand, { value: true });

// Accepts a provider code only when it is a safe integer or a short token, so no message text leaks into `providerCode`.
export function machineCode(raw: unknown): string | number | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'string' && /^[\w.:-]{1,100}$/.test(raw)) return raw;
  return undefined;
}

// Checks a request against the shape of the API and the provider's limits before anything is sent.
export function validateRequest(input: unknown, limits: ProviderLimits = {}): asserts input is DecisionRequest {
  if (!record(input) || !content(input.state) || !record(input.questions) || !Object.keys(input.questions).length) {
    throw new DecisionsError('INVALID_REQUEST', 'state and a non-empty questions map are required');
  }
  if (limits.questions !== undefined && Object.keys(input.questions).length > limits.questions) {
    throw new DecisionsError('INVALID_REQUEST', `At most ${limits.questions} questions are supported`);
  }
  for (const [id, raw] of Object.entries(input.questions)) {
    if (!id || !record(raw) || !content(raw.instructions)) {
      throw new DecisionsError('INVALID_REQUEST', 'Each question needs an id and instructions');
    }
    const question = raw as Record<string, unknown>;
    if (question.criteria !== undefined && !json(question.criteria)) {
      throw new DecisionsError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
    }
    if (question.type === 'choice') {
      if (
        !record(question.criteria) ||
        !Object.keys(question.criteria).length ||
        (limits.choiceOptions !== undefined && Object.keys(question.criteria).length > limits.choiceOptions) ||
        Object.entries(question.criteria).some(([label, value]) => !label || (value !== null && !content(value)))
      ) {
        throw new DecisionsError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else if (question.type === 'score') {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < Math.max(1, limits.scoreCriteria?.min ?? 1) ||
        (limits.scoreCriteria?.max !== undefined && question.criteria.length > limits.scoreCriteria.max) ||
        !question.criteria.every(content)
      ) {
        throw new DecisionsError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else if (question.type === 'noul') {
      if (
        question.criteria !== undefined &&
        (!record(question.criteria) ||
          Object.entries(question.criteria).some(([key, value]) => !['true', 'false'].includes(key) || !content(value)))
      ) {
        throw new DecisionsError('INVALID_REQUEST', `Invalid criteria for question ${id}`);
      }
    } else {
      throw new DecisionsError('INVALID_REQUEST', `Unknown question type for ${id}`);
    }
  }
}

// Keys CAP puts on a connected service's options. Verified on CAP 10.1.1 and 9.9.3: only kind and impl, which are
// known keys anyway; the rest are CAP's documented per-service options that are valid on any service.
export const CAP_SETTINGS_KEYS: readonly string[] = ['service', 'queued', 'outboxed', 'outbox', 'binding', 'vcap'];
const SETTINGS_KEYS = ['kind', 'impl', 'modelId', 'timeoutMs', 'requiresToken', 'limits', 'credentials'];
const CREDENTIAL_KEYS = ['url', 'token', 'accountId', 'destination'];

const plain = (value: unknown): value is Record<string, unknown> =>
  record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const positive = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
/** True when `value` has a character that is not valid in an HTTP header value (visible ASCII, space, tab only). */
export const isInvalidHeaderValue = (value: string): boolean => /[^\t\x20-\x7e]/.test(value);
/** True for `localhost`, an IPv4 address 127.x.x.x and `::1` (also as `[::1]`, which `URL.hostname` returns). */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
const invalidConfig = (message: string) => new DecisionsError('INVALID_CONFIG', message);

// Checks the `limits` setting of a kind.
function validateLimits(limits: unknown): void {
  if (!plain(limits)) throw invalidConfig('limits must be an object');
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'scoreCriteria') {
      if (!plain(value)) throw invalidConfig('limits.scoreCriteria must be an object');
      for (const [bound, count] of Object.entries(value)) {
        if (!['min', 'max'].includes(bound)) throw invalidConfig(`Unknown setting "limits.scoreCriteria.${bound}"`);
        if (!positive(count)) throw invalidConfig(`limits.scoreCriteria.${bound} must be a positive integer`);
      }
      if (value.min !== undefined && value.max !== undefined && (value.min as number) > (value.max as number)) {
        throw invalidConfig('limits.scoreCriteria.min must not exceed max');
      }
    } else if (['questions', 'choiceOptions'].includes(key)) {
      if (!positive(value)) throw invalidConfig(`limits.${key} must be a positive integer`);
    } else {
      throw invalidConfig(`Unknown setting "limits.${key}"`);
    }
  }
}

// Checks `cds.requires.decisions`; returns warnings for unknown keys, which providers may extend.
export function validateSettings(
  settings: unknown,
  extraKeys: readonly string[] = [],
  extraCredentialKeys: readonly string[] = [],
): string[] {
  const values = settings === undefined ? {} : settings;
  if (!plain(values)) throw invalidConfig('cds.requires.decisions must be an object');
  if (Object.hasOwn(values, 'model')) {
    throw invalidConfig('The model setting was renamed to modelId; CAP reads model as the CDS model of a service');
  }
  for (const key of CREDENTIAL_KEYS) {
    if (Object.hasOwn(values, key)) throw invalidConfig(`Move ${key} under credentials`);
  }
  if (values.credentials !== undefined) {
    const credentials = values.credentials;
    if (!plain(credentials)) throw invalidConfig('credentials must be an object');
    for (const [key, value] of Object.entries(credentials)) {
      if (!CREDENTIAL_KEYS.includes(key) && !extraCredentialKeys.includes(key))
        throw invalidConfig(`Unknown credentials setting "${key}"`);
      if (value !== undefined && typeof value !== 'string') throw invalidConfig(`credentials.${key} must be a string`);
    }
    if (typeof credentials.token === 'string' && isInvalidHeaderValue(credentials.token)) {
      throw invalidConfig('credentials.token must contain only visible ASCII characters');
    }
    if (credentials.destination !== undefined && !(credentials.destination as string).trim()) {
      throw invalidConfig('destination must be a non-empty name');
    }
  }
  for (const key of ['queued', 'outboxed', 'outbox']) {
    if (values[key]) {
      throw invalidConfig(
        `${key} is not supported: a decision needs an answer, so the decisions service cannot be queued`,
      );
    }
  }
  if (values.modelId !== undefined && (typeof values.modelId !== 'string' || !values.modelId)) {
    throw invalidConfig('modelId must be a non-empty string');
  }
  if (values.requiresToken !== undefined && typeof values.requiresToken !== 'boolean') {
    throw invalidConfig('requiresToken must be a boolean');
  }
  if (values.timeoutMs !== undefined && !positive(values.timeoutMs, MAX_TIMEOUT_MS)) {
    throw invalidConfig(`timeoutMs must be a positive integer at most ${MAX_TIMEOUT_MS}`);
  }
  if (values.limits !== undefined) validateLimits(values.limits);
  const known = new Set([...SETTINGS_KEYS, ...CAP_SETTINGS_KEYS, ...extraKeys]);
  return Object.keys(values)
    .filter((key) => !known.has(key))
    .map((key) => `Unknown setting "${key}" for cds.requires.decisions is ignored`);
}

// True when the probabilities cover exactly the labels and add up to 1 (within 0.02).
function distribution(raw: unknown, labels: string[]): raw is Record<string, number> {
  return (
    record(raw) &&
    Object.keys(raw).length === labels.length &&
    labels.every((label) => probability(raw[label])) &&
    Object.keys(raw).every((label) => labels.includes(label)) &&
    Math.abs(labels.reduce((sum, label) => sum + (raw[label] as number), 0) - 1) < 0.02
  );
}

// Checks a provider's result against the questions; a provider that answers differently gets INVALID_RESPONSE.
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
    throw new DecisionsError('INVALID_RESPONSE', 'Decision response has invalid metadata or answers');
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw.answers[id];
    if (!record(answer) || answer.type !== question.type) {
      throw new DecisionsError('INVALID_RESPONSE', `Missing or mismatched answer for ${id}`);
    }
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new DecisionsError('INVALID_RESPONSE', `Invalid noul answer for ${id}`);
    } else if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (
        typeof answer.choice !== 'string' ||
        !labels.includes(answer.choice) ||
        !distribution(answer.probabilities, labels) ||
        !probability(answer.confidence)
      ) {
        throw new DecisionsError('INVALID_RESPONSE', `Invalid choice answer for ${id}`);
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
        throw new DecisionsError('INVALID_RESPONSE', `Invalid score answer for ${id}`);
      }
    }
  }
}
