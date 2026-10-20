import { createRequire } from 'node:module';
import type { DecisionRequest, DecisionResult, Questions, SystemOneProvider, SystemOneSettings } from './types';
import { SystemOneError, validateRequest, validateResult } from './validation';

const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);
const MAX_ERROR_BYTES = 8192;
const optionalRequire = createRequire(__filename);

export interface ResolvedDestination {
  url?: string;
  headers?: Record<string, unknown>;
}
export type DestinationResolver = (name: string) => Promise<ResolvedDestination | null>;

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

async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal, caller?: AbortSignal): Promise<T> {
  if (signal.aborted) throw interruption(signal, caller);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(interruption(signal, caller));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function endpoint(url: string | undefined, authorized: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch (error) {
    throw new SystemOneError('INVALID_CONFIG', 'A complete endpoint URL is required', { cause: error });
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.host) {
    throw new SystemOneError('INVALID_CONFIG', 'Endpoint URL must use HTTP or HTTPS');
  }
  if (authorized && parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new SystemOneError('INVALID_CONFIG', 'Token requires HTTPS or a loopback endpoint');
  }
  return parsed;
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
  private readonly url?: URL;
  private readonly timeoutMs: number;
  private readonly responseFormat: 'direct' | 'cloudflare';
  private readonly provider: SystemOneProvider;

  constructor(
    private readonly settings: SystemOneSettings,
    private readonly destinationResolver?: DestinationResolver,
  ) {
    this.provider = settings.provider ?? 'generic';
    if (
      !['generic', 'typesafe', 'cloudflare', 'laya'].includes(this.provider) ||
      'responseFormat' in settings ||
      settings.model === null
    ) {
      throw new SystemOneError('INVALID_CONFIG', 'Invalid provider or model setting');
    }
    const credentials = settings.credentials ?? {};
    if ('model' in credentials || 'timeoutMs' in credentials || 'responseFormat' in credentials) {
      throw new SystemOneError(
        'INVALID_CONFIG',
        'Move model and timeoutMs to service settings and select a provider kind',
      );
    }
    if (['typesafe', 'cloudflare'].includes(this.provider) && !credentials.token && !credentials.destination) {
      throw new SystemOneError('INVALID_CONFIG', 'This provider requires a token');
    }
    if (this.provider === 'cloudflare' && !credentials.accountId && !credentials.destination) {
      throw new SystemOneError('INVALID_CONFIG', 'Cloudflare requires accountId');
    }
    if (
      credentials.destination !== undefined &&
      (typeof credentials.destination !== 'string' || !credentials.destination.trim())
    ) {
      throw new SystemOneError('INVALID_CONFIG', 'destination must be a non-empty name');
    }
    if (!credentials.destination) {
      const url =
        this.provider === 'cloudflare'
          ? (credentials.url ??
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId ?? '')}/ai/run/@cf/cloudflare/clef`)
          : credentials.url;
      this.url = endpoint(url, !!credentials.token);
    }
    this.timeoutMs = settings.timeoutMs as number;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0)
      throw new SystemOneError('INVALID_CONFIG', 'timeoutMs must be a positive integer');
    this.responseFormat = this.provider === 'cloudflare' ? 'cloudflare' : 'direct';
  }

  private async target(): Promise<{ url: URL; headers: Record<string, string> }> {
    const name = this.settings.credentials?.destination;
    if (!name) return { url: this.url as URL, headers: {} };
    let resolver = this.destinationResolver;
    if (!resolver) {
      let sdk: { getDestination?: (options: { destinationName: string }) => Promise<ResolvedDestination | null> };
      try {
        sdk = optionalRequire('@sap-cloud-sdk/connectivity');
      } catch (error) {
        throw new SystemOneError(
          'INVALID_CONFIG',
          'Install @sap-cloud-sdk/connectivity to use credentials.destination',
          { cause: error },
        );
      }
      if (typeof sdk.getDestination !== 'function') {
        throw new SystemOneError('INVALID_CONFIG', 'The Cloud SDK does not expose getDestination');
      }
      resolver = (destinationName) => sdk.getDestination!({ destinationName });
    }
    let destination: ResolvedDestination | null;
    try {
      destination = await resolver(name);
    } catch (error) {
      throw new SystemOneError('INVALID_CONFIG', 'Could not resolve destination', { cause: error });
    }
    if (!destination) throw new SystemOneError('INVALID_CONFIG', 'Destination was not found');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(destination.headers ?? {})) {
      if (typeof value !== 'string') throw new SystemOneError('INVALID_CONFIG', 'Destination headers must be strings');
      headers[key.toLowerCase()] = value;
    }
    const authorized = !!(headers.authorization || this.settings.credentials?.token);
    const url = endpoint(destination.url, authorized);
    if (['typesafe', 'cloudflare'].includes(this.provider) && !authorized) {
      throw new SystemOneError('INVALID_CONFIG', 'This provider requires a token');
    }
    return { url, headers };
  }

  async validateDestination(): Promise<void> {
    if (this.settings.credentials?.destination) await this.target();
  }

  async decide<Q extends Questions>(
    request: DecisionRequest<Q>,
    options: DecisionOptions = {},
  ): Promise<DecisionResult<Q>> {
    validateRequest(request, this.provider);
    const model = this.settings.model;
    const body = JSON.stringify({ ...request, ...(model ? { model } : {}) });
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    if (signal.aborted) throw interruption(signal, options.signal);
    const target = await untilAbort(this.target(), signal, options.signal);
    const headers: Record<string, string> = { ...target.headers, 'content-type': 'application/json' };
    if (this.settings.credentials?.token) headers.authorization = `Bearer ${this.settings.credentials.token}`;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(target.url, { method: 'POST', headers, body, signal });
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
