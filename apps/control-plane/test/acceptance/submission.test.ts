/**
 * A part of a long task handed to a pre-orchestrated template (Orchestration 3.9, D39): main starts
 * a fixer with run_subagents; the specialist, a lead, reads the fix-verify playbook with its task,
 * follows its phases (a call that does not fit is refused), and hands back one report, which main
 * reads like the result of any subtask. The whole product runs; only the provider is scripted.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeSandbox } from '@multiagentos/kernel';
import type { Console, ConsoleView } from '@multiagentos/user-interaction';
import { afterEach, expect, it, describe } from 'vitest';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { completionResponse } from '../support/scripted-model.js';
import {
  isTaskText,
  scriptedAgents,
  textOf,
  tool,
  type ChatRequest,
  type ProviderTurn,
  type ScriptedChat,
} from './chat-driver.js';

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

async function missionOn(goal: string, provider: ScriptedChat, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'mas-submission-'));
  directories.push(root);
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const notices: string[] = [];
  /** Every phase the activity area showed, as it showed it. */
  const phases = new Set<string>();
  const attached: { console?: Console } = {};
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => void notices.push(`${record.kind}: ${record.text}`),
    update: (live) => {
      for (const line of live.activity) phases.add(line.phase);
      const question = live.pending?.kind === 'AUTHORIZATION' ? live.pending.text : undefined;
      if (question !== undefined && question !== asked)
        queueMicrotask(() => void attached.console?.submit('y'));
      asked = question;
    },
    restoreInput: () => undefined,
  };
  const original = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  try {
    const system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      repositoryRoot: await realpath(repository),
      preset: 'standard',
      view,
      credentials: { apiKeyFor: () => OFFLINE_KEY },
      log: () => undefined,
    });
    await system.start();
    const template = system.templateRef('mission');
    if (template === undefined) throw new Error('no template mission');
    // A pre-orchestrated template does not run on its own.
    expect(system.templateRef('fix-verify')).toBeUndefined();
    const code = await system.run(async (console) => {
      attached.console = console;
      const exit = await console.run(template, goal);
      await console.shutdown('RUN_FINISHED');
      return exit;
    });
    return { code, notices, phases, dataDir, repository };
  } finally {
    globalThis.fetch = original;
  }
}

