const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repository = path.join(__dirname, '..');
const checkScript = path.join(repository, 'scripts', 'release-check.cjs');
const notesScript = path.join(repository, 'scripts', 'release-notes.cjs');
const { checkRelease } = require(checkScript);
const { releaseNotes } = require(notesScript);

const url = (a, b = a) => `https://github.com/hendrik77/cap-jev/releases/download/v${a}/cap-jev-${b}.tgz`;
const dirs = [];

const files = (version) => ({
  'package.json': JSON.stringify({ name: 'cap-jev', version }),
  'package-lock.json': JSON.stringify({ name: 'cap-jev', version, packages: { '': { name: 'cap-jev', version } } }),
  'examples/cap-app/package.json': JSON.stringify({ dependencies: { 'cap-jev': `^${version}` } }),
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
    const body = JSON.stringify({ dependencies: { 'cap-jev': '^1.2.2' } });
    const failures = checkRelease({ root: tree({ 'examples/cap-app/package.json': body }) });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /examples\/cap-app\/package\.json/);
    assert.match(failures[0], /\^1\.2\.3/);
    assert.match(failures[0], /\^1\.2\.2/);
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
