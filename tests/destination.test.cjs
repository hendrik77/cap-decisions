const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SystemOneTransport } = require('../dist/transport');

const request = { state: 'x', questions: { answer: { type: 'noul', instructions: 'Yes?' } } };
const result = {
  model: 'test',
  answers: { answer: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};

test('destination supplies URL and URL.headers.Authorization without local caching', async () => {
  const original = globalThis.fetch;
  const seen = [];
  let resolutions = 0;
  const resolver = async (name) => {
    assert.equal(name, 'test-destination');
    resolutions++;
    return { url: `https://example.com/${resolutions}`, headers: { Authorization: 'Bearer destination-token' } };
  };
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), authorization: options.headers.authorization });
    return new globalThis.Response(JSON.stringify(result));
  };
  try {
    const settings = {
      modelId: 'jev-latest',
      requiresToken: true,
      timeoutMs: 1000,
      credentials: { destination: 'test-destination' },
    };
    const transport = new SystemOneTransport(settings, { destinationResolver: resolver });
    delete settings.credentials.destination;
    settings.credentials.token = 'changed-token';
    await transport.validateDestination();
    assert.deepEqual(await transport.post(request), { payload: result, attempts: 1 });
    assert.deepEqual((await transport.post(request)).payload, result);
    assert.equal(resolutions, 3);
    assert.deepEqual(seen, [
      { url: 'https://example.com/2', authorization: 'Bearer destination-token' },
      { url: 'https://example.com/3', authorization: 'Bearer destination-token' },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('missing optional SDK reports an install hint', async () => {
  const transport = new SystemOneTransport({ timeoutMs: 1000, credentials: { destination: 'test-destination' } });
  await assert.rejects(
    transport.validateDestination(),
    (error) => error.code === 'INVALID_CONFIG' && error.message.includes('Install @sap-cloud-sdk/connectivity'),
  );
});

test('destination token cannot be sent to non-loopback HTTP', async () => {
  const transport = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'test-destination' } },
    {
      destinationResolver: async () => ({
        url: 'http://example.com/post',
        headers: { Authorization: 'Bearer secret' },
      }),
    },
  );
  await assert.rejects(transport.validateDestination(), (error) => error.code === 'INVALID_CONFIG');
});

test('destination resolution and caller cancellation obey the call deadline', async () => {
  const resolver = async () =>
    new Promise((resolve) => globalThis.setTimeout(() => resolve({ url: 'https://example.com/post' }), 100));
  const transport = new SystemOneTransport(
    { timeoutMs: 20, credentials: { destination: 'slow' } },
    { destinationResolver: resolver },
  );
  await assert.rejects(transport.post(request), (error) => error.code === 'TIMEOUT');
  const controller = new globalThis.AbortController();
  const cancelled = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'slow' } },
    { destinationResolver: resolver },
  ).post(request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error) => error.code === 'ABORTED');
});

test('requiresToken is satisfied by a destination Authorization header', async () => {
  const settings = { timeoutMs: 1000, requiresToken: true, credentials: { destination: 'with-auth' } };
  const transport = new SystemOneTransport(settings, {
    destinationResolver: async () => ({ url: 'https://example.com/post', headers: { Authorization: 'Bearer d' } }),
  });
  await assert.doesNotReject(transport.validateDestination());
});

test('requiresToken fails with INVALID_CONFIG when the destination has no Authorization header', async () => {
  const settings = { timeoutMs: 1000, requiresToken: true, credentials: { destination: 'no-auth' } };
  for (const headers of [undefined, {}, { 'X-Other': 'x' }]) {
    const transport = new SystemOneTransport(settings, {
      destinationResolver: async () => ({ url: 'https://example.com/post', headers }),
    });
    await assert.rejects(
      transport.validateDestination(),
      (error) => error.code === 'INVALID_CONFIG' && /requires a token/.test(error.message),
    );
  }
});

test('requiresToken is satisfied by a configured token together with a destination', async () => {
  const settings = { timeoutMs: 1000, requiresToken: true, credentials: { destination: 'd', token: 't' } };
  const transport = new SystemOneTransport(settings, {
    destinationResolver: async () => ({ url: 'https://example.com/post' }),
  });
  await assert.doesNotReject(transport.validateDestination());
});

test('without requiresToken a destination needs no Authorization header', async () => {
  const transport = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'open' } },
    { destinationResolver: async () => ({ url: 'https://example.com/post' }) },
  );
  await assert.doesNotReject(transport.validateDestination());
});

test('destination resolution failures and missing destinations are INVALID_CONFIG', async () => {
  const failing = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'x' } },
    {
      destinationResolver: async () => {
        throw new Error('down');
      },
    },
  );
  await assert.rejects(failing.validateDestination(), (error) => error.code === 'INVALID_CONFIG' && !!error.cause);
  const missing = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'x' } },
    { destinationResolver: async () => null },
  );
  await assert.rejects(missing.validateDestination(), (error) => error.code === 'INVALID_CONFIG');
});

