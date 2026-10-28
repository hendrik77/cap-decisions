const cds = require('@sap/cds');
const { DecisionsService, DecisionsError } = require('cap-decisions');

// Acme wraps the Jev answer in { data: <result> } and addresses its API by region.
class AcmeService extends DecisionsService {
  static credentialKeys = ['region'];

  async init() {
    cds.log('decisions').debug('initializing the Acme provider');
    await super.init();
  }

  endpoint(credentials) {
    if (credentials.url) return credentials.url;
    if (credentials.region) return `https://${encodeURIComponent(credentials.region)}.acme.example/v1/jev`;
    throw new DecisionsError('INVALID_CONFIG', 'Acme requires region');
  }

  unwrap(payload) {
    if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
      throw new DecisionsError('INVALID_RESPONSE', 'Acme response is missing data');
    }
    return payload.data;
  }
}

module.exports = AcmeService;
