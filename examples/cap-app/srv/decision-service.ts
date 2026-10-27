import cds from '@sap/cds';
import { DecisionsError, type Answers, type Questions, type DecisionsErrorCode, type DecisionsService } from 'cap-jev';

const questions = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this message?',
    criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
  },
} satisfies Questions;

type Department = Answers<typeof questions>['department']['choice'];

// TypeScript reports a missing or misspelled team when the criteria change.
const queues = {
  billing: 'accounts',
  technical: 'support',
} satisfies Record<Department, string>;

// Other decision failures, such as provider or network errors, become 502 Bad Gateway.
const statuses: Partial<Record<DecisionsErrorCode, number>> = {
  INVALID_REQUEST: 400,
  TIMEOUT: 504,
  ABORTED: 503,
};

export default class DecisionService extends cds.ApplicationService {
  async init(): Promise<void> {
    const decisions = (await cds.connect.to('systemone')) as DecisionsService;
    this.on('classify', async (request) => {
      const message: unknown = request.data.message;
      if (typeof message !== 'string' || !message.trim()) return request.reject(400, 'Message is required');
      try {
        const result = await decisions.decide({ state: message, questions });
        return queues[result.answers.department.choice];
      } catch (error) {
        if (!(error instanceof DecisionsError)) throw error;
        return request.reject(statuses[error.code] ?? 502, `Classification failed: ${error.code}`);
      }
    });
    await super.init();
  }
}
