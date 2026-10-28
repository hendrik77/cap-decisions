const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { releaseNotes } = require('./release-notes.cjs');

const ARCHIVE = /releases\/download\/v([^/\s)"'`]+)\/cap-jev-([^/\s)"'`]+?)\.tgz/g;
// An archive file name outside a URL, such as `npm install ./cap-jev-1.2.3.tgz`.
const ARCHIVE_FILE = /(?<!releases\/download\/v[^/\s]+\/)(?<![\w-])cap-jev-(\d+\.\d+\.\d+[^/\s)"'`]*?)\.tgz/g;

const WORKFLOW = '.github/workflows/ci.yml';
// The CAP majors CI tests: the `cds: [9, 10]` line of the matrix.
const CDS_MATRIX = /^\s*cds:\s*\[([^\]]*)\]\s*(?:#.*)?$/m;

const NAME = '[A-Za-z0-9._-]';
// A path that starts a word: at the start of a line or after a space, a quote, a backtick, `(` or `=`, so that a URL
// path such as https://example.com/tmp/x does not match.
const START = '(?<![^\\s"\'`(=])';
const MACHINE_PATHS = [
  new RegExp(`(?<!${NAME})/Users/${NAME}+`, 'g'),
  new RegExp(`(?<!${NAME})/home/${NAME}+`, 'g'),
  new RegExp(`${START}/(?:var/)?tmp/${NAME}+`, 'g'),
  new RegExp(`${START}/root/${NAME}+`, 'g'),
  new RegExp(`/private/(?:tmp|var)/${NAME}+|(?<!${NAME})/var/folders/${NAME}+`, 'g'),
  new RegExp(`[A-Za-z]:[\\\\/]Users[\\\\/]${NAME}+`, 'gi'),
];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage']);

function walk(root, directory = '') {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...walk(root, relative));
    } else if (entry.isFile()) found.push(relative);
  }
  return found;
}

function listFiles(root) {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return walk(root);
  }
}

function findMachinePaths({ root, files }) {
  const hits = [];
  for (const file of files ?? listFiles(root)) {
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8192).includes(0)) continue;
    buffer
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        const found = MACHINE_PATHS.flatMap((pattern) => [...text.matchAll(pattern)]);
        for (const match of found.sort((a, b) => a.index - b.index)) {
          hits.push({ file, line: index + 1, text: match[0] });
        }
      });
  }
  return hits;
}

const describeHit = (prefix, { line, text }) => `${prefix}:${line}: machine path ${text}; use a relative path`;

function checkArchive(archive) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-archive-'));
  try {
    const result = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' });
    if (result.status !== 0) {
      const reason = (result.error?.message ?? result.stderr ?? '').trim();
      return [`${archive}: cannot be extracted (${reason || `tar exited with ${result.status}`})`];
    }
    return findMachinePaths({ root: directory, files: walk(directory) }).map((hit) =>
      describeHit(`${archive}:${hit.file}`, hit),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

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
  const expect = (file, what, expected, found, note = '') => {
    if (found !== expected) failures.push(`${file}: expected ${what} ${expected}${note}, found ${found ?? 'none'}`);
  };

  const rootPackage = readJson('package.json');
  const version = rootPackage?.version;
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
    expect(
      'examples/cap-app/package.json',
      'dependency cap-decisions',
      `^${version}`,
      example.dependencies?.['cap-decisions'],
    );

  // The example provider package README quotes the range of an application that installs cap-decisions.
  const providerReadme = read('examples/provider-package/README.md');
  for (const [, range] of providerReadme?.matchAll(/"cap-decisions":\s*"([^"]*)"/g) ?? []) {
    expect('examples/provider-package/README.md', 'dependency cap-decisions', `^${version}`, range);
  }

  // docs/providers.md quotes the peer range of a provider package.
  const providersGuide = read('docs/providers.md');
  const peerRange = rootPackage.peerDependencies?.['@sap/cds'];
  for (const [, range] of providersGuide?.matchAll(/"@sap\/cds":\s*"([^"]*)"/g) ?? []) {
    expect('docs/providers.md', 'quoted @sap/cds peer range', peerRange, range, ' (the peer range in package.json)');
  }

  // cap-jev supports the CAP majors that CI tests, and no others.
  const workflow = read(WORKFLOW);
  if (workflow !== undefined) {
    const list = workflow.match(CDS_MATRIX)?.[1];
    const majors = list?.split(',').map((major) => major.trim());
    if (!majors?.length || !majors.every((major) => /^\d+$/.test(major))) {
      failures.push(`${WORKFLOW}: expected a "cds: [<majors>]" matrix line, found none`);
    } else {
      const range = [...new Set(majors.map(Number))]
        .sort((a, b) => a - b)
        .map((major) => `^${major}`)
        .join(' || ');
      const peers = [
        ['package.json', rootPackage],
        ['examples/provider-package/package.json', readJson('examples/provider-package/package.json')],
      ];
      for (const [file, json] of peers) {
        if (json)
          expect(
            file,
            '@sap/cds peer range',
            range,
            json.peerDependencies?.['@sap/cds'],
            ` (the CAP majors in ${WORKFLOW})`,
          );
      }
    }
  }

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
    for (const [name, fileVersion] of text.matchAll(ARCHIVE_FILE)) {
      if (fileVersion !== version)
        failures.push(`${file}: expected archive file cap-jev-${version}.tgz, found ${name}`);
    }
  }

  if (read('CHANGELOG.md') !== undefined) {
    try {
      releaseNotes({ root, version });
    } catch {
      failures.push(`CHANGELOG.md: expected heading "## ${version}" or "## ${version}: <title>", found none`);
    }
  }

  for (const hit of findMachinePaths({ root })) failures.push(describeHit(hit.file, hit));

  if (tag !== undefined) expect('tag', 'tag', `v${version}`, tag);
  return failures;
}

if (require.main === module) {
  const { values } = parseArgs({
    options: { root: { type: 'string' }, tag: { type: 'string' }, archive: { type: 'string' } },
  });
  const root = values.root ?? path.join(__dirname, '..');
  const failures = values.archive ? checkArchive(values.archive) : checkRelease({ root, tag: values.tag });
  if (failures.length) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exit(1);
  }
  if (values.archive) {
    process.stdout.write(`archive check passed for ${values.archive}\n`);
    process.exit(0);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  process.stdout.write(`release check passed for ${version}\n`);
}

module.exports = { checkRelease, findMachinePaths, checkArchive };
