/**
 * The acceptance harness of docs/M1ReleasePlan.md R2.2. It runs one fixed task through the whole
 * product chain the `multiagentos analyze` entry builds: the CLI parser, the composition root
 * with every product part, the real Kernel, Workflow, UserInteraction and ExecutorSet. Offline,
 * only the provider's HTTP API is replaced by a script. The harness prepares the repository,
 * compares its snapshot digest before and after, and judges the run by the task's assertions.
 */
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
  modelCallCost,
} from '@multiagentos/agent-tool-pool';
import { parseCli, runParsedCli } from '@multiagentos/cli';
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
import { createWorkflow, type WorkflowDeps, type WorkflowModule } from '@multiagentos/workflow';
import { createFakeTerminal } from '@multiagentos/testing';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { credentialsFrom } from '../../src/index.js';
import { recordingProvider, scriptedProvider, type ProviderLog } from './scripted-provider.js';
import type { AcceptanceTask, ExpectedSource } from './tasks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOS_DIRECTORY = join(HERE, 'repos');
/** A fixture file named `dot.<name>` becomes `.<name>`, so no real dotfile is committed. */
const DOT_PREFIX = 'dot.';
/** The key an offline run hands to the model-call Executor; it must never appear anywhere. */
export const OFFLINE_API_KEY = 'sk-acceptance-offline-key-0000';

export type RunMode =
  { readonly kind: 'offline' } | { readonly kind: 'real'; readonly env: NodeJS.ProcessEnv };

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

/** The run record of M1ReleasePlan 2.4 rule 5. */
export interface RunRecord {
  readonly taskId: string;
  readonly mode: RunMode['kind'];
  readonly commit: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly closeReason?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly definitions: readonly { id: string; version: string; digest: string }[];
  readonly config: { readonly portReturnTimeoutMs: number; readonly budget: unknown };
  readonly tokens?: RunSummary['tokens'];
  readonly modelRequests?: number;
  /** Upper bound: cache hits are not reported per run, so all input is priced as misses. */
  readonly costMicroUsd?: number;
}

export interface TaskResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly record: RunRecord;
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

