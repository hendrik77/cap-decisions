import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { completeAnswer } from './providers/mock-engine';
import type {
  Answer,
  ChoiceQuestion,
  DecisionRequest,
  DecisionResult,
  ProviderLimits,
  Question,
  ScoreQuestion,
  SystemOneCredentials,
  SystemOneSettings,
} from './types';

// This module is the test kit for provider packages (cap-jev/testing). It must not load @sap/cds: CAP runs in a
// child process of the test, in a temporary app. It is not loaded by cds-plugin.js or by any other module.

/**
 * An error response of a provider, as the kit's local server sends it.
 * @experimental
 */
export interface WireError {
  /** The HTTP status. */
  status: number;
  /** The body: an object is sent as JSON, a string as it is. */
  body: unknown;
}

/**
 * What `encodeError` receives.
 * @experimental
 */
export interface WireErrorInput {
  /** A machine-readable error code that must come back as `providerCode`. */
  code: string;
  /** The HTTP status to answer with. */
  status: number;
  /** A human-readable message that contains the test token, to check that it never reaches the raised error. */
  message: string;
}

/**
 * Options of {@link testProviderKind}.
 * @experimental
 */
export interface ProviderKindTestOptions {
  /** The kind under test, such as `systemone-acme`. */
  kind: string;
  /**
   * The provider package, linked into the temporary app. Default `process.cwd()`. When it is `cap-jev` itself,
   * the built-in kinds are tested and nothing is linked.
   */
  packageDir?: string;
  /** An existing CAP app that has the provider package installed. The kit then creates and links nothing. */
  appDir?: string;
  /** Further settings for the kind (for example `timeoutMs`, `limits`), applied over its resolved settings. */
  settings?: Omit<SystemOneSettings, 'credentials'> & Record<string, unknown>;
  /**
   * Further credentials, such as `accountId` or a `region` the subclass lists in `credentialKeys`. The kit sets
   * `url` to its local server and, when the kind has `requiresToken`, a test token unless one is given here.
   */
  credentials?: SystemOneCredentials & Record<string, string | undefined>;
  /** Turns a Jev response into the provider's wire format. Default: the response itself. */
  encode?: (response: DecisionResult, request: DecisionRequest) => unknown;
  /** Returns the provider's error response for a code. Default: Jev's `{ error: { type: code } }`. */
  encodeError?: (error: WireErrorInput) => WireError;
}

interface Normalized {
  kind: string;
  packageDir: string;
  appDir?: string;
  settings: Record<string, unknown>;
  credentials: Record<string, string | undefined>;
  encode: (response: DecisionResult, request: DecisionRequest) => unknown;
  encodeError: (error: WireErrorInput) => WireError;
}

const OPTION_KEYS = ['kind', 'packageDir', 'appDir', 'settings', 'credentials', 'encode', 'encodeError'];
const TEST_TOKEN = 'cap-jev-test-token';
const TEST_TIMEOUT = 90_000;
const MARK = '@@cap-jev-kit@@';

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalize(options: unknown): Normalized {
  if (!plain(options)) throw new TypeError('testProviderKind needs an options object with a kind');
  const extra = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (extra) throw new TypeError(`Unknown option "${extra}" of testProviderKind`);
  if (typeof options.kind !== 'string' || !options.kind) throw new TypeError('testProviderKind needs a kind');
  for (const key of ['packageDir', 'appDir']) {
    if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) {
      throw new TypeError(`${key} must be a directory path`);
    }
  }
  for (const key of ['settings', 'credentials']) {
    if (options[key] !== undefined && !plain(options[key])) throw new TypeError(`${key} must be an object`);
  }
  for (const key of ['encode', 'encodeError']) {
    if (options[key] !== undefined && typeof options[key] !== 'function') {
      throw new TypeError(`${key} must be a function`);
    }
  }
  return {
    kind: options.kind,
    packageDir: path.resolve((options.packageDir as string | undefined) ?? process.cwd()),
    appDir: options.appDir === undefined ? undefined : path.resolve(options.appDir as string),
    settings: (options.settings as Record<string, unknown> | undefined) ?? {},
    credentials: (options.credentials as Record<string, string | undefined> | undefined) ?? {},
    encode: (options.encode as Normalized['encode'] | undefined) ?? ((response) => response),
    encodeError:
      (options.encodeError as Normalized['encodeError'] | undefined) ??
      (({ code, status }) => ({ status, body: { error: { type: code } } })),
  };
}

// ---- The temporary app ----