test('the endpoint hook is not used when a destination is configured', async () => {
  const transport = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'x' } },
    {
      hooks: {
        endpoint: () => {
          throw new Error('unexpected endpoint hook');
        },
      },
      destinationResolver: async () => ({ url: 'https://example.com/post' }),
    },
  );
  await assert.doesNotReject(transport.validateDestination());
});

// Makes `require('@sap-cloud-sdk/connectivity')` inside dist/transport.js resolve to a stub module.
function withStubbedSdk(sdkSource, run) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Module = require('node:module');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-sdk-'));
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, `module.exports = ${sdkSource};`);
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (name, ...rest) {
    return name === '@sap-cloud-sdk/connectivity' ? file : resolve.call(this, name, ...rest);
  };
  const cleanup = () => {
    Module._resolveFilename = resolve;
    delete Module._cache[file];
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return run().finally(cleanup);
}

test('the installed Cloud SDK resolves the destination by name', () =>
  withStubbedSdk(
    `{ getDestination: async ({ destinationName }) => ({ url: 'https://example.com/' + destinationName, headers: { Authorization: 'Bearer sdk' } }) }`,
    async () => {
      const original = globalThis.fetch;
      const seen = [];
      globalThis.fetch = async (url, options) => {
        seen.push({ url: String(url), authorization: options.headers.authorization });
        return new globalThis.Response(JSON.stringify(result));
      };
      try {
        const transport = new SystemOneTransport({
          timeoutMs: 1000,
          requiresToken: true,
          credentials: { destination: 'from-sdk' },
        });
        assert.deepEqual((await transport.post(request)).payload, result);
        assert.deepEqual(seen, [{ url: 'https://example.com/from-sdk', authorization: 'Bearer sdk' }]);
      } finally {
        globalThis.fetch = original;
      }
    },
  ));

test('a Cloud SDK without getDestination is INVALID_CONFIG', () =>
  withStubbedSdk(`{}`, async () => {
    const transport = new SystemOneTransport({ timeoutMs: 1000, credentials: { destination: 'x' } });
    await assert.rejects(
      transport.validateDestination(),
      (error) => error.code === 'INVALID_CONFIG' && /does not expose getDestination/.test(error.message),
    );
  }));

test('destination headers must be strings', async () => {
  const transport = new SystemOneTransport(
    { timeoutMs: 1000, credentials: { destination: 'x' } },
    { destinationResolver: async () => ({ url: 'https://example.com/post', headers: { 'X-Count': 3 } }) },
  );
  await assert.rejects(
    transport.validateDestination(),
    (error) => error.code === 'INVALID_CONFIG' && /headers must be strings/.test(error.message),
  );
});

describe('destination at connect', () => {
  const { startServer, noulRequest } = require('./helpers/fake-server.cjs');
  const { createApp, runInApp, removeApp } = require('./helpers/app.cjs');

  const inApp = async (sdkSource, script) => {
    const server = await startServer();
    const dir = createApp(
      {
        name: 'destination-app',
        cds: { requires: { systemone: { kind: 'systemone-generic', credentials: { destination: 'jev' } } } },
      },
      {
        'sdk.js': sdkSource(server.url),
        // dist/transport.js resolves the SDK from the repository, so a preload file points it at sdk.js.
        'preload.js': `const Module = require('node:module');
          const resolve = Module._resolveFilename;
          Module._resolveFilename = function (name, ...rest) {
            return name === '@sap-cloud-sdk/connectivity' ? require('node:path').resolve('sdk.js') : resolve.call(this, name, ...rest);
          };`,
      },
    );
    try {
      return await runInApp(
        dir,
        `const cds = require('@sap/cds');
         const out = (value) => console.log(JSON.stringify(value));
         (async () => {
           const warnings = [];
           cds.log('systemone').warn = (...args) => warnings.push(args.join(' '));
           try {
             ${script}
           } catch (error) {
             out({ error: error.code, message: error.message, warnings });
           }
         })();`,
        { env: { CDS_ENV: 'production', NODE_OPTIONS: '--require ./preload.js' } },
      );
    } finally {
      removeApp(dir);
      server.close();
    }
  };

  test('a resolver that throws at start-up logs a warning and the first call resolves again', async () => {
    const result = await inApp(
      (url) => `let calls = 0;
        exports.getDestination = async () => {
          if (calls++ === 0) throw new Error('destination service down');
          return { url: ${JSON.stringify(url)} };
        };`,
      `const srv = await cds.connect.to('systemone');
       const decision = await srv.decide(${JSON.stringify(noulRequest)});
       out({ model: decision.model, warnings });`,
    );
    assert.equal(result.model, 'fake-model');
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      /Could not resolve destination jev at start-up; it is resolved again for each call/,
    );
    assert.doesNotMatch(result.warnings[0], /destination service down/);
  });

  test('a destination that is not found still fails the connect', async () => {
    const result = await inApp(
      () => `exports.getDestination = async () => null;`,
      `await cds.connect.to('systemone'); out({ ok: true });`,
    );
    assert.equal(result.error, 'INVALID_CONFIG');
    assert.match(result.message, /Destination was not found/);
  });
});
