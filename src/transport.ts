import type { DecisionRequest, DecisionResult, Questions, SystemOneCredentials } from './types';
import { SystemOneError, validateRequest, validateResult } from './validation';

const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);
const MAX_ERROR_BYTES = 8192;

export interface DecisionOptions {
  signal?: AbortSignal;
  onComplete?: (attempts: number, result: DecisionResult) => void;
}

function interruption(signal: AbortSignal, caller?: AbortSignal, cause?: unknown): SystemOneError {
  if (caller?.aborted)
    return new SystemOneError('ABORTED', 'System One request was cancelled', { cause: cause ?? caller.reason });
  return new SystemOneError('TIMEOUT', 'System One request timed out', { cause: cause ?? signal.reason });
}

async function pause(ms: number, signal: AbortSignal, caller?: AbortSignal): Promise<void> {
  if (signal.aborted) throw interruption(signal, caller);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  } catch (error) {
    throw interruption(signal, caller, error);
  }
}

function retryDelay(attempt: number, header: string | null): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.round(500 * 2 ** attempt * (0.5 + Math.random()));
}

function machineCode(raw: unknown): string | number | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'string' && /^[\w.:-]{1,100}$/.test(raw)) return raw;
  return undefined;
}

async function errorPayload(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BYTES) break;
      chunks.push(value);
    }
    if (size > MAX_ERROR_BYTES) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function providerCode(payload: unknown, format: 'direct' | 'cloudflare'): string | number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const data = payload as Record<string, unknown>;
  if (format === 'cloudflare') {
    const first = Array.isArray(data.errors) ? data.errors[0] : undefined;
    return typeof first === 'object' && first !== null
      ? machineCode((first as Record<string, unknown>).code)
      : undefined;
  }
  const error = data.error;
  return typeof error === 'object' && error !== null ? machineCode((error as Record<string, unknown>).type) : undefined;
}

export class SystemOneTransport {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly responseFormat: 'direct' | 'cloudflare';

  constructor(private readonly credentials: SystemOneCredentials = {}) {
    try {
      this.url = new URL(credentials.url ?? '');
    } catch (error) {
      throw new SystemOneError('INVALID_CONFIG', 'A complete endpoint URL is required', { cause: error });
    }
    if (!['https:', 'http:'].includes(this.url.protocol) || !this.url.host) {
      throw new SystemOneError('INVALID_CONFIG', 'Endpoint URL must use HTTP or HTTPS');
    }
    if (
      credentials.token &&
      this.url.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname)
    ) {
      throw new SystemOneError('INVALID_CONFIG', 'Token requires HTTPS or a loopback endpoint');
    }
    this.timeoutMs = credentials.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new SystemOneError('INVALID_CONFIG', 'timeoutMs must be a positive integer');
    this.responseFormat = credentials.responseFormat ?? 'direct';
    if (!['direct', 'cloudflare'].includes(this.responseFormat))
      throw new SystemOneError('INVALID_CONFIG', 'Unknown response format');
  }

  async decide<Q extends Questions>(
    request: DecisionRequest<Q>,
    options: DecisionOptions = {},
  ): Promise<DecisionResult<Q>> {
    validateRequest(request);
    const model = this.credentials.model;
    const body = JSON.stringify({ ...request, ...(model ? { model } : {}) });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.credentials.token) headers.authorization = `Bearer ${this.credentials.token}`;

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    if (signal.aborted) throw interruption(signal, options.signal);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.url, { method: 'POST', headers, body, signal });
      } catch (error) {
        if (signal.aborted) throw interruption(signal, options.signal, error);
        if (attempt < MAX_RETRIES) {
          await pause(Math.min(retryDelay(attempt, null), this.timeoutMs), signal, options.signal);
          continue;
        }
        throw new SystemOneError('NETWORK_ERROR', 'System One request failed', { cause: error });
      }
      if (!response.ok) {
        if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          await response.body?.cancel();
          await pause(
            Math.min(retryDelay(attempt, response.headers.get('retry-after')), this.timeoutMs),
            signal,
            options.signal,
          );
          continue;
        }
        let payload: unknown;
        try {
          payload = await errorPayload(response);
        } catch (error) {
          if (signal.aborted) throw interruption(signal, options.signal, error);
          throw new SystemOneError('INVALID_RESPONSE', 'Failed reading System One error response', { cause: error });
        }
        throw new SystemOneError('HTTP_ERROR', `System One returned HTTP ${response.status}`, {
          status: response.status,
          providerCode: providerCode(payload, this.responseFormat),
          cause: response,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (signal.aborted) throw interruption(signal, options.signal, error);
        throw new SystemOneError('INVALID_RESPONSE', 'System One returned invalid JSON', { cause: error });
      }
      if (this.responseFormat === 'cloudflare') {
        if (typeof payload !== 'object' || payload === null) {
          throw new SystemOneError('INVALID_RESPONSE', 'Cloudflare response is invalid');
        }
        const envelope = payload as Record<string, unknown>;
        if (envelope.success !== true) {
          throw new SystemOneError('PROVIDER_ERROR', 'Cloudflare reported a failed request', {
            providerCode: providerCode(payload, 'cloudflare'),
          });
        }
        if (!('result' in envelope)) {
          throw new SystemOneError('INVALID_RESPONSE', 'Cloudflare response is missing result');
        }
        payload = envelope.result;
      }
      validateResult(payload, request.questions);
      options.onComplete?.(attempt + 1, payload as DecisionResult);
      return payload as DecisionResult<Q>;
    }
    throw new SystemOneError('NETWORK_ERROR', 'System One retries exhausted');
  }
}
