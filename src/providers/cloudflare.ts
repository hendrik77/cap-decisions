import { SystemOneService } from '../index';
import { SystemOneError, machineCode } from '../validation';
import type { SystemOneCredentials } from '../types';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function firstErrorCode(payload: unknown): string | number | undefined {
  if (!record(payload) || !Array.isArray(payload.errors)) return undefined;
  const first: unknown = payload.errors[0];
  return record(first) ? machineCode(first.code) : undefined;
}

/**
 * The provider class of `systemone-cloudflare`. Cloudflare Workers AI wraps the Jev answer in
 * `{ success, errors, result }`; this class builds the account URL, unwraps `result` and reads `errors[0].code`.
 */
export default class CloudflareService extends SystemOneService {
  protected override endpoint(credentials: SystemOneCredentials): string | undefined {
    if (credentials.url) return credentials.url;
    if (credentials.accountId) {
      return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/run/@cf/cloudflare/clef`;
    }
    throw new SystemOneError('INVALID_CONFIG', 'Cloudflare requires accountId');
  }

  protected override unwrap(payload: unknown): unknown {
    if (!record(payload)) throw new SystemOneError('INVALID_RESPONSE', 'Cloudflare response is invalid');
    if (payload.success !== true) {
      throw new SystemOneError('PROVIDER_ERROR', 'Cloudflare reported a failed request', {
        providerCode: firstErrorCode(payload),
      });
    }
    if (payload.result === undefined || payload.result === null)
      throw new SystemOneError('INVALID_RESPONSE', 'Cloudflare response is missing result');
    return payload.result;
  }

  protected override errorCode(payload: unknown): string | number | undefined {
    return firstErrorCode(payload);
  }
}

export { CloudflareService };
