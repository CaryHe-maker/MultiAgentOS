/**
 * The acceptance harness. It runs one fixed task through the
 * whole product chain `mas run analyze` builds: the CLI parser, the composition root, the real
 * Kernel, Workflow, console and ExecutorSet. Offline, only the provider's HTTP API is replaced by
 * a script. The harness prepares the repository, compares its digest before and after, answers
 * every question with yes, and judges the run by the task's assertions.
 */
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli, runCommand, type Terminal } from '@multiagentos/cli';
import {
  AnalysisReportSchema,
  RunSummarySchema,
  validate,
  type AnalysisReport,
  type ExecutorOutcome,
  type ExecutorRegistry,
  type RunSummary,
} from '@multiagentos/contracts';
import { createExecutorRegistry } from '@multiagentos/executor-set';
import type { Console, ConsoleView } from '@multiagentos/user-interaction';
import { composeSystem } from '../../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../../src/config/system-config.js';
import { scriptedProvider, type ProviderLog } from './scripted-provider.js';
import type { AcceptanceTask, ExpectedSource } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOS_DIRECTORY = join(HERE, 'repos');
/** A fixture file named `dot.<name>` becomes `.<name>`, so no real dotfile is committed. */
const DOT_PREFIX = 'dot.';
/** The key an offline run hands to the model-call Executor; it must never appear anywhere. */
export const OFFLINE_API_KEY = 'sk-acceptance-offline-key-0000';

export interface RunOptions {
  /** Receives one line per Executor call and per provider turn while the run goes on. */
  readonly trace?: (line: string) => void;
}

/** One Executor call the run made, as the harness observed it at the registry. */
export interface ExecutorCall {
  readonly kind: keyof ExecutorRegistry;
  readonly input: unknown;
  readonly outcome: string;
}

export interface TaskResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly exitCode: number;
  readonly closeReason?: string;
  readonly report?: AnalysisReport;
  readonly summary?: RunSummary;
  readonly calls: readonly ExecutorCall[];
  readonly output: string;
}

/** SHA-256 over every entry of the tree: relative path, kind, size and content. */
export async function workspaceDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        hash.update(`d ${name}\n`);
        await walk(path);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        hash.update(`f ${name} ${content.length}\n`).update(content);
      } else hash.update(`o ${name}\n`);
    }
  };
  await walk(root);
  return hash.digest('hex');
}

/** Copies a fixture repository and restores its dotfiles; the product never calls git. */
export async function prepareRepository(repo: string, target: string): Promise<void> {
  await cp(join(REPOS_DIRECTORY, repo), target, { recursive: true });
  const restore = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await restore(path);
      else if (entry.name.startsWith(DOT_PREFIX))
        await rename(path, join(directory, '.' + entry.name.slice(DOT_PREFIX.length)));
    }
  };
  await restore(target);
}

/** Values the run must never expose: the API key and every value of the repository's `.env`. */
async function secretsOf(repository: string, apiKey: string | undefined): Promise<string[]> {
  const secrets = apiKey === undefined || apiKey === '' ? [] : [apiKey];
  try {
    for (const line of (await readFile(join(repository, '.env'), 'utf8')).split('\n')) {
      const value = /^[A-Z_]+=(.+)$/.exec(line.trim())?.[1];
      if (value !== undefined) secrets.push(value);
    }
  } catch {
    // A repository without `.env` adds no secret.
  }
  return secrets;
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  return found;
}

/** The product registry, with every call recorded on its way through. */
function observedRegistry(calls: ExecutorCall[], trace?: (line: string) => void): ExecutorRegistry {
  type Untyped = {
    readonly executionKind: string;
    execute(input: unknown, environment: unknown): Promise<ExecutorOutcome>;
  };
  const registry = createExecutorRegistry();
  const observed = Object.fromEntries(
    (Object.keys(registry) as (keyof ExecutorRegistry)[]).map((kind) => {
      const executor = registry[kind] as unknown as Untyped;
      const wrapped: Untyped = {
        executionKind: executor.executionKind,
        execute: async (input, environment) => {
          trace?.(`${kind} begins`);
          const outcome = await executor.execute(input, environment);
          calls.push({ kind, input, outcome: outcome.outcome });
          trace?.(`${kind} ${JSON.stringify(input).slice(0, 160)} -> ${outcome.outcome}`);
          return outcome;
        },
      };
      return [kind, wrapped];
    }),
  );
  return observed as unknown as ExecutorRegistry;
}

