const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planSystemOne, resolveKind, exampleFixtures } = require('../dist/add-core');
const { parseFixtures } = require('../dist/providers/mock-fixtures');
const { mockDecision } = require('../dist/providers/mock-core');
const { SystemOneError } = require('../dist/validation');

const realKinds = require('../package.json').cds.requires.kinds;
const PKG = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'cap-jev': '^0.8.0' } }, null, 2) + '\n';

const plan = (input = {}, options = {}) =>
  planSystemOne({ packageJsonText: PKG, fixturesExist: false, kinds: realKinds, ...input, options });
const writeOf = (result, file) => result.writes.find((write) => write.file === file);
const jsonOf = (result, file) => JSON.parse(writeOf(result, file).content);
const files = (result) => result.writes.map((write) => write.file).sort();

/** The inputs after the writes of a plan, for the idempotency checks. */
function apply(input, result) {
  const next = { ...input };
  for (const { file, content } of result.writes) {
    if (file === 'package.json') next.packageJsonText = content;
    else if (file === '.cdsrc-private.json') next.cdsrcPrivateText = content;
    else if (file === '.gitignore') next.gitignore = content;
    else if (file === 'test/data/systemone.json') next.fixturesExist = true;
  }
  return next;
}

describe('planSystemOne: options and package.json', () => {
  test('writes systemone-laya into the production profile by default', () => {
    const result = plan();
    assert.deepEqual(files(result), ['package.json']);
    const pkg = jsonOf(result, 'package.json');
    assert.deepEqual(pkg.cds, { requires: { systemone: { '[production]': { kind: 'systemone-laya' } } } });
    assert.equal(pkg.name, 'app');
    assert.ok(writeOf(result, 'package.json').content.endsWith('}\n'));
  });

  test('keeps other keys and their order, and adds only what is missing', () => {
    const text = JSON.stringify(
      {
        name: 'app',
        cds: { requires: { db: { kind: 'sqlite' }, systemone: { strategy: 'seeded' } }, odata: { version: 'v4' } },
        scripts: { start: 'cds-serve' },
      },
      null,
      2,
    );
    const result = plan({ packageJsonText: text });
    const pkg = jsonOf(result, 'package.json');
    assert.deepEqual(Object.keys(pkg), ['name', 'cds', 'scripts']);
    assert.deepEqual(Object.keys(pkg.cds), ['requires', 'odata']);
    assert.deepEqual(Object.keys(pkg.cds.requires), ['db', 'systemone']);
    assert.deepEqual(pkg.cds.requires.systemone, { strategy: 'seeded', '[production]': { kind: 'systemone-laya' } });
    assert.deepEqual(pkg.cds.requires.db, { kind: 'sqlite' });
  });

  test('--kind selects the kind', () => {
    const pkg = jsonOf(plan({}, { kind: 'systemone-cloudflare' }), 'package.json');
    assert.equal(pkg.cds.requires.systemone['[production]'].kind, 'systemone-cloudflare');
  });

  test('--for selects the profile', () => {
    const result = plan({}, { kind: 'systemone-typesafe', for: 'hybrid' });
    const pkg = jsonOf(result, 'package.json');
    assert.deepEqual(pkg.cds.requires.systemone, { '[hybrid]': { kind: 'systemone-typesafe' } });
    const cdsrc = jsonOf(result, '.cdsrc-private.json');
    assert.deepEqual(cdsrc, { requires: { systemone: { '[hybrid]': { credentials: { token: '' } } } } });
    assert.ok(result.messages.some((message) => message.includes('[hybrid]')));
  });

  test('the same kind is already configured and changes nothing', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { '[production]': { kind: 'systemone-laya' } } } } });
    const result = plan({ packageJsonText: text });
    assert.deepEqual(result.writes, []);
    assert.ok(result.messages.some((message) => /already configured/.test(message)));
  });

  test('a different kind is kept and --force is mentioned', () => {
    const text = JSON.stringify({
      cds: { requires: { systemone: { '[production]': { kind: 'systemone-typesafe' } } } },
    });
    const result = plan({ packageJsonText: text }, { kind: 'systemone-laya' });
    assert.deepEqual(result.writes, []);
    const message = result.messages.find((line) => line.includes('--force'));
    assert.ok(message);
    assert.match(message, /systemone-typesafe/);
    assert.match(message, /systemone-laya/);
  });

  test('a different kind that needs a token writes nothing without --force', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { '[production]': { kind: 'systemone-laya' } } } } });
    const result = plan({ packageJsonText: text }, { kind: 'systemone-typesafe' });
    assert.deepEqual(result.writes, []);
  });

  test('--force replaces a different kind', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { '[production]': { kind: 'systemone-laya' } } } } });
    const result = plan({ packageJsonText: text }, { kind: 'systemone-typesafe', force: true });
    const pkg = jsonOf(result, 'package.json');
    assert.equal(pkg.cds.requires.systemone['[production]'].kind, 'systemone-typesafe');
    assert.deepEqual(files(result), ['.cdsrc-private.json', '.gitignore', 'package.json']);
  });

  test('a base-level kind is never changed, and the profile kind is still written', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { kind: 'systemone-laya' } } } });
    const result = plan({ packageJsonText: text });
    const systemone = jsonOf(result, 'package.json').cds.requires.systemone;
    assert.equal(systemone.kind, 'systemone-laya');
    assert.equal(systemone['[production]'].kind, 'systemone-laya');
    const message = result.messages.find((line) => /every profile/.test(line));
    assert.ok(message);
    assert.match(message, /mock/);
    assert.match(message, /development/);
    assert.match(message, /test/);
    assert.match(message, /\[production\]/);
  });

  test('a base-level kind is not changed with --force either', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { kind: 'systemone-cloudflare' } } } });
    const systemone = jsonOf(plan({ packageJsonText: text }, { force: true }), 'package.json').cds.requires.systemone;
    assert.equal(systemone.kind, 'systemone-cloudflare');
  });

  test('a base-level kind with the profile kind already set only prints messages', () => {
    const text = JSON.stringify({
      cds: { requires: { systemone: { kind: 'systemone-laya', '[production]': { kind: 'systemone-laya' } } } },
    });
    const result = plan({ packageJsonText: text });
    assert.deepEqual(result.writes, []);
    assert.ok(result.messages.some((line) => /every profile/.test(line)));
    assert.ok(result.messages.some((line) => /already configured/.test(line)));
  });

  test('every message is one line with the prefix', () => {
    const result = plan({}, { kind: 'systemone-generic', withFixtures: true });
    assert.ok(result.messages.length > 0);
    for (const message of result.messages) {
      assert.match(message, /^\[systemone\] \S/);
      assert.ok(!message.includes('\n'));
    }
  });
});

