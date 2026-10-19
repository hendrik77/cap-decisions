const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

test('installed package registers an internal CAP service with decide()', async () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-integration-'));
  const fixture = path.join(temp, 'cap-app');
  fs.cpSync(path.join(root, 'examples/cap-app'), fixture, { recursive: true });
  const server = http.createServer((_req, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      model: 'laya',
      answers: { answer: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 3, output_tokens: 1 }
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json')));
    pkg.cds.requires['system-one'].credentials.url = `http://127.0.0.1:${server.address().port}/v1/systemone`;
    pkg.dependencies['@sap/cds'] = `file:${path.join(root, 'node_modules/@sap/cds')}`;
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    const tarball = path.join(temp, pack.stdout.trim().split('\n').at(-1));
    pkg.dependencies['cap-jev'] = `file:${tarball}`;
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    const install = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    const script = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        const service = await cds.connect.to('system-one');
        if (!(service instanceof cds.Service)) throw new Error('Not a CAP Service');
        const result = await service.decide({ state: 'refund', questions: { answer: { type: 'noul', instructions: 'Refund?' } } });
        if (result.answers.answer.noul !== 0.8) throw new Error('Wrong result');
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    const run = await execFileAsync(process.execPath, ['-e', script], { cwd: fixture, encoding: 'utf8' });
    assert.match(run.stdout, /ok/);
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