/**
 * A terminal that writes the transcript to `written` and answers every question the console
 * asks with yes, as a user who allows the repository and trusts its instructions would.
 */
export function answeringTerminal(): Terminal & { readonly written: string[] } {
  const written: string[] = [];
  let console: Pick<Console, 'submit'> | undefined;
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => {
      written.push(`${record.kind}: ${record.text}\n`);
    },
    update: (live) => {
      const question = live.pending?.text;
      if (question !== undefined && question !== asked && console !== undefined) {
        written.push(`QUESTION: ${question}\n`);
        void console.submit('y');
      }
      asked = question;
    },
    restoreInput: () => undefined,
  };
  return {
    view,
    written,
    attach: (input) => {
      console = input;
      return () => {
        console = undefined;
      };
    },
  };
}

const matchesForbidden = (path: string, forbidden: readonly string[]) =>
  forbidden.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry || path.endsWith(`/${entry}`),
  );

const overlaps = (
  source: { path: string; startLine: number; endLine: number },
  expected: ExpectedSource,
) =>
  source.path === expected.path &&
  source.startLine <= expected.endLine &&
  expected.startLine <= source.endLine;

/** The expected sources no cited source overlaps; a list counts as cited when one range is. */
export function uncitedSources(
  cited: readonly { path: string; startLine: number; endLine: number }[],
  expectedSources: AcceptanceTask['expectedSources'],
): string[] {
  const label = (range: ExpectedSource) => `${range.path}:${range.startLine}-${range.endLine}`;
  return expectedSources.flatMap((entry) => {
    const ranges: readonly ExpectedSource[] = 'path' in entry ? [entry] : entry;
    return cited.some((source) => ranges.some((range) => overlaps(source, range)))
      ? []
      : [ranges.map(label).join(' or ')];
  });
}

/** Every artifact of the run that is a valid report or run summary. */
async function runArtifacts(
  dataDir: string,
): Promise<{ report?: AnalysisReport; summary?: RunSummary }> {
  const found: { report?: AnalysisReport; summary?: RunSummary } = {};
  const directory = join(dataDir, 'artifacts');
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    const report = validate<AnalysisReport>(AnalysisReportSchema, value);
    if (report.ok) found.report = report.value;
    const summary = validate<RunSummary>(RunSummarySchema, value);
    if (summary.ok) found.summary = summary.value;
  }
  return found;
}

/**
 * Runs `task` once and judges it. The run uses no network at all: the provider is a script.
 */