describe('planSystemOne: .cdsrc-private.json', () => {
  test('a kind without requiresToken does not touch the file', () => {
    const result = plan({}, { kind: 'systemone-laya' });
    assert.equal(writeOf(result, '.cdsrc-private.json'), undefined);
    assert.equal(writeOf(result, '.gitignore'), undefined);
  });

  test('creates the file with an empty token for a kind with requiresToken', () => {
    const result = plan({}, { kind: 'systemone-typesafe' });
    assert.deepEqual(jsonOf(result, '.cdsrc-private.json'), {
      requires: { systemone: { '[production]': { credentials: { token: '' } } } },
    });
    assert.ok(writeOf(result, '.cdsrc-private.json').content.endsWith('\n'));
    const next = result.messages.find((line) => /credentials\.token/.test(line) && /\.cdsrc-private\.json/.test(line));
    assert.ok(next);
    assert.match(next, /\[production\]/);
  });

  test('systemone-subq gets the token placeholder and no URL reminder', () => {
    const result = plan({}, { kind: 'systemone-subq' });
    assert.deepEqual(files(result), ['.cdsrc-private.json', '.gitignore', 'package.json']);
    assert.equal(jsonOf(result, '.cdsrc-private.json').requires.systemone['[production]'].credentials.token, '');
    assert.ok(!result.messages.some((line) => line.includes('credentials.url')));
  });

  test('adds the token to an existing file and keeps its other keys', () => {
    const existing = JSON.stringify({ requires: { db: { credentials: { url: 'x' } } } }, null, 4) + '\n';
    const result = plan({ cdsrcPrivateText: existing }, { kind: 'systemone-typesafe' });
    const cdsrc = jsonOf(result, '.cdsrc-private.json');
    assert.deepEqual(cdsrc.requires.db, { credentials: { url: 'x' } });
    assert.equal(cdsrc.requires.systemone['[production]'].credentials.token, '');
    assert.ok(writeOf(result, '.cdsrc-private.json').content.includes('\n    "requires"'));
  });

  test('keeps existing credentials of the profile, only adding the token', () => {
    const existing = JSON.stringify({
      requires: { systemone: { '[production]': { credentials: { url: 'https://x.example' } } } },
    });
    const cdsrc = jsonOf(plan({ cdsrcPrivateText: existing }, { kind: 'systemone-typesafe' }), '.cdsrc-private.json');
    assert.deepEqual(cdsrc.requires.systemone['[production]'].credentials, { url: 'https://x.example', token: '' });
  });

  test('never replaces an existing token, also with --force', () => {
    const existing = JSON.stringify({
      requires: { systemone: { '[production]': { credentials: { token: 'secret' } } } },
    });
    for (const force of [false, true]) {
      const result = plan({ cdsrcPrivateText: existing }, { kind: 'systemone-typesafe', force });
      assert.equal(writeOf(result, '.cdsrc-private.json'), undefined);
      assert.ok(!result.messages.some((line) => line.includes('secret')));
    }
  });

  test('an existing empty token is kept and still reminds', () => {
    const existing = JSON.stringify({ requires: { systemone: { '[production]': { credentials: { token: '' } } } } });
    const result = plan({ cdsrcPrivateText: existing }, { kind: 'systemone-typesafe', force: true });
    assert.equal(writeOf(result, '.cdsrc-private.json'), undefined);
    assert.ok(result.messages.some((line) => /credentials\.token/.test(line)));
  });

  test('a token in another profile does not count', () => {
    const existing = JSON.stringify({ requires: { systemone: { '[hybrid]': { credentials: { token: 'secret' } } } } });
    const cdsrc = jsonOf(plan({ cdsrcPrivateText: existing }, { kind: 'systemone-typesafe' }), '.cdsrc-private.json');
    assert.equal(cdsrc.requires.systemone['[hybrid]'].credentials.token, 'secret');
    assert.equal(cdsrc.requires.systemone['[production]'].credentials.token, '');
  });

  test('a kept different kind does not add a token placeholder', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { '[production]': { kind: 'systemone-laya' } } } } });
    const result = plan({ packageJsonText: text }, { kind: 'systemone-typesafe' });
    assert.equal(writeOf(result, '.cdsrc-private.json'), undefined);
  });
});

