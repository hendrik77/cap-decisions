import cds from '@sap/cds';
import { SystemOneTransport } from './transport';
import type { DecisionRequest, DecisionResult, Questions, SystemOneCredentials } from './types';

export class SystemOneService extends cds.Service {
  async decide<Q extends Questions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    const credentials = ((this as cds.Service & { options?: { credentials?: SystemOneCredentials } }).options?.credentials ?? {});
    return new SystemOneTransport(credentials).decide(request);
  }
}

export { SystemOneTransport } from './transport';
export { SystemOneError } from './validation';
export type {
  JsonValue, Content, NoulQuestion, ChoiceQuestion, ScoreQuestion, Question, Questions,
  NoulAnswer, ChoiceAnswer, ScoreAnswer, Answer, Answers, DecisionRequest, DecisionResult,
  SystemOneCredentials
} from './types';

export default SystemOneService;

// CAP's CommonJS service loader expects the class itself from require('cap-jev').
module.exports = Object.assign(SystemOneService, module.exports);
