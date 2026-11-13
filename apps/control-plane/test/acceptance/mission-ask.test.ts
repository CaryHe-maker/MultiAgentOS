/**
 * `ask_user` in a long task is a sleep (Orchestration 4.1, 4.2): the task that asks ends its
 * segment, the question stays with the user, and only the answer wakes it; its next segment reads
 * the answer. The whole product runs from the console down to the Executors; only the provider is
 * scripted.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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

interface Driven {
  readonly dataDir: string;
  readonly notices: string[];
  readonly lives: LiveState[];
  readonly console: Console;
  readonly done: Promise<number>;
}

/** `mas run` of the template mission, with the console in reach of the test. */
async function missionOn(goal: string, provider: ScriptedChat): Promise<Driven> {
  const root = await mkdtemp(join(tmpdir(), 'mas-ask-'));
  directories.push(root);
  const repository = join(root, 'repo');
  const dataDir = join(root, 'data');
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', 'out/.keep': '' })) {
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
  return { dataDir, notices, lives, console: await consoleReady, done };
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

real('ask_user in a long task is a sleep (Orchestration 4.1)', () => {
  it(
    'ends the segment of the task that asks, and wakes it with the answer alone',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              plan: 'One worker names the release; it asks the user.',
              tasks: [
                { name: 'namer', agent: 'worker', goal: 'name the release', writeScope: ['out'] },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'the release is named' }),
          ],
        },
        {
          namer: [
            tool('ask_user', { kind: 'ask', question: 'which name for the release?' }),
            // The next segment, woken by the answer.
            tool('finish_subagent', { summary: 'named it', status: 'done' }),
          ],
        },
      );
      const run = await missionOn('name the release', provider);
      await until(
        () => run.lives.at(-1)?.pending?.kind === 'QUESTION',
        'the question of the worker',
        30_000,
      );
      expect(run.lives.at(-1)?.pending?.text).toContain('which name for the release?');
      // The worker's segment ends right after its question goes out: it waits as a sleeping task.
      const sleepsOnAnswer = async () =>
        (await sessionLog(run.dataDir)).some(
          (record) =>
            record['type'] === 'SEGMENT_YIELDED' &&
            JSON.stringify(record['until']).includes('"human"'),
        );
      const started = Date.now();
      while (!(await sleepsOnAnswer()) && Date.now() - started < 30_000)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await sleepsOnAnswer()).toBe(true);
      await run.console.submit('Aurora');
      const code = await run.done;
      expect(code).toBe(0);
      expect(run.notices.join('\n')).toContain('the release is named');
      const log = await sessionLog(run.dataDir);
      const woken = log.filter((record) => record['type'] === 'MISSION_WOKEN');
      expect(woken.some((record) => JSON.stringify(record['causes']).includes('"HUMAN"'))).toBe(
        true,
      );
      // The worker's second segment read the answer after its call was answered.
      const second = provider.requests.find((request) =>
        request.messages.some((message) => textOf(message).includes('Aurora')),
      );
      const said = second?.messages.map((message) => textOf(message)).join('\n') ?? '';
      expect(said).toContain('Your question is with the user');
      expect(said).toContain('The user answered the question you asked with ask_user');
      expect(second?.messages.find((message) => textOf(message).includes('Aurora'))?.role).toBe(
        'user',
      );
    },
    TIMEOUT,
  );

  it(
    'asks the question again after a rewind to before its answer, and goes on with the new one',
    async () => {
      /** A wait that starts when the provider serves the turn. */
      const delay = (ms: number): Promise<void> =>
        ({ then: (resolve: () => void) => setTimeout(resolve, ms) }) as unknown as Promise<void>;
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              plan: 'One worker names the release; it asks the user.',
              tasks: [
                { name: 'namer', agent: 'worker', goal: 'name the release', writeScope: ['out'] },
              ],
            }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            // After the rewind the root reads that the question is asked again, and waits on.
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'named after the second answer' }),
          ],
        },
        {
          namer: [
            tool('ask_user', { kind: 'ask', question: 'which name for the release?' }),
            // Woken by the first answer: still at work when the run is paused.
            { wait: delay(60_000), then: tool('finish_subagent', { summary: 'never reached' }) },
            // Woken by the answer to the question asked again.
            tool('finish_subagent', { summary: 'named it', status: 'done' }),
          ],
        },
      );
      const run = await missionOn('name the release', provider);
      const asked = () =>
        run.lives.at(-1)?.pending?.kind === 'QUESTION' &&
        (run.lives.at(-1)?.pending?.text ?? '').includes('which name for the release?');
      await until(asked, 'the question', 30_000);
      const sleepsOnAnswer = async () =>
        (await sessionLog(run.dataDir)).some(
          (record) =>
            record['type'] === 'SEGMENT_YIELDED' &&
            JSON.stringify(record['until']).includes('"human"'),
        );
      const started = Date.now();
      while (!(await sleepsOnAnswer()) && Date.now() - started < 30_000)
        await new Promise((resolve) => setTimeout(resolve, 50));
      await run.console.submit('Aurora');
      // The worker is woken by the answer and at work again: then the run is paused.
      // Its second request is out (the scripted turn that waits is spent), then the run is paused.
      const working = () =>
        provider.requests.filter((request) =>
          request.messages.some((message) => textOf(message).includes('Your task (namer,')),
        ).length >= 2;
      await until(working, 'the worker at work again', 30_000);
      await run.console.interrupt();
      await until(() => run.lives.at(-1)?.status === '已暂停', 'the run to be paused', 30_000);
      await run.console.submit('/checkpoints');
      await until(
        () => run.notices.some((line) => line.includes('after the answer to a question')),
        'the list of checkpoints',
        30_000,
      );
      const listed =
        run.notices.find((line) => line.includes('after the answer to a question')) ?? '';
      const seq = /#(\d+)\s+after the answer to a question/u.exec(listed)?.[1] ?? '0';
      await run.console.submit(`/rewind #${seq}`);
      await until(
        () => run.notices.some((line) => line.includes('已回到 checkpoint')),
        'the rewind',
        30_000,
      );
      await run.console.submit('/continue');
      // The same question comes again; the new answer is the one the worker goes on with.
      await until(asked, 'the question asked again', 30_000);
      await run.console.submit('Borealis');
      const code = await run.done;
      expect(code).toBe(0);
      expect(run.notices.join('\n')).toContain('named after the second answer');
      const log = await sessionLog(run.dataDir);
      expect(
        log.some((record) => record['type'] === 'HUMAN_REQUESTED' && record['askedAgain'] === true),
      ).toBe(true);
      const last = provider.requests.find((request) =>
        request.messages.some((message) => textOf(message).includes('Borealis')),
      );
      const said = last?.messages.map((message) => textOf(message)).join('\n') ?? '';
      expect(said).toContain('The user answered the question you asked with ask_user');
      expect(said).not.toContain('Aurora');
    },
    TIMEOUT,
  );

  it(
    'takes the question back from the user when the task that asked is stopped',
    async () => {
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              plan: 'One worker names the release; it asks the user.',
              tasks: [
                { name: 'namer', agent: 'worker', goal: 'name the release', writeScope: ['out'] },
              ],
            }),
            tool('sleep', { until: [{ kind: 'timer', seconds: 1 }] }),
            tool('stop_subagents', { names: ['namer'], reason: 'no name needed after all' }),
            tool('sleep', { until: [{ kind: 'children' }] }),
            tool('reply', { text: 'delivered without a name' }),
          ],
        },
        { namer: [tool('ask_user', { kind: 'ask', question: 'which name for the release?' })] },
      );
      const run = await missionOn('name the release', provider);
      await until(
        () => run.lives.at(-1)?.pending?.kind === 'QUESTION',
        'the question of the worker',
        30_000,
      );
      const code = await run.done;
      expect(code).toBe(0);
      expect(run.notices.join('\n')).toContain('delivered without a name');
      expect(run.notices.join('\n')).toContain('问题已取消');
    },
    TIMEOUT,
  );
});