describe('planSystemOne: .gitignore', () => {
  const typesafe = { kind: 'systemone-typesafe' };

  test('creates the file when it is missing', () => {
    const result = plan({}, typesafe);
    assert.equal(writeOf(result, '.gitignore').content, '.cdsrc-private.json\n');
  });

  test('appends the line and keeps the existing text', () => {
    const result = plan({ gitignore: 'node_modules\ndist\n' }, typesafe);
    assert.equal(writeOf(result, '.gitignore').content, 'node_modules\ndist\n.cdsrc-private.json\n');
  });

  test('adds a newline when the file does not end with one', () => {
    const result = plan({ gitignore: 'node_modules' }, typesafe);
    assert.equal(writeOf(result, '.gitignore').content, 'node_modules\n.cdsrc-private.json\n');
  });

  test('keeps CRLF line endings', () => {
    const result = plan({ gitignore: 'node_modules\r\ndist' }, typesafe);
    assert.equal(writeOf(result, '.gitignore').content, 'node_modules\r\ndist\r\n.cdsrc-private.json\r\n');
  });

  test('an empty file just gets the line', () => {
    assert.equal(writeOf(plan({ gitignore: '' }, typesafe), '.gitignore').content, '.cdsrc-private.json\n');
  });

  test('does nothing when the line is already there, also as /name or with spaces', () => {
    for (const gitignore of [
      '.cdsrc-private.json\n',
      'a\n/.cdsrc-private.json\n',
      'a\r\n  .cdsrc-private.json  \r\n',
    ]) {
      const result = plan({ gitignore }, typesafe);
      assert.equal(writeOf(result, '.gitignore'), undefined, JSON.stringify(gitignore));
    }
  });

  test('a commented-out line does not count', () => {
    const result = plan({ gitignore: '# .cdsrc-private.json\n' }, typesafe);
    assert.equal(writeOf(result, '.gitignore').content, '# .cdsrc-private.json\n.cdsrc-private.json\n');
  });

  test('is also written when the file exists and no token is needed', () => {
    const result = plan({ cdsrcPrivateText: '{}', gitignore: 'dist\n' }, { kind: 'systemone-laya' });
    assert.equal(writeOf(result, '.gitignore').content, 'dist\n.cdsrc-private.json\n');
    assert.equal(writeOf(result, '.cdsrc-private.json'), undefined);
  });

  test('is not written without the private file and without a token', () => {
    assert.equal(writeOf(plan({ gitignore: 'dist\n' }, { kind: 'systemone-laya' }), '.gitignore'), undefined);
  });
});

