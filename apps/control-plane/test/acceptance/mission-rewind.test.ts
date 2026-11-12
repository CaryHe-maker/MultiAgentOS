/**
 * Going back to a checkpoint in the middle of a long task (Orchestration 7.5): the run is paused,
 * `/rewind #N` puts the files back to the checkpoint's snapshot, takes back the tasks started
 * after it, and the root starts a new segment that reads it is back before its split. The whole
 * product runs from the console down to the Executors; only the provider is scripted.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeSandbox } from '@multiagentos/kernel';
import type { Console, ConsoleView, LiveState } from '@multiagentos/user-interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSystem } from '../../src/bootstrap/compose-system.js';
import { defaultSystemConfig } from '../../src/config/system-config.js';
import { scriptedAgents, textOf, tool, until, type ScriptedChat } from './chat-driver.js';

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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** A wait that starts when the provider serves the turn. */
const delay = (ms: number): Promise<void> =>
  ({
    then: (resolve: () => void) => setTimeout(resolve, ms),
  }) as unknown as Promise<void>;

interface Driven {
  readonly repository: string;
  readonly dataDir: string;
  readonly notices: string[];
  readonly lives: LiveState[];
  readonly console: Console;
  readonly done: Promise<number>;
}

/** `mas run` of the template mission, with the console in reach of the test. */
async function missionOn(
  goal: string,
  provider: ScriptedChat,
  files: Readonly<Record<string, string>>,
): Promise<Driven> {
  const root = await mkdtemp(join(tmpdir(), 'mas-rewind-'));
  directories.push(root);
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  const notices: string[] = [];
  const lives: LiveState[] = [];
  const attached: { console?: Console } = {};
  let asked: string | undefined;
  const view: ConsoleView = {
    print: (record) => void notices.push(`${record.kind}: ${record.text}`),
    update: (live) => {
      lives.push(live);
      const question = live.pending?.kind === 'AUTHORIZATION' ? live.pending.text : undefined;
      if (question !== undefined && question !== asked)
        queueMicrotask(() => void attached.console?.submit('y'));
      asked = question;
    },
    restoreInput: () => undefined,
  };
  const original = globalThis.fetch;
  globalThis.fetch = provider.fetch;
  let system: Awaited<ReturnType<typeof composeSystem>>;
  try {
    system = await composeSystem({
      config: { ...defaultSystemConfig(), dataDir },
      repositoryRoot: await realpath(repository),
      preset: 'standard',
      view,
      credentials: { apiKeyFor: () => OFFLINE_KEY },
      log: () => undefined,
    });
  } finally {
    globalThis.fetch = original;
  }
  await system.start();
  const template = system.templateRef('mission');
  if (template === undefined) throw new Error('no template mission');
  let resolveConsole: (console: Console) => void = () => undefined;
  const consoleReady = new Promise<Console>((resolve) => {
    resolveConsole = resolve;
  });
  const done = system.run(async (console) => {
    attached.console = console;
    resolveConsole(console);
    const code = await console.run(template, goal);
    await console.shutdown('RUN_FINISHED');
    return code;
  });
  return { repository, dataDir, notices, lives, console: await consoleReady, done };
}

async function sessionLog(dataDir: string): Promise<Record<string, unknown>[]> {
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

real('going back to a checkpoint in the middle of a long task (Orchestration 7.5)', () => {
  it(
    'puts the files back, takes back the tasks after the cut, and lets the root decide again',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              plan: 'Write the notes in out/; one worker does it.',
              tasks: [
                { name: 'writer', agent: 'worker', goal: 'write the notes', writeScope: ['out'] },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            // The new segment after the rewind: the root decides to deliver without the worker.
            tool('reply', { text: 'decided again after the rewind' }),
          ],
        },
        {
          writer: [
            tool('write_file', { path: 'out/notes.md', content: 'draft\n' }),
            // A long step: the run is paused while it is in flight.
            { wait: delay(60_000), then: tool('finish_subagent', { summary: 'never reached' }) },
          ],
        },
      );
      const run = await missionOn('write the notes', provider, { 'out/.keep': '' });
      const notes = join(run.repository, 'out/notes.md');
      await until(() => run.notices.length > 0, 'the run to start', 30_000);
      await until(() => run.lives.at(-1)?.status !== undefined, 'the live state', 30_000);
      // Wait for the worker's write, then pause.
      const started = Date.now();
      while (!(await exists(notes)) && Date.now() - started < 30_000)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await exists(notes)).toBe(true);
      await run.console.interrupt();
      await until(() => run.lives.at(-1)?.status === '已暂停', 'the run to be paused', 30_000);
      await run.console.submit('/checkpoints');
      await until(
        () => run.notices.some((line) => line.includes('#2  before starting writer')),
        'the list of checkpoints',
        30_000,
      );
      await run.console.submit('/rewind #2');
      await until(
        () =>
          run.notices.some((line) => line.includes('已回到 checkpoint「before starting writer」')),
        'the rewind',
        30_000,
      );
      // The worker's file is gone: the workspace is as it was at the cut.
      expect(await exists(notes)).toBe(false);
      await run.console.submit('/continue');
      const code = await run.done;
      expect(code).toBe(0);
      expect(run.notices.join('\n')).toContain('decided again after the rewind');
      const log = await sessionLog(run.dataDir);
      const rolled = log.find((record) => record['type'] === 'ROLLED_BACK');
      expect(rolled).toMatchObject({ files: 1 });
      expect((rolled?.['cancelledMissionIds'] as string[]).length).toBe(1);
      // The root's new segment read that it went back, and nothing of the cancelled worker.
      const rootAfter =
        provider.requests
          .at(-1)
          ?.messages.map((message) => textOf(message))
          .join('\n') ?? '';
      expect(rootAfter).toContain('The work went back to the checkpoint "before starting writer"');
      expect(rootAfter).not.toContain('Result of task writer');
    },
    TIMEOUT,
  );
});
