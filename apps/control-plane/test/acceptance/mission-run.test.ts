/**
 * `mas run "<goal>"` as a long task (Orchestration 10.1): the built-in template `mission`, whose
 * owner main plans, splits the work among leads and workers, sleeps while they work, checks what
 * comes back and delivers, with no conversation in between. The whole product runs from the CLI
 * down to the Executors; only the provider is scripted, per Agent and per task.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCli, runCommand } from '@multiagentos/cli';
import { probeSandbox } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { answeringTerminal } from '../system/analyze-template/harness.js';
import { scriptedAgents, textOf, tool, type ScriptedChat } from './chat-driver.js';

const TIMEOUT = 120_000;
const OFFLINE_KEY = 'sk-acceptance-offline-key-0000';
const bwrapWorks = (await probeSandbox(tmpdir())).available;
const real = bwrapWorks ? describe : describe.skip;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Ran {
  readonly exitCode: number;
  readonly output: string;
  readonly repository: string;
}

/** `mas run` with the arguments given, in a fresh repository, as the CLI starts it. */
async function masRun(
  args: readonly string[],
  provider: ScriptedChat,
  files: Readonly<Record<string, string>> = {},
): Promise<Ran> {
  const root = await mkdtemp(join(tmpdir(), 'mas-mission-'));
  directories.push(root);
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const terminal = answeringTerminal();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  try {
    const parsed = await parseCli(['run', '--repo', repository, ...args], (text) => {
      terminal.written.push(text);
    });
    if (!parsed.ok || parsed.command.kind !== 'RUN') throw new Error('the CLI refused the run');
    const { command } = parsed;
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      repositoryRoot: await realpath(repository),
      preset: 'standard',
      view: terminal.view,
      credentials: { apiKeyFor: () => OFFLINE_KEY },
      log: (line) => void terminal.written.push(line),
    });
    await system.start();
    const template = system.templateRef(command.template);
    const exitCode = await system.run((console) =>
      runCommand(command, console, terminal, template),
    );
    return { exitCode, output: terminal.written.join(''), repository };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const seen = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
// The root of a long task writes the plan with its first subtasks (Orchestration 5.3, D24).
const spawn = (...tasks: Record<string, unknown>[]) =>
  tool('run_subagents', { tasks, plan: 'Deliver the goal; each task owns its scope.' });
const sleepForChildren = () => tool('sleep', { until: [{ kind: 'children', mode: 'all' }] });
const finishWork = (summary: string, changedFiles: string[]) =>
  tool('finish_subagent', { summary, changedFiles, status: 'done', validation: [] });

describe('mas run "<goal>": a long task of the template mission (Orchestration 10.1)', () => {
  it(
    'takes a goal alone as the template mission, and main delivers without a conversation',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('write_file', { path: 'PLAN.md', content: '# plan\n- answer directly\n' }),
          tool('reply', { text: 'delivered: the plan is in PLAN.md' }),
        ],
      });
      const ran = await masRun(['write a plan'], provider);
      expect(ran.exitCode).toBe(0);
      expect(await readFile(join(ran.repository, 'PLAN.md'), 'utf8')).toContain('# plan');
      expect(ran.output).toContain('delivered: the plan is in PLAN.md');
      // The goal reached main with the template's own guidance.
      expect(seen(provider)).toContain('write a plan');
      expect(seen(provider)).toContain('You own this goal from start to delivery');
    },
    TIMEOUT,
  );

  it(
    'asks the root for the plan before its first subtasks, and shows the plan to every task',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              tasks: [{ name: 'look', agent: 'explorer', goal: 'look at the code' }],
            }),
            tool('run_subagents', {
              tasks: [{ name: 'look', agent: 'explorer', goal: 'look at the code' }],
              plan: 'PLAN-7: deliver a summary; look owns the reading.',
            }),
            sleepForChildren(),
            tool('reply', { text: 'delivered with a plan' }),
          ],
        },
        { look: [tool('finish_subagent', { summary: 'looked' })] },
      );
      const ran = await masRun(['summarise the code'], provider);
      expect(ran.output).toContain('delivered with a plan');
      expect(seen(provider)).toContain('Not started: write the plan of the work first');
      const look = provider.requests
        .filter((request) =>
          request.messages.some((message) => textOf(message).includes('Your task (look,')),
        )
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      expect(look).toContain('The plan of this work, written by the root task');
      expect(look).toContain('PLAN-7: deliver a summary');
    },
    TIMEOUT,
  );

  it(
    'does not end the run while a subtask sleeps on its timer: main is woken and delivers',
    async () => {
      // Seen on the real model: the docs task waits for its siblings with a timer; the others end,
      // nothing is ready and no AgentRun works, yet the run must wait for the timer, not close.
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'code', agent: 'explorer', goal: 'look at the code' },
              { name: 'docs', agent: 'explorer', goal: 'wait a little, then look at the docs' },
            ),
            sleepForChildren(),
            tool('reply', { text: 'delivered after both ended' }),
          ],
        },
        {
          code: [tool('finish_subagent', { summary: 'the code is fine' })],
          docs: [
            tool('sleep', { until: [{ kind: 'timer', seconds: 2 }] }),
            tool('finish_subagent', { summary: 'the docs are fine' }),
          ],
        },
      );
      const ran = await masRun(['look at code and docs'], provider);
      expect(ran.output).toContain('delivered after both ended');
      expect(ran.exitCode).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'exits non-zero when main can no longer reach the model and so never delivers',
    async () => {
      // After its first call every request fails, as when the provider is down.
      const provider = scriptedAgents({
        main: [tool('write_file', { path: 'PLAN.md', content: '# plan\n' })],
      });
      const ran = await masRun(['write a plan'], provider);
      expect(ran.exitCode).not.toBe(0);
    },
    TIMEOUT,
  );
});