describe('planSystemOne: fixtures', () => {
  test('--with-fixtures writes the example fixtures', () => {
    const result = plan({}, { withFixtures: true });
    assert.equal(writeOf(result, 'test/data/systemone.json').content, exampleFixtures());
  });

  test('no fixtures without the option', () => {
    assert.equal(writeOf(plan(), 'test/data/systemone.json'), undefined);
  });

  test('an existing fixture file is kept and --force is mentioned', () => {
    const result = plan({ fixturesExist: true }, { withFixtures: true });
    assert.equal(writeOf(result, 'test/data/systemone.json'), undefined);
    const message = result.messages.find((line) => /test\/data\/systemone\.json/.test(line));
    assert.ok(message);
    assert.match(message, /--force/);
  });

  test('--force replaces an existing fixture file', () => {
    const result = plan({ fixturesExist: true }, { withFixtures: true, force: true });
    assert.equal(writeOf(result, 'test/data/systemone.json').content, exampleFixtures());
  });
});

describe('planSystemOne: next steps', () => {
  test('a kind with a local URL gets the mock server hint', () => {
    const result = plan({}, { kind: 'systemone-laya', for: 'staging' });
    const hint = result.messages.find((line) => line.includes('npx cap-jev-mock'));
    assert.ok(hint);
    assert.match(hint, /CDS_ENV=staging/);
  });

  test('a kind with a remote URL gets neither hint nor URL step', () => {
    const result = plan({}, { kind: 'systemone-typesafe' });
    assert.ok(!result.messages.some((line) => line.includes('cap-jev-mock')));
    assert.ok(!result.messages.some((line) => line.includes('credentials.url')));
  });

  test('a kind without a URL asks for credentials.url', () => {
    const result = plan({}, { kind: 'systemone-generic' });
    const step = result.messages.find((line) => line.includes('credentials.url'));
    assert.ok(step);
    assert.match(step, /\[production\]/);
  });

  test('next steps are also printed when the kind is already configured', () => {
    const text = JSON.stringify({
      cds: { requires: { systemone: { '[production]': { kind: 'systemone-generic' } } } },
    });
    const result = plan({ packageJsonText: text }, { kind: 'systemone-generic' });
    assert.deepEqual(result.writes, []);
    assert.ok(result.messages.some((line) => line.includes('credentials.url')));
  });

  for (const [where, systemone] of [
    [
      'in the profile',
      { '[production]': { kind: 'systemone-generic', credentials: { url: 'https://jev.example/v1' } } },
    ],
    [
      'at service level',
      { credentials: { url: 'https://jev.example/v1' }, '[production]': { kind: 'systemone-generic' } },
    ],
  ]) {
    test(`a URL the application sets ${where} needs no reminder`, () => {
      const text = JSON.stringify({ cds: { requires: { systemone } } });
      const result = plan({ packageJsonText: text }, { kind: 'systemone-generic' });
      assert.deepEqual(result.writes, []);
      assert.ok(!result.messages.some((line) => line.includes('credentials.url')));
    });
  }
});

