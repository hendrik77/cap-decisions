// CAP discovers the package configuration through this file.
// The required service is instantiated only when cds.connect.to('systemone') is called.
const cds = require('@sap/cds');

// CAP fails with MODEL_NOT_FOUND before the service is created, so this is the only place to explain the setting.
// This file runs for every cds command and must never throw.
if (cds.env.requires?.systemone?.model !== undefined) {
  cds
    .log('systemone')
    .error(
      'cds.requires.systemone.model is not supported: CAP reads model as the CDS model of a service. Use modelId for the System One model.',
    );
}
