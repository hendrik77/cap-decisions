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

// `cds add systemone` exists only while @sap/cds-dk runs `cds add`, or `cds add --help`, which runs as `help`.
// The command is checked first, so that other commands never touch the lazy cds.add of @sap/cds-dk, and the
// facet code is loaded only when needed.
if (cds.cli?.command === 'add' || cds.cli?.command === 'help') {
  try {
    if (typeof cds.add?.register === 'function') cds.add.register('systemone', require('./dist/add.js'));
  } catch (error) {
    cds.log('systemone').error(`The cds add systemone facet could not be registered: ${error?.message ?? error}`);
  }
}
