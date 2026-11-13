/**
 * A part of a long task handed to a pre-orchestrated template (Orchestration 3.9, D31): main calls
 * `sub_mission` with `fix-verify`; the subtree's root, a lead, reads the playbook with its task,
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
  const attached: { console?: Console } = {};
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => void notices.push(`${record.kind}: ${record.text}`),
    update: (live) => {
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
    return { code, notices, dataDir, repository };
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
            tool('sub_mission', {
              name: 'fix-value',
              template: 'fix-verify',
              goal: 'src/value.txt must say fixed; the check fails now',
              writeScope: ['src'],
              acceptance: [`${check} succeeds`],
              params: { check, maxRounds: '2' },
              plan: 'One part: make the value check pass, handed to fix-verify.',
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'the value is fixed by the subMission' }),
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
                  acceptance: [`${check} succeeds`],
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
              acceptance: [{ index: 0, verdict: 'met' }],
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
              acceptance: [{ index: 0, verdict: 'met' }],
            }),
          ],
        },
      );
      const run = await missionOn('make the value check pass', provider, {
        'src/value.txt': 'broken\n',
      });
      expect(run.code).toBe(0);
      expect(run.notices.join('\n')).toContain('the value is fixed by the subMission');
      expect(await readFile(join(run.repository, 'src/value.txt'), 'utf8')).toBe('fixed\n');
      const said = provider.requests
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      // The root of the subMission read its playbook and its example with its task.
      expect(said).toContain('You run a pre-orchestrated part of the work: template fix-verify');
      expect(said).toContain('An example of a good plan with this playbook');
      expect(said).toContain('check: grep -q fixed src/value.txt');
      // The root of the long task read the worked examples with its goal (D32).
      expect(said).toContain('Examples of long tasks done well.');
      expect(said).toContain('Example 3. Not split at all.');
      // The call that did not fit was refused with what the next phase may be.
      expect(said).toContain('this call does not follow your playbook');
      // Main read the report of the subtree's root like any subtask's.
      expect(said).toContain('Result of task fix-value');
      // On the tree: the root of the subMission below main, its fixer below it.
      const log = await logOf(run.dataDir);
      const spawned = log
        .filter((record) => record['type'] === 'GRAPH_EXTENDED' && record['source'] === 'SPAWN')
        .flatMap((record) => record['nodes'] as Record<string, unknown>[]);
      const root = spawned.find((node) => node['name'] === 'fix-value');
      const fixer = spawned.find((node) => node['name'] === 'fixer');
      expect((root?.['spawn'] as Record<string, unknown>)['submission']).toBeDefined();
      expect((fixer?.['mission'] as Record<string, unknown>)['parentId']).toBe(
        (root?.['mission'] as Record<string, unknown>)['id'],
      );
    },
    TIMEOUT,
  );
});
