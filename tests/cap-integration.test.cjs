const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

test('installed package registers an internal CAP service with decide()', { timeout: 300_000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-integration-'));
  const fixture = path.join(temp, 'cap-app');
  fs.cpSync(path.join(root, 'examples/cap-app'), fixture, { recursive: true });
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    received.push(payload);
    if (payload.state === 'slow') await new Promise((resolve) => setTimeout(resolve, 200));
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        model: 'laya',
        answers: { answer: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json')));
    pkg.cds.requires['systemone'].credentials = { url: `http://127.0.0.1:${server.address().port}/v1/systemone` };
    pkg.dependencies['@sap/cds'] = `file:${path.join(root, 'node_modules/@sap/cds')}`;
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temp], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(pack.status, 0, pack.error?.message ?? pack.stderr);
    const tarball = path.join(temp, pack.stdout.trim().split('\n').at(-1));
    pkg.dependencies['cap-jev'] = `file:${tarball}`;
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
    const install = spawnSync('npm', ['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(install.status, 0, install.error?.message ?? install.stderr);
    const script = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        const service = await cds.connect.to('systemone');
        if (!(service instanceof cds.Service)) throw new Error('Not a CAP Service');
        const logs = [];
        cds.log('systemone').debug = (...args) => logs.push(args);
        service.before('decide', request => { if (request.data.state === 'original private state') request.data.state = 'modified private state'; });
        const result = await service.decide({ state: 'original private state', questions: { answer: { type: 'noul', instructions: 'Refund?' } } });
        if (result.answers.answer.noul !== 0.8) throw new Error('Wrong result');
        if (logs.length !== 1 || logs[0][1].attempts !== 1 || logs[0][1].usage.input_tokens !== 3) throw new Error('Missing safe debug log');
        if (JSON.stringify(logs).includes('private state') || JSON.stringify(logs).includes('Refund?')) throw new Error('Request leaked to log');
        const controller = new AbortController();
        const cancelled = service.decide({ state: 'slow', questions: { answer: { type: 'noul', instructions: 'Refund?' } } }, { signal: controller.signal });
        setTimeout(() => controller.abort(), 10);
        try { await cancelled; throw new Error('Expected cancellation'); }
        catch (error) { if (error.code !== 'ABORTED') throw error; }
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    const run = await execFileAsync(process.execPath, ['-e', script], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.match(run.stdout, /ok/);
    assert.equal(received[0].state, 'modified private state');
    const replacement = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        class Fake extends require('cap-jev').SystemOneService {
          async init() { this.on('decide', () => ({ model: 'fake', answers: { answer: { type: 'noul', noul: 0.25 } }, usage: { input_tokens: 0, output_tokens: 0 } })); await cds.Service.prototype.init.call(this); }
        }
        cds.requires.systemone.impl = Fake;
        const service = await cds.connect.to('systemone');
        const result = await service.decide({ state: 'test', questions: { answer: { type: 'noul', instructions: 'Refund?' } } });
        if (result.answers.answer.noul !== 0.25) throw new Error('Replacement impl was not used');
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    assert.match(
      (await execFileAsync(process.execPath, ['-e', replacement], { cwd: fixture, encoding: 'utf8', timeout: 30_000 }))
        .stdout,
      /ok/,
    );
    const invalid = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        cds.requires.systemone.credentials = { url: 'invalid' };
        try { await cds.connect.to('systemone'); throw new Error('Expected invalid config'); }
        catch (error) { if (error.code !== 'INVALID_CONFIG') throw error; }
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    assert.match(
      (await execFileAsync(process.execPath, ['-e', invalid], { cwd: fixture, encoding: 'utf8', timeout: 30_000 }))
        .stdout,
      /ok/,
    );
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
