/**
 * The planner of the `cds add systemone` facet. It is pure: it takes the contents of the application's files
 * and the options, and returns the files to write and the messages to print. It imports no CAP code and
 * touches no files, so the facet (`add.ts`) does the reading and writing.
 */

import { isLoopbackHost } from './validation';

export interface AddOptions {
  kind?: string;
  /** The target profile. Letters, digits, `_` and `-` only. Default `production`. */
  for?: string;
  force?: boolean;
  withFixtures?: boolean;
}

export interface AddInput {
  /** Raw text of `package.json`, or `undefined` when the file is missing. */
  packageJsonText?: string;
  /** Raw text of `.cdsrc-private.json`, or `undefined` when the file is missing. */
  cdsrcPrivateText?: string;
  /** Raw text of `.gitignore`, or `undefined` when the file is missing. */
  gitignore?: string;
  fixturesExist: boolean;
  /** `cds.env.requires.kinds`. */
  kinds: Record<string, unknown>;
  options: AddOptions;
}

export interface AddPlan {
  writes: Array<{ file: string; content: string }>;
  messages: string[];
}

type Json = Record<string, unknown>;

const DEFAULT_KIND = 'systemone-laya';
const DEFAULT_PROFILE = 'production';
const BASE_KIND = 'systemone-defaults';
const MOCK_IMPL = 'cap-jev/providers/mock';
const PROFILE = /^[A-Za-z0-9_-]+$/;
const PACKAGE_JSON = 'package.json';
const CDSRC_PRIVATE = '.cdsrc-private.json';
const GITIGNORE = '.gitignore';
const FIXTURES = 'test/data/systemone.json';

const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const say = (text: string) => `[systemone] ${text}`;

// Adds missing keys deeply and never overwrites a value the user set.
function mergeInto(target: Json, source: Json): Json {
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__') continue;
    const current = target[key];
    if (record(value)) target[key] = mergeInto(record(current) ? current : {}, value);
    else target[key] = value;
  }
  return target;
}

/** The kind and its ancestors, nearest first. Stops at a missing kind and at a cycle. */
function kindChain(kinds: Record<string, unknown>, name: string): string[] {
  const chain: string[] = [];
  let next: unknown = name;
  while (typeof next === 'string' && !chain.includes(next) && Object.hasOwn(kinds, next)) {
    chain.push(next);
    const kind = kinds[next];
    next = record(kind) ? kind.kind : undefined;
  }
  return chain;
}

/**
 * The settings of a kind: it follows the `kind` references and merges the settings, so that the child wins.
 * Plain objects merge recursively, everything else is replaced. The `kind` key itself is left out.
 * Returns `undefined` for an unknown kind.
 */
export function resolveKind(kinds: Record<string, unknown>, name: string): Json | undefined {
  const chain = kindChain(kinds, name);
  if (!chain.length) return undefined;
  const merged: Json = {};
  for (const link of [...chain].reverse()) {
    const settings = kinds[link];
    if (record(settings)) mergeInto(merged, settings);
  }
  delete merged.kind;
  return merged;
}

const isMock = (kinds: Record<string, unknown>, name: string) => resolveKind(kinds, name)?.impl === MOCK_IMPL;

// The kinds `--kind` offers: System One kinds except the base and the mock.
function selectableKinds(kinds: Record<string, unknown>): string[] {
  return Object.keys(kinds)
    .filter((name) => name !== BASE_KIND && kindChain(kinds, name).includes(BASE_KIND) && !isMock(kinds, name))
    .sort();
}

// Checks `--kind` and lists the selectable kinds in every error.
function chooseKind(kinds: Record<string, unknown>, kind: unknown): string {
  const list = `Selectable kinds: ${selectableKinds(kinds).join(', ') || 'none'}.`;
  if (typeof kind !== 'string' || !kind) throw new Error(`--kind needs the name of a kind. ${list}`);
  if (!Object.hasOwn(kinds, kind)) throw new Error(`Unknown kind "${kind}". ${list}`);
  if (kind === BASE_KIND) throw new Error(`The kind "${kind}" only holds shared settings and cannot be used. ${list}`);
  if (isMock(kinds, kind)) throw new Error(`The kind "${kind}" is the mock and cannot be used for a profile. ${list}`);
  if (!kindChain(kinds, kind).includes(BASE_KIND)) throw new Error(`"${kind}" is not a System One kind. ${list}`);
  return kind;
}

