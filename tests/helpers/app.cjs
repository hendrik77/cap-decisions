const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '../..');

/**
 * Creates a temporary CAP app whose node_modules/cap-decisions and node_modules/@sap/cds are symlinks to the
 * repository root and its @sap/cds copy, so that exactly one @sap/cds instance is loaded. `links` maps further
 * package names to directories that are symlinked into node_modules (for example a provider package).
 */
function createApp(packageJson, files = {}, { links = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-decisions-app-')));
  const pkg = {
    ...packageJson,
    dependencies: { 'cap-decisions': '*', '@sap/cds': '*', ...packageJson.dependencies },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(path.join(dir, 'node_modules/@sap'), { recursive: true });
  fs.symlinkSync(root, path.join(dir, 'node_modules/cap-decisions'), 'dir');
  fs.symlinkSync(
    fs.realpathSync(path.join(root, 'node_modules/@sap/cds')),
    path.join(dir, 'node_modules/@sap/cds'),
    'dir',
  );
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(dir, 'node_modules', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'dir');
  }
  return dir;
}

/** Runs a script in the app directory in a child process and returns the parsed last stdout line. */
async function runInApp(dir, script, { env = {}, timeout = 30_000 } = {}) {
  let result;
  try {
    result = await execFileAsync(process.execPath, ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout,
    });
  } catch (error) {
    throw new Error(`Script failed in ${dir}: ${error.stderr || error.message}`, { cause: error });
  }
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  return JSON.parse(lines.at(-1));
}

function removeApp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { createApp, runInApp, removeApp };