async function headCommit(): Promise<string> {
  try {
    let directory = HERE;
    while (!(await stat(join(directory, '.git')).catch(() => undefined))) {
      const parent = dirname(directory);
      if (parent === directory) return 'unknown';
      directory = parent;
    }
    const head = (await readFile(join(directory, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    try {
      return (await readFile(join(directory, '.git', ref), 'utf8')).trim();
    } catch {
      const packed = await readFile(join(directory, '.git', 'packed-refs'), 'utf8');
      return (
        packed
          .split('\n')
          .find((line) => line.endsWith(` ${ref}`))
          ?.split(' ')[0] ?? 'unknown'
      );
    }
  } catch {
    return 'unknown';
  }
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

/** The product Workflow, with its Gateway calls and Inbox events written to `trace`. */
function tracedWorkflow(trace: (line: string) => void): (deps: WorkflowDeps) => WorkflowModule {
  return (deps) => {
    const traced =
      <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const result = await call(...args);
        const outcome = (result as { outcome?: string; reasonCode?: string }) ?? {};
        trace(`workflow ${name} -> ${outcome.outcome ?? '?'} ${outcome.reasonCode ?? ''}`);
        return result;
      };
    const gateway = deps.gateway;
    const module = createWorkflow({
      ...deps,
      gateway: {
        registerAgentRun: traced('registerAgentRun', gateway.registerAgentRun.bind(gateway)),
        submitUnit: traced('submitUnit', gateway.submitUnit.bind(gateway)),
        endAgentRun: traced('endAgentRun', gateway.endAgentRun.bind(gateway)),
        closeRun: traced('closeRun', gateway.closeRun.bind(gateway)),
      },
    });
    return {
      ...module,
      manifest: module.manifest,
      start: () => module.start(),
      stop: () => module.stop(),
      health: () => module.health(),
      inbox: {
        deliver: (envelope) => {
          const event = envelope.event;
          trace(
            `workflow inbox ${event.type}${event.type === 'UnitReport' ? ` ${event.executionKind} ${event.status}` : ''}`,
          );
          return module.inbox.deliver(envelope);
        },
      },
    };
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

/** Every artifact of the run that is a valid report or run summary. */
async function runArtifacts(
  dataDir: string,
): Promise<{ report?: AnalysisReport; summary?: RunSummary }> {
  const found: { report?: AnalysisReport; summary?: RunSummary } = {};
  const runs = await readdir(join(dataDir, 'runs')).catch(() => [] as string[]);
  for (const run of runs) {
    const directory = join(dataDir, 'runs', run, 'artifacts');
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
  }
  return found;
}

/**
 * Runs `task` once and judges it. A real run needs `DEEPSEEK_API_KEY` in `mode.env` and costs
 * money; an offline run uses no network at all.
 */
export async function runTask(
  task: AcceptanceTask,
  mode: RunMode = { kind: 'offline' },
  options: RunOptions = {},
): Promise<TaskResult> {
  const root = await mkdtemp(join(tmpdir(), `acceptance-${task.id}-`));
  try {
    return await runIn(root, task, mode, options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runIn(
  root: string,
  task: AcceptanceTask,
  mode: RunMode,
  options: RunOptions,
): Promise<TaskResult> {
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  await prepareRepository(task.repo, repository);
  await task.prepare?.(repository);
  const before = await workspaceDigest(repository);

  const credentials =
    mode.kind === 'offline' ? { apiKeyFor: () => OFFLINE_API_KEY } : credentialsFrom(mode.env);
  const apiKey = credentials.apiKeyFor('deepseek');
  const secrets = await secretsOf(repository, apiKey);
  const provider: { fetch: typeof globalThis.fetch; log: ProviderLog } =
    mode.kind === 'offline'
      ? scriptedProvider(task.script, options.trace)
      : recordingProvider(globalThis.fetch);
  const calls: ExecutorCall[] = [];
  const terminal = createFakeTerminal('YES');
  const config = { ...defaultSystemConfig(), dataDir };
  const startedAt = new Date();
  const failures: string[] = [];

  // The model-call Executor takes `fetch` when the registry is built (ExecutorSet 4.5).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  let exitCode: number;
  try {
    const parsed = await parseCli(['analyze', '--repo', repository, task.question], terminal);
    if (!parsed.ok) throw new Error(`the CLI refused the task: exit code ${parsed.exitCode}`);
    const system = await composeSystem({
      config,
      terminal,
      credentials,
      log: (line) => terminal.write(line),
      parts: {
        createExecutorRegistry: () => observedRegistry(calls, options.trace),
        ...(options.trace === undefined ? {} : { createWorkflow: tracedWorkflow(options.trace) }),
      },
    });
    await system.start();
    exitCode = await system.run((userInteraction) => runParsedCli(parsed.command, userInteraction));
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
    for (const expected of task.expectedSources)
      if (!cited.some((source) => overlaps(source, expected)))
        failures.push(
          `no conclusion cites ${expected.path}:${expected.startLine}-${expected.endLine}`,
        );
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
  if (mode.kind === 'offline') {
    failures.push(...provider.log.problems);
    if (provider.log.remainingTurns() > 0)
      failures.push(`${provider.log.remainingTurns()} scripted turn(s) were not used`);
  }

  const record = await recordOf(task, mode, startedAt, durationMs, exitCode, config, summary);
  return {
    passed: failures.length === 0,
    failures,
    record,
    ...(report === undefined ? {} : { report }),
    ...(summary === undefined ? {} : { summary }),
    calls,
    output,
  };
}

async function recordOf(
  task: AcceptanceTask,
  mode: RunMode,
  startedAt: Date,
  durationMs: number,
  exitCode: number,
  config: ReturnType<typeof defaultSystemConfig>,
  summary: RunSummary | undefined,
): Promise<RunRecord> {
  const catalog = await DefinitionCatalog.load(
    new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
  );
  const definitions = (summary?.agentRuns ?? []).map((run) => ({
    id: run.agentRef.id,
    version: run.agentRef.version,
    digest: run.agentRef.digest,
  }));
  let provider: string | undefined;
  let model: string | undefined;
  let costMicroUsd: number | undefined;
  const agent = summary?.agentRuns[0]?.agentRef;
  if (agent !== undefined) {
    const pinned = await catalog.pinAgent(
      { id: agent.id, version: agent.version },
      {
        correlationId: 'cor_acceptance',
        tenantId: 'local',
        projectId: 'local',
      },
    );
    if (pinned.ok) {
      const definition = pinned.value.model;
      provider = definition.provider;
      model = `${definition.id}@${definition.version}`;
      if (summary !== undefined && mode.kind === 'real')
        costMicroUsd = modelCallCost(
          definition,
          { inputTokens: summary.tokens.inputTokens, outputTokens: summary.tokens.outputTokens },
          startedAt,
        ).microUsd;
    }
  }
  return {
    taskId: task.id,
    mode: mode.kind,
    commit: await headCommit(),
    startedAt: startedAt.toISOString(),
    durationMs,
    exitCode,
    ...(summary === undefined ? {} : { closeReason: summary.closeReason }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    definitions,
    config: { portReturnTimeoutMs: config.portReturnTimeoutMs, budget: config.kernel.budget },
    ...(summary === undefined
      ? {}
      : { tokens: summary.tokens, modelRequests: summary.model.requests }),
    ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
  };
}