// Checks `--for`; the profile becomes a key in package.json.
function chooseProfile(value: unknown): string {
  if (value === undefined) return DEFAULT_PROFILE;
  if (typeof value !== 'string' || !PROFILE.test(value)) {
    throw new Error(`Invalid profile ${JSON.stringify(value)}: use letters, digits, "_" and "-" only.`);
  }
  return value;
}

// Parses a config file, with the file name in the error.
function parseJson(text: string, file: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!record(parsed)) throw new Error(`${file} must contain a JSON object.`);
  return parsed;
}

/** The object at `parent[key]`, created when missing. */
function child(parent: Json, key: string, label: string, file: string): Json {
  const value = parent[key];
  if (value === undefined) return (parent[key] = {});
  if (!record(value)) throw new Error(`${label} in ${file} must be an object.`);
  return value;
}

// Keeps the indentation of the existing file, so the command makes no formatting diff.
function detectIndent(text: string | undefined): string {
  return text?.match(/^([ \t]+)\S/m)?.[1] ?? '  ';
}

// Serialises with the indentation and line endings of the original.
function jsonText(value: Json, original: string | undefined): string {
  const eol = original?.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, detectIndent(original)).replace(/\n/g, eol) + eol;
}

// The new .gitignore text, or `undefined` when `.cdsrc-private.json` is already listed.
function gitignoreText(text: string | undefined): string | undefined {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(CDSRC_PRIVATE) || lines.includes(`/${CDSRC_PRIVATE}`)) return undefined;
  const existing = text ?? '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const separator = existing === '' || /\n$/.test(existing) ? '' : eol;
  return `${existing}${separator}${CDSRC_PRIVATE}${eol}`;
}

/** The text of the example `test/data/systemone.json`: one fixed answer and one simulated failure. */
export function exampleFixtures(): string {
  return `[
  {
    "when": { "stateIncludes": ["refund", "money back"], "question": "department" },
    "answer": { "choice": "billing" }
  },
  {
    "when": { "stateIncludes": "simulate outage" },
    "fail": "HTTP_ERROR",
    "status": 503,
    "providerCode": "outage"
  }
]
`;
}

