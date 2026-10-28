const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const repository = path.join(__dirname, '..');
const checkScript = path.join(repository, 'scripts', 'release-check.cjs');
const notesScript = path.join(repository, 'scripts', 'release-notes.cjs');
const { checkRelease, findMachinePaths, checkArchive } = require(checkScript);
const { releaseNotes } = require(notesScript);

const url = (a, b = a) => `https://github.com/hendrik77/cap-jev/releases/download/v${a}/cap-jev-${b}.tgz`;
const dirs = [];

const workflow = (cds = '[9, 10]') =>
  `name: CI\n\njobs:\n  checks:\n    strategy:\n      matrix:\n        node: [22, 24, 26]\n        cds: ${cds}\n    steps: []\n`;

const files = (version) => ({
  '.github/workflows/ci.yml': workflow(),
  'package.json': JSON.stringify({ name: 'cap-jev', version, peerDependencies: { '@sap/cds': '^9 || ^10' } }),
  'examples/provider-package/package.json': JSON.stringify({
    name: 'cap-jev-acme',
    peerDependencies: { 'cap-decisions': '>=0.5.0', '@sap/cds': '^9 || ^10' },
  }),
  'package-lock.json': JSON.stringify({ name: 'cap-jev', version, packages: { '': { name: 'cap-jev', version } } }),
  'examples/cap-app/package.json': JSON.stringify({ dependencies: { 'cap-decisions': `^${version}` } }),
  'examples/provider-package/README.md': `# Acme\n\n{ "dependencies": { "cap-decisions": "^${version}", "cap-jev-provider-acme": "^1.0.0" } }\n`,
  'docs/providers.md': `# Providers
`,
  'README.md': `# cap-jev\n\nnpm install ${url(version)}\n`,
  'examples/cap-app/README.md': `# Example\n\ncurl -fLO ${url(version)}\n`,
  'CHANGELOG.md': `# Changelog\n\n## ${version}: A title\n\n### Added\n\n- Something.\n\n## 0.0.1\n\n- Old.\n`,
});