async function logOf(dataDir: string): Promise<Record<string, unknown>[]> {
  const [id] = await readdir(join(dataDir, 'sessions'));
  const text = await readFile(
    join(dataDir, 'sessions', id ?? '', 'workflow', 'log.v1.jsonl'),
    'utf8',
  );
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const check = 'grep -q fixed src/value.txt';

real('a part handed to a pre-orchestrated template (Orchestration 3.9)', () => {
  it(
    'runs the playbook under a root of its own, refuses what does not fit it, and reports back',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              tasks: [
                {
                  name: 'fix-value',
                  agent: 'fixer',
                  goal: 'src/value.txt must say fixed; the check fails now',
                  writeScope: ['src'],
                },
              ],
              plan: 'One part: make the value check pass, handed to a fixer.',
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'the value is fixed by the specialist' }),
          ],
          lead: [
            // reproduce
            tool('run_command', { command: check }),
            // Not the playbook: explorers are no phase of fix-verify.
            tool('run_subagents', {
              tasks: [{ name: 'look', agent: 'explorer', goal: 'look at src' }],
            }),
            // fix, as the playbook says
            tool('run_subagents', {
              tasks: [
                {
                  name: 'fixer',
                  agent: 'worker',
                  goal: 'write fixed into src/value.txt',
                  writeScope: ['src'],
                  // Not taken: a task that inherits thinks as hard as the root it comes from.
                  effort: 'low',
                },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('run_command', { command: check }),
            tool('finish_subagent', {
              summary: 'src/value.txt says fixed; the check passes',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
        },
        {
          fixer: [
            tool('read_file', { path: 'src/value.txt' }),
            tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
            tool('finish_subagent', {
              summary: 'wrote fixed',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [],
            }),
          ],
        },
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken\n',
      });
      expect(run.code).toBe(0);
      expect(run.notices.join('\n')).toContain('the value is fixed by the specialist');
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      const said = provider.requests
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      // The specialist read its playbook and its example with its task.
      expect(said).toContain('You run a pre-orchestrated part of the work: template fix-verify');
      expect(said).toContain('An example of a good plan with this playbook');
      // What the playbook needs comes from the goal main wrote (D39).
      expect(said).toContain('What you need from your task, in its goal (when');
      // The root of the long task read the table of decisions and the manual of the system with
      // its goal (Orchestration D37).
      expect(said).toContain('Decisions, by what you see.');
      expect(said).toContain('fixer: something fails and a command shows it');
      // The call that did not fit was refused with what the next phase may be.
      expect(said).toContain('this call does not follow your playbook');
      // Main read the report of the subtree's root like any subtask's.
      expect(said).toContain('Result of task fix-value');
      // On the tree: the specialist below main, its fixer below it.
      const log = await logOf(run.dataDir);
      const spawned = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[]);
      const root = spawned.find((node) => node['name'] === 'fix-value');
      const fixer = spawned.find((node) => node['name'] === 'fixer');
      expect((root?.['spawn'] as Record<string, unknown>)['specialist']).toBeDefined();
      expect((fixer?.['mission'] as Record<string, unknown>)['parentId']).toBe(
        (root?.['mission'] as Record<string, unknown>)['id'],
      );
      // The fix phase of fix-verify says `context: inherit` (D35): the fixer runs as the Agent of
      // the specialist and starts with its context.
      expect((fixer?.['spawn'] as Record<string, unknown>)['inherits']).toMatchObject({
        missionId: (root?.['mission'] as Record<string, unknown>)['id'],
        as: 'worker',
      });
      expect((fixer?.['agentRef'] as Record<string, unknown>)['id']).toBe('lead');
      // The provider keeps a cache per effort: the fixer runs with the effort of the root.
      const registered = log.filter((record) => record['type'] === 'AGENT_RUN_REGISTERED');
      const effortOf = (node: Record<string, unknown> | undefined) =>
        registered.find((record) => record['nodeId'] === node?.['nodeId'])?.['effort'];
      expect(effortOf(fixer)).toBe(effortOf(root));
      expect(effortOf(fixer)).not.toBe('low');
      const isFixer = (request: (typeof provider.requests)[number]) =>
        request.messages.some((message) =>
          textOf(message).includes('you are a different task: "fixer"'),
        );
      const first = provider.requests.find(isFixer);
      // The request of the root that made the call: the last one of the lead before the fixer's.
      const before = provider.requests
        .slice(0, provider.requests.indexOf(first as (typeof provider.requests)[number]))
        .filter(
          (request) =>
            textOf(request.messages.find((message) => message.role === 'user')).includes(
              'Your task (fix-value,',
            ) &&
            // Not the root's next request, which already has its own answer to the call.
            !request.messages.some((message) =>
              textOf(message).includes('Started 1 subtask(s): fixer'),
            ),
        )
        .at(-1);
      expect(first).toBeDefined();
      expect(before).toBeDefined();
      // The same prompt and the same tools, and every message the root sent is the start of what
      // the fixer sends: the provider's cache of the root's context serves the fixer.
      expect(JSON.stringify(first?.tools)).toBe(JSON.stringify(before?.tools));
      const sent = before?.messages ?? [];
      // The root's last message there is its status line, which every request ends with anew.
      const stable = sent.slice(0, -1);
      expect(first?.messages.slice(0, stable.length)).toEqual(stable);
      // Then the root's turn with the call, and the fixer's task as the answer to that call.
      const told = first?.messages.map((message) => textOf(message)).join('\n') ?? '';
      expect(told).toContain('From here on you are a different task: "fixer", a worker');
      expect(told).toContain('You may write only: src');
      expect(told).toContain('Your goal: write fixed into src/value.txt');
      expect(told).not.toContain('Your task (fixer,');
    },
    TIMEOUT,
  );
});

