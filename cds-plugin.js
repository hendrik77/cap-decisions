// CAP discovers the package configuration through this file.
// The required service is instantiated only when cds.connect.to('decisions') is called.
const cds = require('@sap/cds');

// CAP fails with MODEL_NOT_FOUND before the service is created, so this is the only place to explain the setting.
// This file runs for every cds command and must never throw.
if (cds.env.requires?.decisions?.model !== undefined) {
  cds
    .log('decisions')
    .error(
      'cds.requires.decisions.model is not supported: CAP reads model as the CDS model of a service. Use modelId for the decision model.',
    );
}

// The package was cap-jev with the service systemone before 0.10.0; an old configuration would otherwise be ignored.
if (cds.env.requires?.systemone !== undefined) {
  cds
    .log('decisions')
    .error(
      'cds.requires.systemone is no longer read: the service was renamed to decisions in 0.10.0, and its kinds from systemone-<x> to decisions-<x>. See the 0.10.0 entry of the CHANGELOG of cap-decisions for the new names.',
    );
}

// `cds add decisions` exists only while @sap/cds-dk runs `cds add`, or `cds add --help`, which runs as `help`.
// The command is checked first, so that other commands never touch the lazy cds.add of @sap/cds-dk, and the
// facet code is loaded only when needed.
if (cds.cli?.command === 'add' || cds.cli?.command === 'help') {
  try {
    if (typeof cds.add?.register === 'function') cds.add.register('decisions', require('./dist/add.js'));
  } catch (error) {
    cds.log('decisions').error(`The cds add decisions facet could not be registered: ${error?.message ?? error}`);
  }
}