const tree = (overrides = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-release-'));
  dirs.push(root);
  for (const [name, content] of Object.entries({ ...files('1.2.3'), ...overrides })) {
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
};

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('checkRelease', () => {
  test('passes on a consistent tree, with and without a matching tag', () => {
    const root = tree();
    assert.deepEqual(checkRelease({ root }), []);
    assert.deepEqual(checkRelease({ root, tag: 'v1.2.3' }), []);
  });

  test('accepts an untitled changelog heading', () => {
    const root = tree({ 'CHANGELOG.md': '# Changelog\n\n## 1.2.3\n\n- Text.\n' });
    assert.deepEqual(checkRelease({ root }), []);
  });

  test('fails on a tag that is not v plus the version', () => {
    const failures = checkRelease({ root: tree(), tag: 'v1.2.4' });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /v1\.2\.4/);
    assert.match(failures[0], /v1\.2\.3/);
  });

  test('fails on a lock file version', () => {
    const lock = JSON.parse(files('1.2.3')['package-lock.json']);
    lock.version = '1.2.2';
    const failures = checkRelease({ root: tree({ 'package-lock.json': JSON.stringify(lock) }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /package-lock\.json/);
    assert.match(failures[0], /1\.2\.2/);
  });

  test('fails on the root package entry of the lock file', () => {
    const lock = JSON.parse(files('1.2.3')['package-lock.json']);
    lock.packages[''].version = '1.2.2';
    const failures = checkRelease({ root: tree({ 'package-lock.json': JSON.stringify(lock) }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /package-lock\.json/);
    assert.match(failures[0], /packages/);
  });

  test('fails on the example range', () => {
    const body = JSON.stringify({ dependencies: { 'cap-decisions': '^1.2.2' } });
    const failures = checkRelease({ root: tree({ 'examples/cap-app/package.json': body }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /examples\/cap-app\/package\.json/);
    assert.match(failures[0], /\^1\.2\.3/);
    assert.match(failures[0], /\^1\.2\.2/);
  });

  test('fails on the cap-decisions range quoted in the provider package README', () => {
    const readme = '{ "dependencies": { "cap-decisions": "^1.2.2" } }\n';
    const failures = checkRelease({ root: tree({ 'examples/provider-package/README.md': readme }) });
    assert.deepEqual(failures, [
      'examples/provider-package/README.md: expected dependency cap-decisions ^1.2.3, found ^1.2.2',
    ]);
  });

  test('passes when the provider package README quotes no cap-decisions range', () => {
    assert.deepEqual(checkRelease({ root: tree({ 'examples/provider-package/README.md': '# Acme\n' }) }), []);
  });

  test('passes when docs/providers.md quotes the peer range of package.json', () => {
    const guide = '"peerDependencies": { "@sap/cds": "^9 || ^10" }\n';
    assert.deepEqual(checkRelease({ root: tree({ 'docs/providers.md': guide }) }), []);
  });

  test('fails on the @sap/cds peer range quoted in docs/providers.md', () => {
    const guide = '"peerDependencies": { "@sap/cds": "^9" }\n';
    const failures = checkRelease({ root: tree({ 'docs/providers.md': guide }) });
    assert.deepEqual(failures, [
      'docs/providers.md: expected quoted @sap/cds peer range ^9 || ^10 (the peer range in package.json), found ^9',
    ]);
  });

  test('fails on a README without an archive URL', () => {
    const failures = checkRelease({ root: tree({ 'README.md': '# cap-jev\n' }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^README\.md/);
  });

  test('fails on an archive URL with the wrong version', () => {
    const failures = checkRelease({ root: tree({ 'examples/cap-app/README.md': `curl ${url('1.2.2')}\n` }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /examples\/cap-app\/README\.md/);
    assert.match(failures[0], /1\.2\.2/);
  });

  test('fails on an archive URL whose directory and file name differ', () => {
    const failures = checkRelease({ root: tree({ 'README.md': `npm install ${url('1.2.3', '1.2.2')}\n` }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^README\.md/);
  });

  test('fails on an archive file name with the wrong version', () => {
    const readme = `curl -fLO ${url('1.2.3')}\nnpm install ./cap-jev-1.2.2.tgz\n\nIt records \`file:cap-jev-1.2.2.tgz\`.\n`;
    const failures = checkRelease({ root: tree({ 'README.md': readme }) });
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.match(failure, /^README\.md/);
      assert.match(failure, /cap-jev-1\.2\.2\.tgz/);
    }
  });

  test('accepts the placeholder archive name', () => {
    const readme = `curl -fLO ${url('1.2.3')}\nInstall the resulting \`cap-jev-<version>.tgz\` file.\n`;
    assert.deepEqual(checkRelease({ root: tree({ 'README.md': readme }) }), []);
  });

  test('fails on a changelog without the version', () => {
    const failures = checkRelease({ root: tree({ 'CHANGELOG.md': '# Changelog\n\n## 1.2.30\n\n## 1.2.2: Old\n' }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /CHANGELOG\.md/);
    assert.match(failures[0], /1\.2\.3/);
  });

  test('reports a missing file as a failure', () => {
    const failures = checkRelease({ root: tree({ 'CHANGELOG.md': null }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /CHANGELOG\.md/);
  });

  test('reports an unparsable file as a failure', () => {
    const failures = checkRelease({ root: tree({ 'package-lock.json': '{' }) });
    assert.ok(failures.length >= 1);
    assert.match(failures[0], /package-lock\.json/);
  });

  test('reports every failure', () => {
    const failures = checkRelease({ root: tree({ 'README.md': '', 'CHANGELOG.md': '' }), tag: 'v9.9.9' });
    assert.equal(failures.length, 3);
  });

  describe('CAP support policy', () => {
    const pkg = (range) =>
      JSON.stringify({ name: 'cap-jev', version: '1.2.3', peerDependencies: { '@sap/cds': range } });
    const provider = (range) =>
      JSON.stringify({ name: 'cap-jev-acme', peerDependencies: { 'cap-decisions': '>=0.5.0', '@sap/cds': range } });

    test('passes when the peer ranges name the CAP majors of the CI matrix', () => {
      assert.deepEqual(checkRelease({ root: tree() }), []);
    });

    test('sorts the majors of the matrix ascending', () => {
      const root = tree({ '.github/workflows/ci.yml': workflow('[10, 9]') });
      assert.deepEqual(checkRelease({ root }), []);
    });

    test('follows the matrix when it changes', () => {
      const root = tree({
        '.github/workflows/ci.yml': workflow('[10, 11]'),
        'package.json': pkg('^10 || ^11'),
        'examples/provider-package/package.json': provider('^10 || ^11'),
      });
      assert.deepEqual(checkRelease({ root }), []);
    });

    test('fails on an open peer range', () => {
      const failures = checkRelease({ root: tree({ 'package.json': pkg('>=9') }) });
      assert.deepEqual(failures, [
        'package.json: expected @sap/cds peer range ^9 || ^10 (the CAP majors in .github/workflows/ci.yml), found >=9',
      ]);
    });

    test('fails on a peer range with one major only', () => {
      const failures = checkRelease({ root: tree({ 'package.json': pkg('^10') }) });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^package\.json: expected @sap\/cds peer range \^9 \|\| \^10 .*, found \^10$/);
    });

    test('fails on a peer range with a major that CI does not test', () => {
      const failures = checkRelease({ root: tree({ 'package.json': pkg('^9 || ^10 || ^11') }) });
      assert.equal(failures.length, 1);
      assert.match(
        failures[0],
        /^package\.json: expected @sap\/cds peer range \^9 \|\| \^10 .*, found \^9 \|\| \^10 \|\| \^11$/,
      );
    });

    test('fails on the peer range of the example provider package', () => {
      const failures = checkRelease({ root: tree({ 'examples/provider-package/package.json': provider('>=9') }) });
      assert.deepEqual(failures, [
        'examples/provider-package/package.json: expected @sap/cds peer range ^9 || ^10 (the CAP majors in .github/workflows/ci.yml), found >=9',
      ]);
    });

    test('fails on a missing peer range', () => {
      const body = JSON.stringify({ name: 'cap-jev', version: '1.2.3' });
      const failures = checkRelease({ root: tree({ 'package.json': body }) });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^package\.json: expected @sap\/cds peer range \^9 \|\| \^10 .*, found none$/);
    });

    test('fails when the workflow file is missing', () => {
      const failures = checkRelease({ root: tree({ '.github/workflows/ci.yml': null }) });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^\.github\/workflows\/ci\.yml: cannot be read/);
    });

    test('fails when the workflow has no cds matrix line', () => {
      const failures = checkRelease({ root: tree({ '.github/workflows/ci.yml': 'name: CI\n' }) });
      assert.equal(failures.length, 1);
      assert.match(
        failures[0],
        /^\.github\/workflows\/ci\.yml: expected a "cds: \[<majors>\]" matrix line, found none$/,
      );
    });

    test('names the failure of the matrix line once, not once per package file', () => {
      const root = tree({ '.github/workflows/ci.yml': workflow('[nine]') });
      const failures = checkRelease({ root });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^\.github\/workflows\/ci\.yml: /);
    });
  });

  test('passes on this repository', () => {
    assert.deepEqual(checkRelease({ root: repository }), []);
  });
});

describe('release-check command line', () => {
  const run = (...args) => spawnSync(process.execPath, [checkScript, ...args], { encoding: 'utf8' });

  test('exits with 0 and one line on a consistent tree', () => {
    const result = run('--root', tree(), '--tag', 'v1.2.3');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'release check passed for 1.2.3\n');
  });

  test('exits with 1 and prints each failure to stderr', () => {
    const result = run('--root', tree({ 'README.md': '' }), '--tag', 'v1.2.4');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 2);
  });
});

const machinePaths = {
  'macOS home': '/Us' + 'ers/alice/project/file.md',
  'Linux home': '/ho' + 'me/bob.smith/work',
  'macOS temp': '/pri' + 'vate/tmp/abc123',
  'macOS private var': '/pri' + 'vate/var/x',
  'macOS var folders': '/va' + 'r/folders/zz/T',
  'Linux tmp': '/tm' + 'p/build-1',
  'Linux var tmp': '/var/tm' + 'p/build-1',
  'root home': '/ro' + 'ot/.config',
  'macOS home at the end of a line': '/Us' + 'ers/alice',
  'Windows home': 'C:' + '\\Us' + 'ers\\alice\\x',
  'Windows home with slashes': 'd:' + '/uSe' + 'rs/alice/x',
};

describe('findMachinePaths', () => {
  for (const [name, sample] of Object.entries(machinePaths)) {
    test(`finds a ${name} path with its line`, () => {
      const root = tree({ 'docs/a.md': `first\nsee ${sample} here\n` });
      const hits = findMachinePaths({ root, files: ['docs/a.md'] });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].file, 'docs/a.md');
      assert.equal(hits[0].line, 2);
      assert.ok(sample.startsWith(hits[0].text));
      assert.ok(hits[0].text.length > 8);
    });
  }

  test('ignores placeholders and bare directory names', () => {
    const text = [
      'a /Us' + 'ers/<name>/ b',
      'a /ho' + 'me/<name>/ b',
      'a /Us' + 'ers/ b',
      'a `/pri' + 'vate/tmp/` b',
      'a /va' + 'r/folders/ b',
      'a C:' + '\\Us' + 'ers\\<name> b',
      'a /home b',
      'a /ro' + 'ot/ b',
      'a /tm' + 'p/ b',
      'a /tm' + 'p/<name> b',
      'see https://example.com/tm' + 'p/x and https://example.com/ro' + 'ot/x',
      'a src/tm' + 'p/x b',
    ].join('\n');
    const root = tree({ 'a.md': text });
    assert.deepEqual(findMachinePaths({ root, files: ['a.md'] }), []);
  });

  test('finds a home path followed by a quote, a space or the end of a line', () => {
    for (const text of [
      '"/Us' + 'ers/alice"',
      "'/ho" + "me/bob' x",
      '(/tm' + 'p/x)',
      '`/tm' + 'p/x`',
      '/ro' + 'ot/x',
    ]) {
      const root = tree({ 'a.md': text });
      assert.equal(findMachinePaths({ root, files: ['a.md'] }).length, 1, text);
    }
  });

  test('reports several hits on several lines', () => {
    const root = tree({ 'a.md': `${machinePaths['macOS home']}\nok\n${machinePaths['Linux home']}\n` });
    assert.deepEqual(
      findMachinePaths({ root, files: ['a.md'] }).map((hit) => hit.line),
      [1, 3],
    );
  });

  test('skips binary and missing files', () => {
    const root = tree({ 'a.md': 'clean\n' });
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(machinePaths['macOS home'])]);
    fs.writeFileSync(path.join(root, 'b.bin'), binary);
    assert.deepEqual(findMachinePaths({ root, files: ['b.bin', 'missing.md', 'a.md'] }), []);
  });

  test('walks the root outside a repository and skips node_modules, dist, .git and coverage', () => {
    const dirty = machinePaths['macOS home'];
    const root = tree({
      'src/a.md': dirty,
      'node_modules/x/a.md': dirty,
      'dist/a.md': dirty,
      '.git/a.md': dirty,
      'coverage/a.md': dirty,
    });
    assert.deepEqual(
      findMachinePaths({ root }).map((hit) => hit.file),
      ['src/a.md'],
    );
  });

  test('lists only the tracked files in a repository', () => {
    const root = tree({ 'tracked.md': machinePaths['Linux home'], 'untracked.md': machinePaths['Linux home'] });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'tracked.md'], { cwd: root });
    assert.deepEqual(
      findMachinePaths({ root }).map((hit) => hit.file),
      ['tracked.md'],
    );
  });

  test('checkRelease reports a hit with file, line and advice', () => {
    const root = tree({ 'docs/guide.md': `a\nb ${machinePaths['macOS home']}\n` });
    const failures = checkRelease({ root });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^docs\/guide\.md:2: machine path \/Us/);
    assert.match(failures[0], /; use a relative path$/);
  });
});

const packArchive = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-archive-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'package'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'package', name), content);
  const file = path.join(dir, 'cap-jev-1.2.3.tgz');
  execFileSync('tar', ['-czf', file, '-C', dir, 'package']);
  return file;
};

