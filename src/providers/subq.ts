import { DecisionsService } from '../index';
import { machineCode } from '../validation';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The provider class of `decisions-subq`. SubQ answers errors as `{ detail: { error_type, message } }`; this class
 * reads `error_type` as `providerCode`. The message is never exposed.
 * @experimental While SubQ's model is in preview.
 */
export default class SubqService extends DecisionsService {
  protected override errorCode(payload: unknown): string | number | undefined {
    return record(payload) && record(payload.detail) ? machineCode(payload.detail.error_type) : undefined;
  }
}

export { SubqService };