// Resolves a package with Node's rules from a directory, so that self-references, workspaces and hoisting work.
function packageRoot(name: string, from: string): string | undefined {
  try {
    const file = createRequire(path.join(from, 'package.json')).resolve(`${name}/package.json`);
    return fs.realpathSync(path.dirname(file));
  } catch {
    return undefined;
  }
}

function readPackageJson(dir: string): { name?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
  } catch (error) {
    throw new Error(`${dir} is not a package directory: there is no readable package.json`, { cause: error });
  }
}

function link(target: string, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file, 'junction');
}

// Exactly one @sap/cds is loaded: the app, cap-jev and the provider package must reach the same real directory.
function createTemporaryApp(options: Normalized): string {
  const packageDir = fs.realpathSync(options.packageDir);
  const { name } = readPackageJson(packageDir);
  const own = name === 'cap-jev';
  const capJev = own ? packageDir : (packageRoot('cap-jev', packageDir) ?? path.resolve(__dirname, '..'));
  const cds = packageRoot('@sap/cds', packageDir) ?? packageRoot('@sap/cds', capJev);
  if (!cds) {
    throw new Error(
      `@sap/cds cannot be resolved from ${packageDir} or from cap-jev (${capJev}); install it as a development dependency`,
    );
  }
  const cdsOfCapJev = packageRoot('@sap/cds', capJev);
  if (cdsOfCapJev && cdsOfCapJev !== cds) {
    throw new Error(
      `Two copies of @sap/cds would be loaded: ${cds} (from the provider package) and ${cdsOfCapJev} (from cap-jev). ` +
        'Install the same copy for both, for example with a single npm install',
    );
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-jev-kit-')));
  try {
    const dependencies: Record<string, string> = { 'cap-jev': '*', '@sap/cds': '*' };
    if (!own) {
      if (!name) throw new Error(`${path.join(packageDir, 'package.json')} has no name`);
      dependencies[name] = '*';
    }
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'cap-jev-kit-app', private: true, dependencies }, null, 2),
    );
    link(capJev, path.join(dir, 'node_modules/cap-jev'));
    link(cds, path.join(dir, 'node_modules/@sap/cds'));
    if (!own && name) link(packageDir, path.join(dir, 'node_modules', name));
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

// ---- The child process: CAP in the app, answering line-delimited JSON commands ----

const CHILD_SOURCE = `
const readline = require('node:readline');
const MARK = ${JSON.stringify(MARK)};
const send = (message) => process.stdout.write(MARK + JSON.stringify(message) + '\\n');
const describeError = (error) => ({
  name: error && error.name,
  code: error && error.code,
  message: String((error && error.message) || error),
  status: error && error.status,
  providerCode: error && error.providerCode,
});
const cds = require('@sap/cds');
(async () => {
  await cds.plugins;
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = JSON.parse(line);
    const id = command.id;
    try {
      if (command.op === 'info') {
        const kinds = cds.requires.kinds || {};
        const settings = cds.requires.systemone || {};
        send({
          id,
          ok: true,
          info: {
            known: Object.hasOwn(kinds, command.kind),
            kinds: Object.keys(kinds).filter((name) => name.startsWith('systemone')),
            impl: settings.impl,
            modelId: settings.modelId,
            requiresToken: settings.requiresToken === true,
            limits: settings.limits || {},
          },
        });
        continue;
      }
      const service = await cds.connect.to('systemone', command.options);
      if (command.op === 'decide') send({ id, ok: true, result: await service.decide(command.request) });
      else send({ id, ok: true });
    } catch (error) {
      send({ id, ok: false, error: describeError(error) });
    }
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

interface KitError {
  name?: string;
  code?: string;
  message: string;
  status?: number;
  providerCode?: string | number;
}
type Outcome = { ok: true; result: DecisionResult } | { ok: false; error: KitError };
interface Info {
  known: boolean;
  kinds: string[];
  impl?: string;
  modelId?: string;
  requiresToken: boolean;
  limits: ProviderLimits;
}

class Child {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private buffer = '';
  private stderr = '';
  private next = 1;
  private exited?: string;

  constructor(dir: string, kind: string) {
    this.process = spawn(process.execPath, ['-e', CHILD_SOURCE], {
      cwd: dir,
      env: { ...process.env, cds_requires_systemone_kind: kind },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.read(chunk));
    this.process.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.process.stdin.on('error', (error) => {
      this.finish(`could not be written to: ${error.message}`);
      this.process.kill();
    });
    this.process.on('error', (error) => this.finish(`could not start: ${error.message}`));
    this.process.on('exit', (code, signal) => this.finish(`exited with ${signal ?? `code ${code}`}`));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith(MARK)) {
        const message = JSON.parse(line.slice(MARK.length)) as Record<string, unknown> & { id: number };
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private finish(reason: string): void {
    this.exited = `The CAP process of the test kit ${reason}.\n${this.stderr}`;
    for (const resolve of this.pending.values()) resolve({ crashed: this.exited });
    this.pending.clear();
  }

  ask(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new Error(this.exited));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The CAP process of the test kit did not answer within 30 seconds.\n${this.stderr}`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (typeof message.crashed === 'string') reject(new Error(message.crashed));
        else resolve(message);
      });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const exit = new Promise<void>((resolve) => this.process.once('exit', () => resolve()));
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 3000);
    await exit;
    clearTimeout(timer);
  }
}