export async function runTask(task: AcceptanceTask, options: RunOptions = {}): Promise<TaskResult> {
  const root = await mkdtemp(join(tmpdir(), `acceptance-${task.id}-`));
  try {
    return await runIn(root, task, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runIn(root: string, task: AcceptanceTask, options: RunOptions): Promise<TaskResult> {
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  await prepareRepository(task.repo, repository);
  await task.prepare?.(repository);
  const before = await workspaceDigest(repository);

  const credentials = { apiKeyFor: () => OFFLINE_API_KEY };
  const apiKey = OFFLINE_API_KEY;
  const secrets = await secretsOf(repository, apiKey);
  const provider: { fetch: typeof globalThis.fetch; log: ProviderLog } = scriptedProvider(
    task.script,
    options.trace,
  );
  const calls: ExecutorCall[] = [];
  const terminal = answeringTerminal();
  const config = { ...defaultSystemConfig(), dataDir };
  const startedAt = new Date();
  const failures: string[] = [];

  // The model-call Executor takes `fetch` when the registry is built.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  let exitCode: number;
  try {
    const parsed = await parseCli(
      ['run', '--repo', repository, 'analyze', task.question],
      (text) => void terminal.written.push(text),
    );
    if (!parsed.ok) throw new Error(`the CLI refused the task: exit code ${parsed.exitCode}`);
    const { command } = parsed;
    const system = await composeSystem({
      config,
      repositoryRoot: await realpath(repository),
      preset: 'standard',
      view: terminal.view,
      credentials,
      executors: observedRegistry(calls, options.trace),
      log: (line) => void terminal.written.push(line),
    });
    await system.start();
    const template = system.templateRef('analyze');
    exitCode = await system.run((console) => runCommand(command, console, terminal, template));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const durationMs = Date.now() - startedAt.getTime();
  const output = terminal.written.join('');

  if ((await workspaceDigest(repository)) !== before)
    failures.push('the repository changed during the run');
  const { report, summary } = await runArtifacts(dataDir);

  // Explainable terminal state, with a report whose every conclusion has a read source.
  const expected = { exitCode: 0, closeReason: 'COMPLETED', degraded: false, ...task.expect };
  if (exitCode !== expected.exitCode)
    failures.push(`exit code ${exitCode}, expected ${expected.exitCode}`);
  if (summary === undefined) failures.push('no valid RunSummary was written');
  else if (summary.closeReason !== expected.closeReason)
    failures.push(`the run closed as ${summary.closeReason}, expected ${expected.closeReason}`);
  if (report === undefined) failures.push('no valid AnalysisReport was written');
  else if (report.degraded !== expected.degraded)
    failures.push(report.degraded ? 'the report is degraded' : 'the report is not degraded');
  else if (!report.degraded) {
    if (report.conclusions.length === 0) failures.push('the report has no conclusion');
    const cited = report.conclusions.flatMap((conclusion) => conclusion.sources);
    for (const missing of uncitedSources(cited, task.expectedSources))
      failures.push(`no conclusion cites ${missing}`);
    for (const source of cited)
      if (matchesForbidden(source.path, task.forbiddenPaths))
        failures.push(`a conclusion cites the forbidden path ${source.path}`);
  }

  // Forbidden paths are never read; the run searches as often as the task requires.
  for (const call of calls)
    if (call.kind === 'FILE_READ' && call.outcome === 'COMPLETED') {
      const path = (call.input as { path?: string }).path ?? '';
      if (matchesForbidden(path, task.forbiddenPaths))
        failures.push(`the forbidden path ${path} was read`);
    }
  const searches = calls.filter((call) => call.kind === 'REPOSITORY_SEARCH').length;
  if (task.minSearches !== undefined && searches < task.minSearches)
    failures.push(`${searches} search(es), expected at least ${task.minSearches}`);

  // No secret in what the model saw, in anything the system stored, or on the terminal.
  const stored = await Promise.all(
    (await filesUnder(dataDir)).map(async (path) => readFile(path, 'utf8').catch(() => '')),
  );
  for (const secret of secrets) {
    if (provider.log.bodies.some((body) => body.includes(secret)))
      failures.push('a secret reached a model request');
    if (stored.some((text) => text.includes(secret)))
      failures.push('a secret reached stored run data');
    if (output.includes(secret)) failures.push('a secret reached the terminal');
  }
  failures.push(
    ...(task.check?.({
      calls,
      output,
      modelRequests: provider.log.bodies,
      stored,
      durationMs,
      ...(report === undefined ? {} : { report }),
      ...(summary === undefined ? {} : { summary }),
    }) ?? []),
  );
  failures.push(...provider.log.problems);
  if (provider.log.remainingTurns() > 0)
    failures.push(`${provider.log.remainingTurns()} scripted turn(s) were not used`);

  return {
    passed: failures.length === 0,
    failures,
    exitCode,
    ...(summary === undefined ? {} : { closeReason: summary.closeReason }),
    ...(report === undefined ? {} : { report }),
    ...(summary === undefined ? {} : { summary }),
    calls,
    output,
  };
}
