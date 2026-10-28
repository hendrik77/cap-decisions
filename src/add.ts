/**
 * The `cds add decisions` facet. It is registered by `cds-plugin.js` only while `@sap/cds-dk` runs `cds add`,
 * because only then `cds.add` exists. It reads and writes the files; the decisions are in `add-core.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { planDecisions } from './add-core';
import type { AddOptions } from './add-core';

interface CliOption {
  type: 'string' | 'boolean';
  help: string;
  short?: string;
}

/** The part of `cds.add` and `cds.cli` of `@sap/cds-dk` that the facet uses. `@cap-js/cds-types` has no types for them. */
interface AddPlugin {
  options(): Record<string, CliOption>;
  run(): Promise<void>;
}
interface CdsWithAdd {
  root: string;
  env: { requires?: { kinds?: Record<string, unknown> } };
  cli?: { options?: Record<string, unknown> };
  add: {
    Plugin: new () => AddPlugin;
    readProject(): { isJava?: boolean };
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds') as CdsWithAdd;

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

// Reads a file of the project; `undefined` when it does not exist.
function readText(root: string, file: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw `Cannot read ${file}: ${(error as Error).message}`;
  }
}

// The `cds add decisions` facet: collects the project's files, asks `planDecisions` and writes what it returns.
class DecisionsFacet extends cds.add.Plugin {
  static help(): string {
    return 'Decision models with cap-decisions';
  }

  options(): Record<string, CliOption> {
    return {
      kind: { type: 'string', help: 'The kind to use in the target profile. Default: decisions-laya' },
      'with-fixtures': { type: 'boolean', help: 'Write an example test/data/decisions.json for the mock' },
    };
  }

  async run(): Promise<void> {
    if (cds.add.readProject().isJava) {
      throw 'cap-decisions is a Node.js plugin and cannot be added to a Java project.';
    }
    const root = cds.root;
    const cli = cds.cli?.options ?? {};
    const options: AddOptions = {
      kind: text(cli.kind),
      for: text(cli.for),
      force: cli.force === true,
      withFixtures: cli['with-fixtures'] === true,
    };
    let plan;
    try {
      plan = planDecisions({
        packageJsonText: readText(root, 'package.json'),
        cdsrcPrivateText: readText(root, '.cdsrc-private.json'),
        gitignore: readText(root, '.gitignore'),
        fixturesExist: fs.existsSync(path.join(root, 'test/data/decisions.json')),
        kinds: cds.env.requires?.kinds ?? {},
        options,
      });
    } catch (error) {
      throw error instanceof Error ? error.message : error;
    }
    for (const { file, content } of plan.writes) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    for (const message of plan.messages) console.log(message);
  }
}

export = DecisionsFacet;