// ---- The local server in the test process ----

type Handler = (request: IncomingMessage, response: ServerResponse, body: unknown) => void;
interface Received {
  body: unknown;
  headers: IncomingMessage['headers'];
}

class LocalServer {
  readonly received: Received[] = [];
  url = '';
  private handler: Handler = (_request, response) => response.writeHead(500).end();
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // The body stays text; the checks that read it fail with a readable message.
        }
        this.received.push({ body, headers: request.headers });
        this.handler(request, response, body);
      });
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1/systemone`;
    return this;
  }

  /** Forgets the requests of the last check and answers with `handler` from now on. */
  reset(handler: Handler): void {
    this.received.length = 0;
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// A URL on which nothing listens.
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1/systemone`;
}

// ---- Questions and answers for the checks ----

const STATE = 'The customer asks for a refund because the parcel arrived broken.';
const labels = (count: number): string[] => Array.from({ length: count }, (_, index) => `option${index}`);
const noulQuestion = (): Question => ({ type: 'noul', instructions: 'Is a refund requested?' });
const choiceQuestion = (count: number): ChoiceQuestion => ({
  type: 'choice',
  instructions: 'Which department is responsible?',
  criteria: Object.fromEntries(labels(count).map((label, index) => [label, `Department ${index}`])),
});
const scoreQuestion = (count: number): ScoreQuestion => ({
  type: 'score',
  instructions: 'How urgent is the request?',
  criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
});
const request = (questions: Record<string, Question>): DecisionRequest => ({ state: STATE, questions });

const NOUL = 0.75;
const SCORE = 1;

// A valid Jev answer for every question, built from the request: the last choice, a fixed noul and score.
function respondTo(decision: DecisionRequest): DecisionResult {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(decision.questions)) {
    const partial =
      question.type === 'noul'
        ? { noul: NOUL }
        : question.type === 'choice'
          ? { choice: Object.keys(question.criteria).at(-1) }
          : { score: SCORE };
    answers[id] = completeAnswer(question, partial, decision.state, id);
  }
  return { model: 'cap-jev-test-model', answers, usage: { input_tokens: 3, output_tokens: 1 } } as DecisionResult;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const describeFailure = (error: KitError): string => {
  const parts = [error.code ?? error.name ?? 'Error'];
  if (error.status !== undefined) parts.push(`(HTTP ${error.status})`);
  return `${parts.join(' ')}: ${error.message}`;
};

// ---- The checks ----

interface Context {
  options: Normalized;
  server: LocalServer;
  child: Child;
  info: Info;
  app?: string;
}

/**
 * Registers the checks that every provider kind must pass, as `node:test` tests in a `describe` named after the
 * kind. Call it once per kind at the top level of a test file of the provider package and run `node --test`.
 *
 * The kit links the provider package into a temporary CAP app, starts CAP in a child process and a local HTTP
 * server in the test process, and points the kind at the server. `encode` and `encodeError` describe the
 * provider's wire format; the defaults fit a server that speaks the Jev protocol.
 *
 * @experimental
 */
