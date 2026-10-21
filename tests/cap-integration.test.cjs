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
  fs.cpSync(path.join(root, 'examples/cap-app'), fixture, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    received.push(payload);
    if (payload.state === 'slow') await new Promise((resolve) => setTimeout(resolve, 200));
    response.setHeader('content-type', 'application/json');
    if (payload.state === 'provider failure') {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: { code: 'bad_request' } }));
      return;
    }
    if (payload.questions.department) {
      response.end(
        JSON.stringify({
          model: 'laya',
          answers: {
            department: {
              type: 'choice',
              choice: 'technical',
              probabilities: { billing: 0.2, technical: 0.8 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      );
      return;
    }
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
    const bin = spawnSync(path.join(fixture, 'node_modules', '.bin', 'cap-jev-mock'), ['--version'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(bin.status, 0, bin.error?.message ?? bin.stderr);
    assert.equal(bin.stdout.trim(), require('../package.json').version);
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
    // The example selects systemone-laya only in production; development uses the mock provider.
    const production = { ...process.env, CDS_ENV: 'production' };
    const run = await execFileAsync(process.execPath, ['-e', script], {
      cwd: fixture,
      encoding: 'utf8',
      env: production,
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
      (
        await execFileAsync(process.execPath, ['-e', replacement], {
          cwd: fixture,
          encoding: 'utf8',
          env: production,
          timeout: 30_000,
        })
      ).stdout,
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
      (
        await execFileAsync(process.execPath, ['-e', invalid], {
          cwd: fixture,
          encoding: 'utf8',
          env: production,
          timeout: 30_000,
        })
      ).stdout,
      /ok/,
    );
    const example = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        cds.model = cds.linked(await cds.load('*'));
        const service = await cds.serve('DecisionService').from(cds.model);
        if (service.constructor.name !== 'DecisionService') throw new Error('Example handler was not loaded');
        const classify = (message) => service.tx({ user: new cds.User({ id: 'alice' }) }, (tx) => tx.send('classify', { message }));
        const queue = await classify('The API returns errors');
        if (queue !== 'support') throw new Error('Wrong queue: ' + queue);
        for (const [message, status] of [[' ', 400], ['provider failure', 502]]) {
          try { await classify(message); throw new Error('Expected rejection'); }
          catch (error) { if (error.code !== status) throw error; }
        }
        try { await service.send('classify', { message: 'The API returns errors' }); throw new Error('Expected anonymous rejection'); }
        catch (error) { if (error.code !== 401) throw error; }
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    assert.match(
      (
        await execFileAsync(process.execPath, ['-e', example], {
          cwd: fixture,
          encoding: 'utf8',
          env: { ...production, CDS_TYPESCRIPT: 'true' },
          timeout: 30_000,
        })
      ).stdout,
      /ok/,
    );
    // Without CDS_ENV the example runs in development and answers from the mock and its fixture rule.
    const development = { ...process.env, CDS_TYPESCRIPT: 'true' };
    delete development.CDS_ENV;
    delete development.NODE_ENV;
    const mocked = `
      const cds = require('@sap/cds');
      (async () => {
        await cds.plugins;
        cds.model = cds.linked(await cds.load('*'));
        const service = await cds.serve('DecisionService').from(cds.model);
        const queue = await service.tx({ user: new cds.User({ id: 'alice' }) }, (tx) => tx.send('classify', { message: 'I want a refund' }));
        if (queue !== 'accounts') throw new Error('Wrong queue: ' + queue);
        process.stdout.write('ok');
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `;
    const requestsBefore = received.length;
    assert.match(
      (
        await execFileAsync(process.execPath, ['-e', mocked], {
          cwd: fixture,
          encoding: 'utf8',
          env: development,
          timeout: 30_000,
        })
      ).stdout,
      /ok/,
    );
    assert.equal(received.length, requestsBefore, 'the mock must not call the fake server');
    // The facet is part of the archive and runs from the installed package.
    assert.ok(fs.existsSync(path.join(fixture, 'node_modules/cap-jev/dist/add.js')), 'dist/add.js is installed');
    assert.ok(fs.existsSync(path.join(fixture, 'node_modules/cap-jev/dist/add-core.js')), 'add-core.js is installed');
    const cdsBin = path.join(path.dirname(require.resolve('@sap/cds-dk/package.json')), 'bin/cds.js');
    const add = (...args) =>
      execFileAsync(process.execPath, [cdsBin, 'add', 'systemone', ...args], {
        cwd: fixture,
        encoding: 'utf8',
        env: development,
        timeout: 60_000,
      });
    const projectFile = (name) => path.join(fixture, name);
    const before = fs.readFileSync(projectFile('package.json'), 'utf8');
    const kept = await add('--kind', 'systemone-typesafe');
    assert.match(kept.stdout, /\[systemone\].*systemone-laya.*--force/);
    assert.equal(fs.readFileSync(projectFile('package.json'), 'utf8'), before);
    assert.equal(fs.existsSync(projectFile('.cdsrc-private.json')), false);
    const forced = await add('--kind', 'systemone-typesafe', '--force');
    assert.match(forced.stdout, /\[systemone\].*Replaced the kind systemone-laya/);
    const configured = JSON.parse(fs.readFileSync(projectFile('package.json'), 'utf8'));
    assert.equal(configured.cds.requires.systemone['[production]'].kind, 'systemone-typesafe');
    assert.deepEqual(JSON.parse(fs.readFileSync(projectFile('.cdsrc-private.json'), 'utf8')), {
      requires: { systemone: { '[production]': { credentials: { token: '' } } } },
    });
    assert.match(fs.readFileSync(projectFile('.gitignore'), 'utf8'), /^\.cdsrc-private\.json$/m);
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