describe('planSystemOne: provider-package kinds', () => {
  const own = { kind: 'systemone-generic', credentials: { url: 'https://x.example/v1' } };

  test('a kind that extends systemone-generic is selectable', () => {
    const kinds = { ...realKinds, 'systemone-acme': own };
    const result = plan({ kinds }, { kind: 'systemone-acme' });
    const pkg = jsonOf(result, 'package.json');
    assert.equal(pkg.cds.requires.systemone['[production]'].kind, 'systemone-acme');
    assert.deepEqual(files(result), ['package.json']);
    assert.ok(!result.messages.some((line) => line.includes('credentials.url')));
    assert.ok(!result.messages.some((line) => line.includes('cap-jev-mock')));
  });

  test('with requiresToken it gets the token placeholder and .gitignore', () => {
    const kinds = { ...realKinds, 'systemone-acme': { ...own, requiresToken: true } };
    const result = plan({ kinds }, { kind: 'systemone-acme' });
    assert.deepEqual(files(result), ['.cdsrc-private.json', '.gitignore', 'package.json']);
    assert.equal(jsonOf(result, '.cdsrc-private.json').requires.systemone['[production]'].credentials.token, '');
  });

  test('a provider kind extending another kind of the same package resolves through the chain', () => {
    const kinds = {
      ...realKinds,
      'systemone-acme': { ...own, requiresToken: true },
      'systemone-acme-eu': { kind: 'systemone-acme', credentials: { url: 'https://eu.x.example/v1' } },
    };
    const result = plan({ kinds }, { kind: 'systemone-acme-eu' });
    assert.ok(writeOf(result, '.cdsrc-private.json'));
  });

  test('a provider kind with a local URL gets the mock server hint', () => {
    const kinds = {
      ...realKinds,
      'systemone-acme': { kind: 'systemone-generic', credentials: { url: 'http://localhost:9/x' } },
    };
    assert.ok(plan({ kinds }, { kind: 'systemone-acme' }).messages.some((line) => line.includes('cap-jev-mock')));
  });
});

describe('planSystemOne: errors', () => {
  const selectable = 'systemone-cloudflare, systemone-generic, systemone-laya, systemone-subq, systemone-typesafe';
  const fails = (input, options, pattern, message) => assert.throws(() => plan(input, options), pattern, message);

  test('an unknown kind lists the selectable kinds', () => {
    fails({}, { kind: 'nope' }, (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unknown kind "nope"/);
      assert.ok(error.message.includes(selectable), error.message);
      return true;
    });
  });

  test('systemone-defaults is refused', () => {
    fails({}, { kind: 'systemone-defaults' }, (error) => {
      assert.match(error.message, /systemone-defaults/);
      assert.ok(error.message.includes(selectable), error.message);
      return true;
    });
  });

  test('the mock is refused, also under another name', () => {
    const kinds = { ...realKinds, 'systemone-mine': { kind: 'systemone-mock' } };
    for (const kind of ['systemone-mock', 'systemone-mine']) {
      fails({ kinds }, { kind }, (error) => {
        assert.match(error.message, new RegExp(kind));
        assert.match(error.message, /mock/);
        assert.ok(error.message.includes(selectable), error.message);
        return true;
      });
    }
  });

  test('a kind that does not reach systemone-defaults is not selectable', () => {
    const kinds = { ...realKinds, rest: { impl: 'rest' }, loop: { kind: 'loop' } };
    for (const kind of ['rest', 'loop']) {
      fails({ kinds }, { kind }, (error) => {
        assert.ok(error.message.includes(selectable), error.message);
        return true;
      });
    }
  });

  test('a non-string kind is an error', () => {
    fails({}, { kind: true }, /selectable kinds/i);
  });

  test('provider kinds appear in the list, and the list is sorted', () => {
    const kinds = {
      'systemone-defaults': realKinds['systemone-defaults'],
      zeta: { kind: 'systemone-defaults' },
      'systemone-alpha': { kind: 'systemone-defaults' },
    };
    fails({ kinds }, { kind: 'x' }, /systemone-alpha, zeta\./);
  });

  test('invalid profile names are refused', () => {
    for (const name of ['', 'a b', 'prod/x', '[production]', 'x"y', true]) {
      fails({}, { for: name }, /profile/, String(name));
    }
    assert.doesNotThrow(() => plan({}, { for: 'my_profile-2' }));
  });

  test('package.json missing', () => {
    fails({ packageJsonText: undefined }, {}, /package\.json/);
  });

  test('invalid JSON names the file', () => {
    fails({ packageJsonText: '{ nope' }, {}, /package\.json/);
    fails({ cdsrcPrivateText: '{ nope' }, { kind: 'systemone-typesafe' }, /\.cdsrc-private\.json/);
    fails({ cdsrcPrivateText: '{ nope' }, { kind: 'systemone-laya' }, /\.cdsrc-private\.json/);
  });

  test('JSON that is not an object is an error', () => {
    fails({ packageJsonText: '[]' }, {}, /package\.json/);
    fails({ cdsrcPrivateText: '[]' }, {}, /\.cdsrc-private\.json/);
  });

  test('cds.requires.systemone that is not an object', () => {
    for (const value of ['systemone-laya', 5, null, ['a']]) {
      const text = JSON.stringify({ cds: { requires: { systemone: value } } });
      fails({ packageJsonText: text }, {}, /cds\.requires\.systemone/, JSON.stringify(value));
    }
  });

  test('a profile section that is not an object', () => {
    const text = JSON.stringify({ cds: { requires: { systemone: { '[production]': 'x' } } } });
    fails({ packageJsonText: text }, {}, /\[production\]/);
  });

  test('a structure in .cdsrc-private.json that is not an object', () => {
    const text = JSON.stringify({ requires: { systemone: 'x' } });
    fails({ cdsrcPrivateText: text }, { kind: 'systemone-typesafe' }, /\.cdsrc-private\.json/);
  });
});