export function testProviderKind(options: ProviderKindTestOptions): void {
  const normalized = normalize(options);
  const { kind } = normalized;
  let context: Context | undefined;
  const ctx = (): Context => {
    if (!context) throw new Error(`The test kit for ${kind} did not start`);
    return context;
  };

  describe(kind, () => {
    before(async () => {
      let app: string | undefined;
      let server: LocalServer | undefined;
      let child: Child | undefined;
      try {
        app = normalized.appDir ?? createTemporaryApp(normalized);
        server = await new LocalServer().listen();
        child = new Child(app, kind);
        const reply = await child.ask({ op: 'info', kind });
        if (reply.ok !== true) {
          throw new Error(`CAP could not be started in ${app}: ${describeFailure(reply.error as KitError)}`);
        }
        const info = reply.info as Info;
        if (!info.known) {
          throw new Error(
            `${kind} is not a known kind in ${app}. ` +
              `Is the provider package installed there, with a cds-plugin.js and the kind in the cds section of its package.json? ` +
              `Known kinds: ${info.kinds.join(', ')}`,
          );
        }
        context = { options: normalized, server, child, info, app: normalized.appDir ? undefined : app };
      } catch (error) {
        await child?.close();
        await server?.close();
        if (app && !normalized.appDir) fs.rmSync(app, { recursive: true, force: true });
        throw error;
      }
    });

    after(async () => {
      if (!context) return;
      await context.child.close();
      await context.server.close();
      if (context.app) fs.rmSync(context.app, { recursive: true, force: true });
    });

    // The settings of the kind as they apply: the resolved kind, then the options of the test.
    const effective = () => {
      const { info, options: given } = ctx();
      return {
        modelId: (given.settings.modelId as string | undefined) ?? info.modelId,
        requiresToken: (given.settings.requiresToken as boolean | undefined) ?? info.requiresToken,
        limits: (given.settings.limits as ProviderLimits | undefined) ?? info.limits,
      };
    };
    const token = (): string | undefined =>
      ctx().options.credentials.token ?? (effective().requiresToken ? TEST_TOKEN : undefined);

    interface Variation {
      url?: string;
      withoutToken?: boolean;
      timeoutMs?: number;
    }
    const connectOptions = (variation: Variation = {}) => {
      const { options: given, server } = ctx();
      const credentials: Record<string, string | undefined> = {
        ...given.credentials,
        url: variation.url ?? server.url,
        token: variation.withoutToken ? undefined : token(),
      };
      return {
        ...given.settings,
        credentials,
        ...(variation.timeoutMs === undefined ? {} : { timeoutMs: variation.timeoutMs }),
      };
    };
    const connect = async (variation?: Variation): Promise<Outcome> => {
      const reply = await ctx().child.ask({ op: 'connect', options: connectOptions(variation) });
      return reply as unknown as Outcome;
    };
    const decide = async (decision: DecisionRequest, variation?: Variation): Promise<Outcome> => {
      const reply = await ctx().child.ask({ op: 'decide', options: connectOptions(variation), request: decision });
      return reply as unknown as Outcome;
    };

    // Answers every request with a valid decision in the provider's wire format.
    const answering: Handler = (_request, response, body) => {
      try {
        sendJson(response, 200, ctx().options.encode(respondTo(body as DecisionRequest), body as DecisionRequest));
      } catch (error) {
        sendJson(response, 500, { message: String(error) });
      }
    };
    const serve = (handler: Handler = answering) => ctx().server.reset(handler);

    const succeeded = (outcome: Outcome, what: string): DecisionResult => {
      if (!outcome.ok)
        assert.fail(`${what}: expected the decision to succeed, but it failed with ${describeFailure(outcome.error)}`);
      return outcome.result;
    };
    const failed = (outcome: Outcome, code: string, what: string): KitError => {
      if (outcome.ok) assert.fail(`${what}: expected ${code}, but the decision succeeded`);
      assert.equal(outcome.error.code, code, `${what}: expected ${code}, but got ${describeFailure(outcome.error)}`);
      return outcome.error;
    };
    const requests = () => ctx().server.received;
    const skipUnless = (t: TestContext, condition: unknown, reason: string): boolean => {
      if (!condition) t.skip(reason);
      return !!condition;
    };

    const levels = (): number => {
      const { scoreCriteria } = effective().limits;
      return Math.min(Math.max(3, scoreCriteria?.min ?? 1), scoreCriteria?.max ?? Number.MAX_SAFE_INTEGER);
    };
    const options3 = (): number => Math.min(3, effective().limits.choiceOptions ?? 3);

    test("connects with the kind's settings", { timeout: TEST_TIMEOUT }, async () => {
      serve();
      const outcome = await connect();
      if (!outcome.ok) {
        assert.fail(
          `${kind} could not be connected with the kit's settings: ${describeFailure(outcome.error)}. ` +
            'Extra credentials of the provider belong in the credentials option and must be listed in credentialKeys',
        );
      }
    });

    test('a noul answer comes back typed', { timeout: TEST_TIMEOUT }, async () => {
      serve();
      const result = succeeded(await decide(request({ q: noulQuestion() })), 'a noul question');
      const answer = result.answers.q as unknown as Record<string, unknown>;
      assert.equal(answer?.type, 'noul', 'the answer of a noul question has type noul');
      assert.equal(answer.noul, NOUL, 'the noul value of the server comes back unchanged');
      assert.equal(typeof result.model, 'string');
      assert.equal(typeof result.usage.input_tokens, 'number');
    });

    test('a choice answer comes back typed', { timeout: TEST_TIMEOUT }, async () => {
      serve();
      const count = options3();
      const result = succeeded(await decide(request({ q: choiceQuestion(count) })), 'a choice question');
      const answer = result.answers.q as unknown as Record<string, unknown>;
      assert.equal(answer?.type, 'choice', 'the answer of a choice question has type choice');
      assert.equal(answer.choice, labels(count).at(-1), 'the choice of the server comes back unchanged');
      assert.equal(typeof answer.confidence, 'number');
      assert.deepEqual(Object.keys(answer.probabilities as object).sort(), labels(count).sort());
    });

    test('a score answer comes back typed', { timeout: TEST_TIMEOUT }, async () => {
      serve();
      const count = levels();
      const result = succeeded(await decide(request({ q: scoreQuestion(count) })), 'a score question');
      const answer = result.answers.q as unknown as Record<string, unknown>;
      assert.equal(answer?.type, 'score', 'the answer of a score question has type score');
      assert.equal(answer.score, SCORE, 'the score of the server comes back unchanged');
      assert.equal(Object.keys(answer.legend as object).length, count);
    });

    test('several questions in one request come back under their ids', { timeout: TEST_TIMEOUT }, async (t) => {
      const limit = effective().limits.questions;
      if (!skipUnless(t, limit === undefined || limit >= 2, 'the kind allows only one question')) return;
      serve();
      const questions: Record<string, Question> = {
        first: noulQuestion(),
        second: choiceQuestion(options3()),
        third: scoreQuestion(levels()),
        fourth: noulQuestion(),
      };
      for (const id of Object.keys(questions).slice(Math.min(4, limit ?? 4))) delete questions[id];
      const result = succeeded(await decide(request(questions)), 'a request with several questions');
      assert.deepEqual(Object.keys(result.answers).sort(), Object.keys(questions).sort());
      for (const [id, question] of Object.entries(questions)) {
        assert.equal((result.answers[id] as { type: string }).type, question.type, `the answer to ${id}`);
      }
      const sent = requests()[0]?.body as { questions?: Record<string, unknown> } | undefined;
      assert.deepEqual(Object.keys(sent?.questions ?? {}).sort(), Object.keys(questions).sort(), 'the questions sent');
    });

    test("sends the kind's modelId as model", { timeout: TEST_TIMEOUT }, async (t) => {
      const { modelId } = effective();
      if (!skipUnless(t, modelId, 'the kind has no modelId')) return;
      serve();
      succeeded(await decide(request({ q: noulQuestion() })), 'a noul question');
      assert.equal((requests()[0]?.body as { model?: string }).model, modelId, 'the model in the request');
    });

    const limitChecks: {
      name: string;
      limit: (limits: ProviderLimits) => number | undefined;
      /** The count one beyond the limit and the count at it. */
      counts: (limit: number) => [number, number];
      build: (count: number) => DecisionRequest;
    }[] = [
      {
        name: 'limits.questions',
        limit: (limits) => limits.questions,
        counts: (limit) => [limit + 1, limit],
        build: (count) =>
          request(Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, noulQuestion()]))),
      },
      {
        name: 'limits.choiceOptions',
        limit: (limits) => limits.choiceOptions,
        counts: (limit) => [limit + 1, limit],
        build: (count) => request({ q: choiceQuestion(count) }),
      },
      {
        name: 'limits.scoreCriteria.max',
        limit: (limits) => limits.scoreCriteria?.max,
        counts: (limit) => [limit + 1, limit],
        build: (count) => request({ q: scoreQuestion(count) }),
      },
      {
        name: 'limits.scoreCriteria.min',
        limit: (limits) =>
          limits.scoreCriteria?.min && limits.scoreCriteria.min > 1 ? limits.scoreCriteria.min : undefined,
        counts: (limit) => [limit - 1, limit],
        build: (count) => request({ q: scoreQuestion(count) }),
      },
    ];

    for (const check of limitChecks) {
      test(
        `${check.name}: a request at the limit is sent, one beyond it is rejected before it is sent`,
        { timeout: TEST_TIMEOUT },
        async (t) => {
          const limit = check.limit(effective().limits);
          if (!skipUnless(t, limit !== undefined, `the kind sets no ${check.name}`)) return;
          const [beyond, at] = check.counts(limit as number);
          serve();
          failed(
            await decide(check.build(beyond)),
            'INVALID_REQUEST',
            `${check.name}: ${beyond} against a limit of ${limit}`,
          );
          assert.equal(requests().length, 0, `${check.name}: the request beyond the limit reached the server`);
          succeeded(await decide(check.build(at)), `${check.name}: ${at} against a limit of ${limit}`);
          assert.equal(requests().length, 1, `${check.name}: the request at the limit did not reach the server`);
        },
      );
    }

    test('a missing token is INVALID_CONFIG and sends nothing', { timeout: TEST_TIMEOUT }, async (t) => {
      if (!skipUnless(t, effective().requiresToken, 'the kind does not require a token')) return;
      serve();
      failed(await decide(request({ q: noulQuestion() }), { withoutToken: true }), 'INVALID_CONFIG', 'no token');
      assert.equal(requests().length, 0, 'a request was sent without a token');
    });

    test('sends the token as a bearer header', { timeout: TEST_TIMEOUT }, async (t) => {
      const secret = token();
      if (!skipUnless(t, secret, 'the kind has no token')) return;
      serve();
      succeeded(await decide(request({ q: noulQuestion() })), 'a noul question');
      assert.equal(requests()[0]?.headers.authorization, `Bearer ${secret}`, 'the authorization header');
    });

    test('an error response is HTTP_ERROR with its status and providerCode', { timeout: TEST_TIMEOUT }, async () => {
      const code = 'cap_jev_test_error';
      const wire = ctx().options.encodeError({
        code,
        status: 400,
        message: `rejected the key ${token() ?? 'without a token'}`,
      });
      serve((_request, response) => sendJson(response, wire.status, wire.body));
      const error = failed(
        await decide(request({ q: noulQuestion() })),
        'HTTP_ERROR',
        `an HTTP ${wire.status} response`,
      );
      assert.equal(error.status, wire.status, 'the status of the error');
      assert.equal(error.providerCode, code, 'the providerCode of the error (does encodeError carry the code?)');
      const secret = token();
      if (secret) assert.equal(error.message.includes(secret), false, 'the token is in the error message');
      assert.equal(requests().length, 1, `HTTP ${wire.status} was retried`);
    });

    test('a 503 is retried', { timeout: TEST_TIMEOUT }, async () => {
      serve((request_, response, body) => {
        if (requests().length === 1) {
          const wire = ctx().options.encodeError({ code: 'unavailable', status: 503, message: 'try again' });
          sendJson(response, wire.status, wire.body, { 'retry-after': '0' });
        } else {
          answering(request_, response, body);
        }
      });
      succeeded(await decide(request({ q: noulQuestion() })), 'a request after a 503');
      assert.equal(requests().length, 2, 'the request was sent again after the 503');
    });

    test('a body that is not JSON is INVALID_RESPONSE', { timeout: TEST_TIMEOUT }, async () => {
      serve((_request, response) => sendJson(response, 200, 'this is not json'));
      failed(await decide(request({ q: noulQuestion() })), 'INVALID_RESPONSE', 'a body that is not JSON');
    });

    test('a decision that does not match the questions is INVALID_RESPONSE', { timeout: TEST_TIMEOUT }, async () => {
      serve((_request, response, body) => {
        const mismatch = { model: 'cap-jev-test-model', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
        sendJson(response, 200, ctx().options.encode(mismatch as unknown as DecisionResult, body as DecisionRequest));
      });
      failed(await decide(request({ q: noulQuestion() })), 'INVALID_RESPONSE', 'a decision without the answers');
    });

    test('a closed port is NETWORK_ERROR', { timeout: TEST_TIMEOUT }, async () => {
      serve();
      const url = await closedUrl();
      failed(
        await decide(request({ q: noulQuestion() }), { url, timeoutMs: 10_000 }),
        'NETWORK_ERROR',
        'a closed port',
      );
    });

    test('a server that does not answer is TIMEOUT', { timeout: TEST_TIMEOUT }, async () => {
      serve(() => undefined);
      failed(
        await decide(request({ q: noulQuestion() }), { timeoutMs: 300 }),
        'TIMEOUT',
        'a server that never answers',
      );
    });
  });
}
