import cds from '@sap/cds';
import type { SystemOneService } from 'cap-jev';

export default class DecisionService extends cds.ApplicationService {
  async init(): Promise<void> {
    this.on('classify', async request => {
      const systemOne = await cds.connect.to('system-one') as SystemOneService;
      const result = await systemOne.decide({
        state: request.data.message as string,
        questions: {
          department: {
            type: 'choice',
            instructions: 'Which team should handle this message?',
            criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' }
          }
        }
      });
      return result.answers.department.choice;
    });
    await super.init();
  }
}
