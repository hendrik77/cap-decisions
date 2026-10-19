import type { DecisionRequest, DecisionResult, Questions, SystemOneCredentials } from './types';
import { SystemOneError, validateRequest, validateResult } from './validation';

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
const RETRY_DELAYS = [100, 200];

export class SystemOneTransport {
  constructor(private readonly credentials: SystemOneCredentials = {}) {}

  async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    validateRequest(request);
    const url = this.credentials.url ?? DEFAULT_URL;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new SystemOneError('INVALID_CONFIG', 'A complete endpoint URL is required'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.host) {
      throw new SystemOneError('INVALID_CONFIG', 'Endpoint URL must use HTTP or HTTPS');
    }
    const timeoutMs = this.credentials.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SystemOneError('INVALID_CONFIG', 'timeoutMs must be a positive integer');
    const responseFormat = this.credentials.responseFormat ?? 'direct';
    if (!['direct', 'cloudflare'].includes(responseFormat)) throw new SystemOneError('INVALID_CONFIG', 'Unknown response format');
    const model = this.credentials.model === undefined ? 'jev-latest' : this.credentials.model;
    const body = JSON.stringify({ ...request, ...(model ? { model } : {}) });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.credentials.token) headers.authorization = `Bearer ${this.credentials.token}`;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      let response: Response;
      try {
        response = await fetch(parsed, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new SystemOneError('TIMEOUT', 'System One request timed out');
        }
        throw new SystemOneError('NETWORK_ERROR', 'System One request failed');
      }
      if (!response.ok) {
        if ([429, 529].includes(response.status) && attempt < RETRY_DELAYS.length) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
          continue;
        }
        throw new SystemOneError('HTTP_ERROR', `System One returned HTTP ${response.status}`, response.status);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new SystemOneError('TIMEOUT', 'System One response timed out');
        }
        throw new SystemOneError('INVALID_RESPONSE', 'System One returned invalid JSON');
      }
      if (responseFormat === 'cloudflare') {
        if (typeof payload !== 'object' || payload === null || !('result' in payload)) {
          throw new SystemOneError('INVALID_RESPONSE', 'Cloudflare response is missing result');
        }
        payload = payload.result;
      }
      validateResult(payload, request.questions);
      return payload as DecisionResult<Q>;
    }
    throw new SystemOneError('HTTP_ERROR', 'System One retries exhausted');
  }
}