describe('planSystemOne: indentation', () => {
  const pkgWith = (indent) => JSON.stringify({ name: 'app', cds: { requires: {} } }, null, indent) + '\n';

  for (const [name, indent, unit] of [
    ['2 spaces', 2, '  '],
    ['4 spaces', 4, '    '],
    ['tabs', '\t', '\t'],
  ]) {
    test(`keeps ${name} in package.json and .cdsrc-private.json`, () => {
      const result = plan(
        { packageJsonText: pkgWith(indent), cdsrcPrivateText: JSON.stringify({ requires: {} }, null, indent) },
        { kind: 'systemone-typesafe' },
      );
      assert.ok(writeOf(result, 'package.json').content.includes(`\n${unit}"name"`));
      assert.ok(writeOf(result, 'package.json').content.endsWith('}\n'));
      assert.ok(writeOf(result, '.cdsrc-private.json').content.includes(`\n${unit}"requires"`));
    });
  }

  test('a file without a final newline gets one', () => {
    const result = plan({ packageJsonText: JSON.stringify({ name: 'a' }, null, 2) });
    assert.ok(writeOf(result, 'package.json').content.endsWith('}\n'));
  });

  test('a new .cdsrc-private.json uses 2 spaces', () => {
    const content = writeOf(plan({}, { kind: 'systemone-typesafe' }), '.cdsrc-private.json').content;
    assert.ok(content.startsWith('{\n  "requires": {\n    "systemone"'));
  });

  test('a single-line file falls back to 2 spaces', () => {
    const result = plan({ packageJsonText: '{"name":"a"}' });
    assert.ok(writeOf(result, 'package.json').content.startsWith('{\n  "name"'));
  });
});

describe('planSystemOne: idempotency', () => {
  const cases = [
    {},
    { kind: 'systemone-typesafe' },
    { kind: 'systemone-typesafe', for: 'hybrid', withFixtures: true },
    { kind: 'systemone-generic', withFixtures: true },
    { kind: 'systemone-cloudflare', withFixtures: true },
  ];
  for (const options of cases) {
    test(`a second plan writes nothing: ${JSON.stringify(options)}`, () => {
      const first = { packageJsonText: PKG, fixturesExist: false, kinds: realKinds, options };
      const result = planSystemOne(first);
      assert.ok(result.writes.length > 0);
      const second = planSystemOne(apply(first, result));
      assert.deepEqual(second.writes, []);
    });
  }

  test('also with existing files, a base-level kind and --force', () => {
    const input = {
      packageJsonText: JSON.stringify({ cds: { requires: { systemone: { kind: 'systemone-laya' } } } }, null, '\t'),
      cdsrcPrivateText: '{}',
      gitignore: 'dist',
      fixturesExist: false,
      kinds: realKinds,
      options: { kind: 'systemone-typesafe', force: true },
    };
    const result = planSystemOne(input);
    assert.deepEqual(planSystemOne(apply(input, result)).writes, []);
  });
});

