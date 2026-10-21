const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function releaseNotes({ root, version }) {
  const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
  const heading = new RegExp(`^## ${escape(version)}(?:: (.+?))?\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no heading "## ${version}" or "## ${version}: <title>"`);
  const title = heading.exec(lines[start])[1];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
  return { title: title ? `${version}: ${title}` : version, notes: `${body.trim()}\n` };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' }, notes: { type: 'string' } },
  });
  const [version] = positionals;
  if (!version) throw new Error('usage: release-notes.cjs <version> [--root <dir>] [--notes <file>]');
  const { title, notes } = releaseNotes({ root: values.root ?? path.join(__dirname, '..'), version });
  process.stdout.write(`${title}\n`);
  if (values.notes) fs.writeFileSync(values.notes, notes);
  else process.stdout.write(notes);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { releaseNotes };