// True for a loopback URL; used to warn when a kind that needs a token points at one.
function isLocalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Plans `cds add systemone` as data (files to write, messages): no file access, so it can be tested without CAP.
export function planSystemOne(input: AddInput): AddPlan {
  const { kinds, options } = input;
  const profile = chooseProfile(options.for);
  const kind = chooseKind(kinds, options.kind ?? DEFAULT_KIND);
  const key = `[${profile}]`;
  const force = options.force === true;

  if (input.packageJsonText === undefined) {
    throw new Error(`${PACKAGE_JSON} not found. Run this command in the root of your project.`);
  }
  const pkg = parseJson(input.packageJsonText, PACKAGE_JSON);
  const cdsrc = input.cdsrcPrivateText === undefined ? undefined : parseJson(input.cdsrcPrivateText, CDSRC_PRIVATE);

  const writes: AddPlan['writes'] = [];
  const messages: string[] = [];

  // package.json: the kind goes into the profile.
  const cds = child(pkg, 'cds', 'cds', PACKAGE_JSON);
  const requires = child(cds, 'requires', 'cds.requires', PACKAGE_JSON);
  const systemone = child(requires, 'systemone', 'cds.requires.systemone', PACKAGE_JSON);
  const section = child(systemone, key, `cds.requires.systemone["${key}"]`, PACKAGE_JSON);

  if (typeof systemone.kind === 'string') {
    messages.push(
      say(
        `cds.requires.systemone.kind is "${systemone.kind}" in ${PACKAGE_JSON}. It applies to every profile and turns off the mock in development and test. Move it into a profile, for example "${key}": { "kind": "${systemone.kind}" }.`,
      ),
    );
  }

  const current = section.kind;
  let configured = true;
  if (current === kind) {
    messages.push(say(`The kind ${kind} is already configured for the ${profile} profile.`));
  } else if (current !== undefined && !force) {
    messages.push(
      say(
        `The ${profile} profile already uses the kind ${String(current)}; kept it. Use --force to replace it with ${kind}.`,
      ),
    );
    configured = false;
  } else {
    section.kind = kind;
    writes.push({ file: PACKAGE_JSON, content: jsonText(pkg, input.packageJsonText) });
    messages.push(
      say(
        current === undefined
          ? `Set the kind of the ${profile} profile to ${kind} in ${PACKAGE_JSON}.`
          : `Replaced the kind ${String(current)} of the ${profile} profile with ${kind} in ${PACKAGE_JSON}.`,
      ),
    );
  }

  // .cdsrc-private.json: a token placeholder for the kind just configured.
  let cdsrcWritten = false;
  const settings = resolveKind(kinds, kind) ?? {};
  if (configured && settings.requiresToken === true) {
    const root = cdsrc ?? {};
    const credentials = child(
      child(
        child(child(root, 'requires', 'requires', CDSRC_PRIVATE), 'systemone', 'requires.systemone', CDSRC_PRIVATE),
        key,
        `requires.systemone["${key}"]`,
        CDSRC_PRIVATE,
      ),
      'credentials',
      `requires.systemone["${key}"].credentials`,
      CDSRC_PRIVATE,
    );
    const token = credentials.token;
    if (token === undefined) {
      credentials.token = '';
      writes.push({ file: CDSRC_PRIVATE, content: jsonText(root, input.cdsrcPrivateText) });
      cdsrcWritten = true;
      messages.push(say(`Added an empty credentials.token to ${CDSRC_PRIVATE} under ${key}.`));
    }
    if (token === undefined || token === '') {
      messages.push(say(`Next: fill in credentials.token in ${CDSRC_PRIVATE} under ${key}.`));
    }
  }

  // .gitignore
  if (cdsrcWritten || input.cdsrcPrivateText !== undefined) {
    const content = gitignoreText(input.gitignore);
    if (content !== undefined) {
      writes.push({ file: GITIGNORE, content });
      messages.push(
        say(
          input.gitignore === undefined
            ? `Created ${GITIGNORE} with ${CDSRC_PRIVATE}.`
            : `Added ${CDSRC_PRIVATE} to ${GITIGNORE}.`,
        ),
      );
    }
  }

  // test/data/systemone.json
  if (options.withFixtures === true) {
    if (input.fixturesExist && !force) {
      messages.push(say(`Kept the existing ${FIXTURES}. Use --force to replace it with the example fixtures.`));
    } else {
      writes.push({ file: FIXTURES, content: exampleFixtures() });
      messages.push(
        say(input.fixturesExist ? `Replaced ${FIXTURES} with the example fixtures.` : `Wrote ${FIXTURES}.`),
      );
    }
  }

  // Next steps for the kind that is configured now.
  if (configured) {
    // The application's own URL, in the profile or at service level, wins over the kind's.
    const url = [section, systemone, settings]
      .map((source) => (record(source.credentials) ? source.credentials.url : undefined))
      .find((value) => typeof value === 'string' && value !== '');
    if (typeof url !== 'string' || !url) {
      messages.push(
        say(
          `Next: the kind ${kind} has no URL. Set credentials.url under cds.requires.systemone["${key}"] in ${PACKAGE_JSON}.`,
        ),
      );
    } else if (isLocalUrl(url)) {
      messages.push(
        say(
          `Next: to try it locally, start the mock server with "npx cap-jev-mock" and run your application with CDS_ENV=${profile}.`,
        ),
      );
    }
  }

  return { writes, messages };
}