describe('resolveKind', () => {
  test('merges the chain, child wins', () => {
    const resolved = resolveKind(realKinds, 'systemone-typesafe');
    assert.equal(resolved.requiresToken, true);
    assert.equal(resolved.impl, 'cap-jev');
    assert.equal(resolved.timeoutMs, 10000);
    assert.equal(resolved.credentials.url, 'https://api.typesafe.ai/v1/systemone');
    assert.deepEqual(resolved.limits.scoreCriteria, { min: 2, max: 10 });
  });

  test('a child overrides a parent, and plain objects merge recursively', () => {
    const kinds = {
      a: { x: 1, nested: { p: 1, q: 2 }, list: [1, 2] },
      b: { kind: 'a', x: 2, nested: { q: 3 }, list: [3] },
    };
    const resolved = resolveKind(kinds, 'b');
    assert.equal(resolved.x, 2);
    assert.deepEqual(resolved.nested, { p: 1, q: 3 });
    assert.deepEqual(resolved.list, [3]);
  });

  test('does not change its input', () => {
    const before = JSON.stringify(realKinds);
    resolveKind(realKinds, 'systemone-laya').credentials.url = 'changed';
    assert.equal(JSON.stringify(realKinds), before);
  });

  test('follows a provider kind through systemone-generic', () => {
    const kinds = { ...realKinds, own: { kind: 'systemone-generic', credentials: { url: 'https://x.example/v1' } } };
    const resolved = resolveKind(kinds, 'own');
    assert.equal(resolved.impl, 'cap-jev');
    assert.equal(resolved.credentials.url, 'https://x.example/v1');
    assert.equal(resolved.requiresToken, undefined);
  });

  test('the mock resolves to the mock implementation', () => {
    assert.equal(resolveKind(realKinds, 'systemone-mock').impl, 'cap-jev/providers/mock');
  });

  test('a cycle terminates', () => {
    const resolved = resolveKind({ a: { kind: 'b', x: 1 }, b: { kind: 'a', y: 2 } }, 'a');
    assert.equal(resolved.x, 1);
    assert.equal(resolved.y, 2);
  });

  test('an unknown kind gives undefined, a missing parent is skipped', () => {
    assert.equal(resolveKind(realKinds, 'nope'), undefined);
    assert.equal(resolveKind({ a: { kind: 'missing', x: 1 } }, 'a').x, 1);
  });
});

describe('exampleFixtures', () => {
  const rules = () => parseFixtures(JSON.parse(exampleFixtures()), 'example');
  const request = (state) => ({
    state,
    questions: {
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: { billing: 'Payments and refunds', technical: 'Errors and integrations' },
      },
    },
  });
  const decide = (state) => mockDecision(request(state), { strategy: 'keywords', rules: rules(), source: 'example' });

  test('is a JSON array of two rules with a final newline', () => {
    const text = exampleFixtures();
    assert.ok(text.endsWith('\n'));
    assert.equal(JSON.parse(text).length, 2);
  });

  test('the mock parser accepts it, with one answer and one failure', () => {
    const parsed = rules();
    assert.equal(parsed.filter((rule) => rule.answer).length, 1);
    assert.equal(parsed.filter((rule) => rule.fail).length, 1);
  });

  test('the answer rule gives a fixed answer', () => {
    const result = decide('Please refund me, I was billed twice.');
    assert.equal(result.answers.department.choice, 'billing');
  });

  test('the failure rule produces its error', () => {
    assert.throws(
      () => decide('Please simulate outage now'),
      (error) => {
        assert.ok(error instanceof SystemOneError);
        assert.equal(error.code, 'HTTP_ERROR');
        assert.equal(error.status, 503);
        return true;
      },
    );
  });
});

test('the module loads without @sap/cds', () => {
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '../dist/add-core.js'))});
    console.log(Object.keys(require.cache).some((key) => key.includes('@sap/cds') || key.includes('@sap' + require('path').sep + 'cds')));`;
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(output.trim(), 'false');
});
