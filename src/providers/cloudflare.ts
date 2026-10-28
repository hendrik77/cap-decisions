import { DecisionsService } from '../index';
import { DecisionsError, machineCode } from '../validation';
import type { DecisionsCredentials } from '../types';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Cloudflare reports errors as `{ errors: [{ code }] }`; the first code becomes `providerCode`.
function firstErrorCode(payload: unknown): string | number | undefined {
  if (!record(payload) || !Array.isArray(payload.errors)) return undefined;
  const first: unknown = payload.errors[0];
  return record(first) ? machineCode(first.code) : undefined;
}

/**
 * The provider class of `decisions-cloudflare`. Cloudflare Workers AI wraps the Jev answer in
 * `{ success, errors, result }`; this class builds the account URL, unwraps `result` and reads `errors[0].code`.
 */
export default class CloudflareService extends DecisionsService {
  protected override endpoint(credentials: DecisionsCredentials): string | undefined {
    if (credentials.url) return credentials.url;
    if (credentials.accountId) {
      return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/@cf/cloudflare/clef`;
    }
    throw new DecisionsError('INVALID_CONFIG', 'Cloudflare requires accountId');
  }

  protected override unwrap(payload: unknown): unknown {
    if (!record(payload)) throw new DecisionsError('INVALID_RESPONSE', 'Cloudflare response is invalid');
    if (payload.success !== true) {
      throw new DecisionsError('PROVIDER_ERROR', 'Cloudflare reported a failed request', {
        providerCode: firstErrorCode(payload),
      });
    }
    if (payload.result === undefined || payload.result === null)
      throw new DecisionsError('INVALID_RESPONSE', 'Cloudflare response is missing result');
    return payload.result;
  }

  protected override errorCode(payload: unknown): string | number | undefined {
    return firstErrorCode(payload);
  }
}

export { CloudflareService };
