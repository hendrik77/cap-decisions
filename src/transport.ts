import { createRequire } from 'node:module';
import type { DecisionRequest, SystemOneCredentials, SystemOneSettings } from './types';
import { MAX_TIMEOUT_MS, SystemOneError, machineCode } from './validation';

const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);
const MAX_ERROR_BYTES = 8192;
const optionalRequire = createRequire(__filename);

export interface ResolvedDestination {
  url?: string;
  headers?: Record<string, unknown>;
}
export type DestinationResolver = (name: string) => Promise<ResolvedDestination | null>;

export interface TransportHooks {
  endpoint(credentials: SystemOneCredentials): string | undefined;
  unwrap(payload: unknown): unknown;
  errorCode(payload: unknown): string | number | undefined;
}

export interface TransportOptions {
  hooks?: Partial<TransportHooks>;
  destinationResolver?: DestinationResolver;
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

async function retryNetworkFailure(
  error: unknown,
  attempt: number,
  deadlineAt: number,
  signal: AbortSignal,
  caller?: AbortSignal,
): Promise<void> {
  if (signal.aborted || Date.now() >= deadlineAt) throw interruption(signal, caller, error);
  if (attempt === MAX_RETRIES) {
    throw new SystemOneError('NETWORK_ERROR', 'System One request failed', { cause: error });
  }
  await pause(Math.min(retryDelay(attempt, null), Math.max(0, deadlineAt - Date.now())), signal, caller);
  // The pause can end just before the deadline signal fires; never start an attempt after the deadline.
  if (signal.aborted || Date.now() >= deadlineAt) throw interruption(signal, caller, error);
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

function errorType(payload: unknown): string | number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === 'object' && error !== null ? machineCode((error as Record<string, unknown>).type) : undefined;
}

export class SystemOneTransport {
  private readonly url?: URL;
  private readonly timeoutMs: number;
  private readonly token?: string;
  private readonly destination?: string;
  private readonly modelId?: string;
  private readonly requiresToken: boolean;
  private readonly hooks: Partial<TransportHooks>;
  private readonly destinationResolver?: DestinationResolver;

  constructor(settings: SystemOneSettings, options: TransportOptions = {}) {
    this.hooks = options.hooks ?? {};
    this.destinationResolver = options.destinationResolver;
    const credentials = settings.credentials ?? {};
    this.requiresToken = settings.requiresToken === true;
    if (this.requiresToken && !credentials.token && !credentials.destination) {
      throw new SystemOneError('INVALID_CONFIG', 'This provider requires a token');
    }
    if (
      credentials.destination !== undefined &&
      (typeof credentials.destination !== 'string' || !credentials.destination.trim())
    ) {
      throw new SystemOneError('INVALID_CONFIG', 'destination must be a non-empty name');
    }
    if (!credentials.destination) {
      this.url = endpoint(this.hooks.endpoint?.(credentials) ?? credentials.url, !!credentials.token);
    }
    this.timeoutMs = settings.timeoutMs as number;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS)
      throw new SystemOneError('INVALID_CONFIG', `timeoutMs must be a positive integer at most ${MAX_TIMEOUT_MS}`);
    this.token = credentials.token;
    this.destination = credentials.destination;
    this.modelId = settings.modelId;
  }

  private async target(): Promise<{ url: URL; headers: Record<string, string> }> {
    const name = this.destination;
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
    const authorized = !!(headers.authorization || this.token);
    const url = endpoint(destination.url, authorized);
    if (this.requiresToken && !authorized) {
      throw new SystemOneError('INVALID_CONFIG', 'This provider requires a token');
    }
    return { url, headers };
  }

  async validateDestination(): Promise<void> {
    if (this.destination) await this.target();
  }

  async post(
    request: DecisionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ payload: unknown; attempts: number }> {
    const deadlineAt = Date.now() + this.timeoutMs;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    const body = JSON.stringify({ ...request, ...(this.modelId ? { model: this.modelId } : {}) });
    if (signal.aborted) throw interruption(signal, options.signal);
    const target = await untilAbort(this.target(), signal, options.signal);
    const headers: Record<string, string> = { ...target.headers, 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(target.url, { method: 'POST', headers, body, signal });
      } catch (error) {
        await retryNetworkFailure(error, attempt, deadlineAt, signal, options.signal);
        continue;
      }
      if (!response.ok) {
        if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt, response.headers.get('retry-after'));
          if (delay < deadlineAt - Date.now()) {
            await response.body?.cancel();
            await pause(delay, signal, options.signal);
            continue;
          }
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
          providerCode: this.providerCode(payload),
        });
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        await retryNetworkFailure(error, attempt, deadlineAt, signal, options.signal);
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (signal.aborted) throw interruption(signal, options.signal, error);
        throw new SystemOneError('INVALID_RESPONSE', 'System One returned invalid JSON', { cause: error });
      }
      return { payload: this.hooks.unwrap?.(payload) ?? payload, attempts: attempt + 1 };
    }
    throw new SystemOneError('NETWORK_ERROR', 'System One retries exhausted');
  }

  private providerCode(payload: unknown): string | number | undefined {
    const hooked = payload === undefined ? undefined : this.hooks.errorCode?.(payload);
    return hooked === undefined || hooked === null ? errorType(payload) : machineCode(hooked);
  }
}