real('no criteria anywhere (Mission baseline 1, D93)', () => {
  it(
    'shows no agent a criterion, in its prompt, its tools or the manual, and still gets the work done',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              plan: 'One part: the value, by one worker.',
              tasks: [
                {
                  name: 'fixer',
                  agent: 'worker',
                  goal: 'write fixed into src/value.txt; done when the value check passes',
                  writeScope: ['src'],
                },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'fixed' }),
          ],
        },
        {
          fixer: [
            tool('read_file', { path: 'src/value.txt' }),
            tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
            tool('run_command', { command: check }),
            tool('finish_subagent', {
              summary: 'wrote fixed',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
        },
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken\n',
      });
      expect(run.code).toBe(0);
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      // Every request, of the root and of the worker: its messages and its tools.
      for (const request of provider.requests) {
        const shown = `${request.messages.map((message) => textOf(message)).join('\n')}\n${JSON.stringify(request.tools ?? [])}`;
        expect(shown).not.toMatch(/acceptance(?! tests)|criteri/iu);
      }
    },
    TIMEOUT,
  );
});

real('a call of run_subagents with a task that breaks a rule (D53, D56)', () => {
  it(
    'starts the valid task with the context of the root, and tells which tasks did not start and why',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('read_file', { path: 'src/value.txt' }),
            tool('run_subagents', {
              plan: 'One part: the value, by one worker that knows what I read.',
              tasks: [
                {
                  name: 'fixer',
                  agent: 'worker',
                  goal: 'write fixed into src/value.txt',
                  writeScope: ['src'],
                  role: `the value ${'and more '.repeat(20)}`,
                  effort: 'medium',
                },
                { name: 'ghost', agent: 'wizard', goal: 'cast it', writeScope: ['docs'] },
                {
                  name: 'after',
                  agent: 'worker',
                  goal: 'after the ghost',
                  writeScope: ['tests'],
                  dependsOn: ['ghost'],
                },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'fixed by a worker that had my context' }),
          ],
        },
        {
          fixer: [
            tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
            tool('run_command', { command: check }),
            tool('finish_subagent', {
              summary: 'wrote fixed',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
        },
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken-before-the-fix\n',
      });
      expect(run.code).toBe(0);
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      const said = provider.requests
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      // The valid task started; the others were named with their reasons (D56).
      expect(said).toContain('Started 1 subtask(s): fixer.');
      expect(said).toMatch(/task ghost \(index 1\) was not started: agent/u);
      expect(said).toContain(
        'task after was not started: it depends on ghost, which was not started',
      );
      expect(said).toContain('task fixer: effort "medium" is not none, low, high or max');
      const log = await logOf(run.dataDir);
      const fixer = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[])
        .find((node) => node['name'] === 'fixer');
      // A worker starts with the context of its caller, without asking for it (D56).
      expect((fixer?.['spawn'] as Record<string, unknown>)['inherits']).toMatchObject({
        as: 'worker',
      });
      expect(((fixer?.['spawn'] as Record<string, unknown>)['role'] as string).length).toBe(80);
      // It runs as a worker: its own prompt, tools and budget.
      expect((fixer?.['agentRef'] as Record<string, unknown>)['id']).toBe('worker');
      const first = provider.requests.find((request) =>
        request.messages.some((message) =>
          textOf(message).includes('you are a different task: "fixer"'),
        ),
      );
      expect(first).toBeDefined();
      const told = first?.messages.map((message) => textOf(message)).join('\n') ?? '';
      // What the root read is in its context: it need not read the file again.
      expect(told).toContain('broken-before-the-fix');
      expect(told).toContain('Your goal: write fixed into src/value.txt');
      expect(JSON.stringify(first?.tools)).not.toContain('run_subagents');
      expect(JSON.stringify(first?.tools)).toContain('finish_subagent');
      // Its last check after its last change goes with its result, shown there (D54): the root
      // reads it instead of looking it up or running it again.
      const result = said.slice(said.lastIndexOf('Result of task fixer'));
      expect(result).toMatch(/checked: the system saw `[^`]+` exit 0 after the last change/u);
      expect(result).toMatch(
        /Tool result ref_\d+\/\S+ \(run_command\) of this task, as it saw it:/u,
      );
    },
    TIMEOUT,
  );
});

real('a tester after the build (D55)', () => {
  it(
    'is refused once the builders are back, and the root is told to read their checks',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('run_subagents', {
            plan: 'One part: the value, by one worker.',
            tasks: [
              {
                name: 'fixer',
                agent: 'worker',
                goal: 'write fixed into src/value.txt',
                writeScope: ['src'],
              },
            ],
          }),
          tool('sleep', { until: [{ kind: 'children' }] }),
          tool('run_subagents', {
            tasks: [
              {
                name: 'tests',
                agent: 'tester',
                goal: 'acceptance tests of the value',
                writeScope: ['tests'],
              },
            ],
          }),
          tool('reply', { text: 'done without a tester' }),
        ],
        worker: [
          tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
          tool('run_command', { command: check }),
          tool('finish_subagent', {
            summary: 'wrote fixed',
            status: 'done',
            changedFiles: ['src/value.txt'],
            validation: [{ command: check, exitCode: 0 }],
          }),
        ],
      });
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken\n',
        'tests/.keep': '',
      });
      expect(run.code).toBe(0);
      const said = provider.requests
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      expect(said).toContain('Not started: a tester writes the acceptance tests beside the build');
      const log = await logOf(run.dataDir);
      const started = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[])
        .map((node) => node['name']);
      expect(started).toEqual(['fixer']);
    },
    TIMEOUT,
  );
});

real('a worker that may split runs as a lead, and only the root starts one (D88)', () => {
  it(
    'runs a worker with split: true as a lead, which splits its part and gets it done',
    async () => {
      const provider = scriptedAgents(
        { main: [] },
        {
          part: [
            tool('run_subagents', {
              tasks: [
                {
                  name: 'w',
                  agent: 'worker',
                  goal: 'write fixed into src/value.txt',
                  writeScope: ['src'],
                },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('finish_subagent', {
              summary: 'w wrote fixed',
              status: 'done',
              changedFiles: [],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
          w: [
            tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
            tool('run_command', { command: check }),
            tool('finish_subagent', {
              summary: 'wrote fixed',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
          notes: [
            tool('finish_subagent', {
              summary: 'nothing to note',
              status: 'done',
              changedFiles: [],
              validation: [],
            }),
          ],
        },
      );
      provider.add(
        tool('read_file', { path: 'src/value.txt' }),
        // Two tasks in one call: a check of the form against the catalog's would take the one
        // with split out and start the other alone.
        tool('run_subagents', {
          plan: 'One large part: the value, by a worker that splits it; notes beside it.',
          tasks: [
            {
              name: 'part',
              agent: 'worker',
              split: true,
              goal: 'the value part',
              writeScope: ['src'],
            },
            { name: 'notes', agent: 'worker', goal: 'note nothing', writeScope: ['docs'] },
          ],
        }),
        tool('sleep', { until: [{ kind: 'children', mode: 'all' }] }),
        tool('reply', { text: 'done through a worker that split' }),
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken-before-the-fix\n',
      });
      expect(run.code).toBe(0);
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      const log = await logOf(run.dataDir);
      const part = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[])
        .find((node) => node['name'] === 'part');
      // It runs as a lead: the lead's Agent, and the context of one that may split.
      expect((part?.['agentRef'] as Record<string, unknown>)['id']).toBe('lead');
      const told = provider.requests
        .find((request) =>
          request.messages.some((message) =>
            textOf(message).includes('you are a different task: "part"'),
          ),
        )
        ?.messages.map((message) => textOf(message))
        .join('\n');
      expect(told).toContain('Your part is yours to split');
      const said = provider.requests
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      expect(said).not.toContain('was not started');
      // It may split its part, but it starts no lead itself: split is the root's alone.
      const partTools = JSON.stringify(
        provider.requests.find((request) =>
          request.messages.some((message) =>
            textOf(message).includes('you are a different task: "part"'),
          ),
        )?.tools ?? [],
      );
      expect(partTools).toContain('run_subagents');
      expect(partTools).not.toContain('"split"');
      // The root was offered workers that may split, never a lead.
      const offered = JSON.stringify(provider.requests[0]?.tools ?? []);
      expect(offered).toContain('split');
      expect(offered).not.toMatch(/\blead\b/u);
    },
    TIMEOUT,
  );
});

real('a lead that starts with the context of the root (D58)', () => {
  it(
    'splits its part, and its worker starts with all of it: what the root read and the lead’s call',
    async () => {
      const provider = scriptedAgents(
        { main: [] },
        {
          part: [
            tool('run_subagents', {
              tasks: [
                {
                  name: 'w',
                  agent: 'worker',
                  goal: 'write fixed into src/value.txt',
                  writeScope: ['src'],
                },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('finish_subagent', {
              summary: 'w wrote fixed',
              status: 'done',
              changedFiles: [],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
          w: [
            tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
            tool('run_command', { command: check }),
            tool('finish_subagent', {
              summary: 'wrote fixed',
              status: 'done',
              changedFiles: ['src/value.txt'],
              validation: [{ command: check, exitCode: 0 }],
            }),
          ],
        },
      );
      provider.add(
        tool('read_file', { path: 'src/value.txt' }),
        tool('run_subagents', {
          plan: 'One part: the value, by a lead that splits it.',
          tasks: [
            {
              name: 'part',
              agent: 'worker',
              split: true,
              goal: 'the value part',
              writeScope: ['src'],
            },
          ],
        }),
        tool('sleep', { until: [{ kind: 'children' }] }),
        tool('reply', { text: 'done through a lead' }),
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken-before-the-fix\n',
      });
      expect(run.code).toBe(0);
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      const log = await logOf(run.dataDir);
      const spawned = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[]);
      const inheritsOf = (name: string) =>
        (spawned.find((node) => node['name'] === name)?.['spawn'] as Record<string, unknown>)[
          'inherits'
        ];
      expect(inheritsOf('part')).toMatchObject({ as: 'lead' });
      expect(inheritsOf('w')).toMatchObject({ as: 'worker' });
      const first = (name: string) =>
        provider.requests
          .find((request) =>
            request.messages.some((message) =>
              textOf(message).includes(`you are a different task: "${name}"`),
            ),
          )
          ?.messages.map((message) => textOf(message))
          .join('\n') ?? '';
      expect(first('part')).toContain('broken-before-the-fix');
      expect(first('part')).toContain('Your part is yours to split');
      // The worker of the lead has the root's reading and the lead's own task above its own.
      expect(first('w')).toContain('broken-before-the-fix');
      expect(first('w')).toContain('you are a different task: "part"');
      expect(first('w')).toContain('Your goal: write fixed into src/value.txt');
    },
    TIMEOUT,
  );
});

real('a subtask that asks its parent for more rounds (D91)', () => {
  const READS = 34;
  const notes = Object.fromEntries(
    Array.from({ length: READS }, (_, index) => [
      `notes/n${String(index)}.txt`,
      `note ${String(index)}\n`,
    ]),
  );
  /** The parent's reply to the request the Workflow sent, by the id it read in its context. */
  const answer = (provider: { requests: ChatRequest[] }, grant: boolean): ProviderTurn => ({
    response: () => {
      const read = provider.requests
        .at(-1)
        ?.messages.map((message) => textOf(message))
        .join('\n');
      const id = /Request (rounds_[A-Za-z0-9_]+) from task big/u.exec(read ?? '')?.[1] ?? 'none';
      return completionResponse(
        {
          calls: [
            {
              name: 'send_message',
              arguments: { to: 'big', kind: 'reply', replyTo: id, grant, text: 'answered' },
            },
          ],
        },
        'grant',
      );
    },
  });
  /** A wait that starts when the provider serves the turn, not when the script is written. */
  const delay = (ms: number): Promise<void> =>
    ({
      then: (resolve: () => void) => setTimeout(resolve, ms),
    }) as unknown as Promise<void>;
  /**
   * `talkative`: a sibling wakes the root with three messages first, which is its whole limit of
   * wakes between two words of the user (Orchestration 4.4); the request still wakes it (D94).
   */
  const run = async (grant: boolean, talkative = false) => {
    const worker = [
      // It reads what it will change, as a write needs; after the sibling has spoken.
      talkative
        ? { wait: delay(6000), then: tool('read_file', { path: 'src/value.txt' }) }
        : tool('read_file', { path: 'src/value.txt' }),
      ...Array.from({ length: READS - 1 }, (_, index) =>
        tool('read_file', { path: `notes/n${String(index)}.txt` }),
      ),
      tool('write_file', { path: 'src/value.txt', content: 'fixed\n' }),
      tool('run_command', { command: check }),
      tool('finish_subagent', {
        summary: 'wrote fixed',
        status: 'done',
        changedFiles: ['src/value.txt'],
        validation: [{ command: check, exitCode: 0 }],
      }),
    ];
    const chatty = [
      ...['one', 'two', 'three'].map((word) => ({
        wait: delay(1200),
        then: tool('send_message', { to: 'parent', text: `note ${word}` }),
      })),
      tool('sleep', { until: [{ kind: 'siblings' }] }),
      tool('finish_subagent', { summary: 'said three things', openQuestions: [] }),
    ];
    const provider = scriptedAgents(
      { main: [] },
      { big: worker, ...(talkative ? { chatty } : {}) },
    );
    const all = tool('sleep', { until: [{ kind: 'children', mode: 'all' }] });
    provider.add(
      tool('run_subagents', {
        plan: 'One long part.',
        tasks: [
          { name: 'big', agent: 'worker', goal: 'the long part', writeScope: ['src'] },
          ...(talkative ? [{ name: 'chatty', agent: 'explorer', goal: 'say three things' }] : []),
        ],
      }),
      // Woken by each of the three messages, it sleeps again.
      ...(talkative ? [all, all, all] : []),
      all,
      answer(provider, grant),
      all,
      tool('reply', { text: 'done' }),
    );
    const result = await missionOn('do the long part', provider, {
      ...notes,
      'src/value.txt': 'broken\n',
    });
    const said = (task: string) =>
      provider.requests
        .filter((request) => request.messages.some((message) => isTaskText(textOf(message), task)))
        .map((request) => request.messages.map((message) => textOf(message)).join('\n'));
    return { result, provider, said };
  };

  it(
    'waits for the answer, and goes on with the rounds its parent granted',
    async () => {
      const { result, provider, said } = await run(true);
      expect(result.code).toBe(0);
      expect(await readFile(join(result.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      // The parent read the request, sent as a message of the task, and how to answer it.
      const root = provider.requests
        .map((request) => request.messages.map((message) => textOf(message)).join('\n'))
        .find((text) => text.includes('more rounds, so that it need not wrap up'));
      expect(root).toContain('grant true or false');
      expect(root).toContain('has used 34 of its 40 rounds');
      // The round after the answer says what was granted.
      // The round after the answer says what was granted, and the task finished well within it.
      const big = said('big');
      expect(
        big.filter((text) =>
          text.includes('Your parent granted 40 more rounds: this is round 35 of 80 now.'),
        ),
      ).toHaveLength(1);
      expect(big.length).toBeLessThan(40);
      expect(result.phases).toContain('申请额度中');
      const log = await logOf(result.dataDir);
      expect(
        log.some((record) => record['type'] === 'MISSION_MESSAGE' && record['grant'] === true),
      ).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'wakes its parent with the request after messages used up its limit of wakes (D94)',
    async () => {
      const { result } = await run(true, true);
      expect(result.code).toBe(0);
      const log = await logOf(result.dataDir);
      const root = log.find(
        (record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] !== 'SPAWN',
      );
      expect(root).toBeDefined();
      const woken = log.filter(
        (record) =>
          record['type'] === 'MISSION_WOKEN' &&
          (record['causes'] as { kind: string }[]).some((cause) => cause.kind === 'MESSAGE'),
      );
      // Three wakes by the sibling's messages, then the one by the request.
      expect(woken.length).toBeGreaterThanOrEqual(4);
      expect(
        log.some((record) => record['type'] === 'MISSION_MESSAGE' && record['grant'] === true),
      ).toBe(true);
    },
    TIMEOUT,
  );
});
