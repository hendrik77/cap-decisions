// Runs the checks that every kind must pass, from cap-jev's test kit (experimental). Acme wraps the Jev answer in
// { data: <result> }; the kit sends its answers in that format and expects them to come back typed.
const path = require('node:path');
const { testProviderKind } = require('cap-jev/testing');

testProviderKind({
  kind: 'systemone-acme',
  // The provider package: the directory above this test. Without the option the kit uses process.cwd().
  packageDir: path.resolve(__dirname, '..'),
  // Credentials of the provider that the kit does not know; the subclass lists them in credentialKeys.
  credentials: { region: 'eu' },
  encode: (response) => ({ data: response }),
});
