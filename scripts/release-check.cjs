const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { releaseNotes } = require('./release-notes.cjs');

const ARCHIVE = /releases\/download\/v([^/\s)"'`]+)\/cap-jev-([^/\s)"'`]+?)\.tgz/g;

function checkRelease({ root, tag }) {
  const failures = [];
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      failures.push(`${file}: cannot be read (${error.code ?? error.message})`);
    }
  };
  const readJson = (file) => {
    const text = read(file);
    if (text === undefined) return;
    try {
      return JSON.parse(text);
    } catch (error) {
      failures.push(`${file}: is not valid JSON (${error.message})`);
    }
  };
  const expect = (file, what, expected, found) => {
    if (found !== expected) failures.push(`${file}: expected ${what} ${expected}, found ${found ?? 'none'}`);
  };

  const version = readJson('package.json')?.version;
  if (typeof version !== 'string') {
    failures.push('package.json: expected a string "version"');
    return failures;
  }

  const lock = readJson('package-lock.json');
  if (lock) {
    expect('package-lock.json', '"version"', version, lock.version);
    expect('package-lock.json', 'packages[""].version', version, lock.packages?.['']?.version);
  }

  const example = readJson('examples/cap-app/package.json');
  if (example)
    expect('examples/cap-app/package.json', 'dependency cap-jev', `^${version}`, example.dependencies?.['cap-jev']);

  for (const file of ['README.md', 'examples/cap-app/README.md']) {
    const text = read(file);
    if (text === undefined) continue;
    const urls = [...text.matchAll(ARCHIVE)];
    if (!urls.length) failures.push(`${file}: expected a release archive URL for ${version}, found none`);
    for (const [url, directory, name] of urls) {
      if (directory !== version || name !== version) {
        failures.push(`${file}: expected archive URL for v${version}/cap-jev-${version}.tgz, found ${url}`);
      }
    }
  }

  if (read('CHANGELOG.md') !== undefined) {
    try {
      releaseNotes({ root, version });
    } catch {
      failures.push(`CHANGELOG.md: expected heading "## ${version}" or "## ${version}: <title>", found none`);
    }
  }

  if (tag !== undefined) expect('tag', 'tag', `v${version}`, tag);
  return failures;
}

if (require.main === module) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, tag: { type: 'string' } } });
  const root = values.root ?? path.join(__dirname, '..');
  const failures = checkRelease({ root, tag: values.tag });
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exit(1);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  process.stdout.write(`release check passed for ${version}\n`);
}

module.exports = { checkRelease };