real('a project as a long task: parts in parallel, a lead with its own worker', () => {
  it(
    'splits the work, runs the parts at once, gathers them, and delivers the result',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('write_file', {
              path: 'PLAN.md',
              content: '# plan\n- server: a lead\n- docs: a worker\n',
            }),
            spawn(
              {
                name: 'server',
                agent: 'lead',
                goal: 'build the server part',
                writeScope: ['server'],
                acceptance: ['the store exists'],
              },
              { name: 'docs', agent: 'worker', goal: 'write the docs', writeScope: ['docs'] },
            ),
            sleepForChildren(),
            tool('run_command', { command: 'ls server/store docs' }),
            tool('reply', { text: 'project delivered: server and docs, checked with ls' }),
          ],
        },
        {
          server: [
            tool('write_file', { path: 'server/API.md', content: 'GET /keys\n' }),
            tool('send_message', { to: 'docs', text: 'The API is in server/API.md' }),
            spawn({
              name: 'store',
              agent: 'worker',
              goal: 'write the store',
              writeScope: ['server/store'],
            }),
            sleepForChildren(),
            tool('run_command', { command: 'cat server/store/kv.txt' }),
            tool('finish_subagent', {
              summary: 'server built',
              changedFiles: ['server/API.md', 'server/store/kv.txt'],
              status: 'done',
              validation: [{ command: 'cat server/store/kv.txt', exitCode: 0 }],
              acceptance: [{ index: 0, verdict: 'met' }],
            }),
          ],
          store: [
            tool('write_file', { path: 'server/store/kv.txt', content: 'kv\n' }),
            tool('run_command', { command: 'cat server/store/kv.txt' }),
            finishWork('store written', ['server/store/kv.txt']),
          ],
          docs: [
            tool('sleep', { until: [{ kind: 'message' }] }),
            tool('write_file', { path: 'docs/USAGE.md', content: 'See GET /keys\n' }),
            tool('run_command', { command: 'cat docs/USAGE.md' }),
            finishWork('docs written', ['docs/USAGE.md']),
          ],
        },
      );
      const ran = await masRun(['mission', 'build a small KV project'], provider);
      expect(ran.exitCode).toBe(0);
      expect(await readFile(join(ran.repository, 'server/store/kv.txt'), 'utf8')).toBe('kv\n');
      expect(await readFile(join(ran.repository, 'docs/USAGE.md'), 'utf8')).toContain('GET /keys');
      expect(ran.output).toContain('project delivered');
      const all = seen(provider);
      expect(all).toContain('Result of task store (worker): DONE');
      expect(all).toContain('Result of task server (lead): DONE');
      expect(all).toContain('Result of task docs (worker): DONE');
      expect(all).toContain('[Message from task server');
    },
    TIMEOUT,
  );
});