describe('checkArchive', () => {
  test('reports exactly the dirty file, with archive, path and line', () => {
    const file = packArchive({ 'clean.md': 'clean\n', 'dirty.md': `ok\n${machinePaths['macOS home']}\n` });
    const failures = checkArchive(file);
    assert.equal(failures.length, 1);
    assert.ok(failures[0].startsWith(`${file}:package/dirty.md:2: machine path /Us`), failures[0]);
    assert.match(failures[0], /; use a relative path$/);
  });

  test('reports an unreadable archive', () => {
    const failures = checkArchive(path.join(os.tmpdir(), 'cap-jev-no-such-archive.tgz'));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /cap-jev-no-such-archive\.tgz/);
  });
});

describe('release-check --archive', () => {
  const run = (...args) => spawnSync(process.execPath, [checkScript, ...args], { encoding: 'utf8' });

  test('exits with 1 on a dirty archive and prints the hit', () => {
    const result = run('--archive', packArchive({ 'a.md': `${machinePaths['Linux home']}\n` }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package\/a\.md:1: machine path/);
  });

  test('exits with 0 on a clean archive and checks only the archive', () => {
    const result = run('--archive', packArchive({ 'a.md': 'clean\n' }), '--root', tree({ 'README.md': '' }));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });
});

describe('releaseNotes', () => {
  const changelog = [
    '# Changelog',
    '',
    '## 2.0.0: Big one',
    '',
    '### Added',
    '',
    '- Feature.',
    '',
    '## 1.1.0',
    '',
    '- Plain.',
    '',
    '## 1.0.0: First',
    '',
    '- Last section.',
    '',
    '',
  ].join('\n');
  const root = () => tree({ 'CHANGELOG.md': changelog });

  test('returns the title and the body of a titled heading', () => {
    assert.deepEqual(releaseNotes({ root: root(), version: '2.0.0' }), {
      title: '2.0.0: Big one',
      notes: '### Added\n\n- Feature.\n',
    });
  });

  test('returns the bare version for an untitled heading', () => {
    assert.deepEqual(releaseNotes({ root: root(), version: '1.1.0' }), { title: '1.1.0', notes: '- Plain.\n' });
  });

  test('returns the last section up to the end of the file', () => {
    assert.deepEqual(releaseNotes({ root: root(), version: '1.0.0' }), {
      title: '1.0.0: First',
      notes: '- Last section.\n',
    });
  });

  test('throws and names a missing version', () => {
    assert.throws(() => releaseNotes({ root: root(), version: '3.0.0' }), /3\.0\.0/);
  });

  test('does not match a longer version', () => {
    assert.throws(() => releaseNotes({ root: root(), version: '2.0' }), /2\.0/);
  });

  test('the command line prints the title and writes the notes file', () => {
    const dir = root();
    const file = path.join(dir, 'notes.md');
    const result = spawnSync(process.execPath, [notesScript, '2.0.0', '--root', dir, '--notes', file], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '2.0.0: Big one\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '### Added\n\n- Feature.\n');
  });

  test('the command line prints the notes after the title without --notes', () => {
    const result = spawnSync(process.execPath, [notesScript, '1.1.0', '--root', root()], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '1.1.0\n- Plain.\n');
  });

  test('the command line exits with 1 for a missing version', () => {
    const result = spawnSync(process.execPath, [notesScript, '3.0.0', '--root', root()], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /3\.0\.0/);
  });
});
