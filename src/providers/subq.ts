import { SystemOneService } from '../index';
import { machineCode } from '../validation';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// SubQ answers errors as { detail: { error_type, message } }. The message is never exposed.
export default class SubqService extends SystemOneService {
  protected override errorCode(payload: unknown): string | number | undefined {
    return record(payload) && record(payload.detail) ? machineCode(payload.detail.error_type) : undefined;
  }
}

export { SubqService };
