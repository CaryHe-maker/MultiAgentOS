/**
 * Background commands of a task (Orchestration 6, D5, D9), end to end with the real product, the
 * real sandbox and a provider scripted per Agent and per task: a command started in the
 * background, one moved there at its timeout, reading and stopping one, waking on its end, the job
 * of a task that delivered going to the task above, and a chat's main woken while it waits.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeSandbox } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openChat,
  scriptedAgents,
  textOf,
  tool,
  type Chat,
  type ScriptedChat,
} from './chat-driver.js';

const TIMEOUT = 90_000;
const bwrapWorks = (await probeSandbox(tmpdir())).available;
const real = bwrapWorks ? describe : describe.skip;

const directories: string[] = [];
const open: Chat[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Place {
  readonly dataDir: string;
  readonly repository: string;
}

async function roots(files: Readonly<Record<string, string>> = {}): Promise<Place> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-jobs-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-jobs-repo-'));
  directories.push(dataDir, repository);
  for (const [name, content] of Object.entries({ 'README.md': 'demo\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  return { dataDir, repository };
}

async function chatOn(place: Place, provider: ScriptedChat): Promise<Chat> {
  const chat = await openChat({ ...place, provider });
  open.push(chat);
  return chat;
}

const seen = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const toolsOfMain = (provider: ScriptedChat): string[] =>
  (provider.requests[0]?.tools ?? []).map((each) => each.function.name);
/** A wait that starts when the provider serves the turn. */
const delay = (ms: number): Promise<void> =>
  ({
    then: (resolve: () => void) => setTimeout(resolve, ms),
  }) as unknown as Promise<void>;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const run = (command: string, more: Record<string, unknown> = {}) =>
  tool('run_command', { command, ...more });
const sleepFor = (...until: Record<string, unknown>[]) => tool('sleep', { until });
const jobs = (mode = 'all') => ({ kind: 'jobs', mode });
const reply = (text: string) => tool('reply', { text });

describe('the tools a task is offered (Orchestration 4, 5, 6.2)', () => {
  it(
    'offers main the task tools and the job tools beside its Unit tools',
    async () => {
      const place = await roots();
      const provider = scriptedAgents({ main: [reply('hello')] }, {});
      const chat = await chatOn(place, provider);
      await chat.say('hi');
      const tools = toolsOfMain(provider);
      for (const name of ['sleep', 'send_message', 'view_tasks', 'stop_subagents'])
        expect(tools).toContain(name);
      // A pre-orchestrated template is a specialist of run_subagents, not a tool of its own (D39).
      expect(tools).not.toContain('sub_mission');
      // The job tools go with commands (Orchestration 6.2): offered where commands can run
      // isolated, and not offered at all where the sandbox is not available.
      for (const name of ['job_output', 'job_list', 'job_kill', 'run_command'])
        if (bwrapWorks) expect(tools).toContain(name);
        else expect(tools).not.toContain(name);
    },
    TIMEOUT,
  );
});

real('background commands (Orchestration 6)', () => {
  it(
    'starts a command in the background, sleeps on it, and wakes with what it printed',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            run('sleep 1; echo built-ok', { runInBackground: true }),
            sleepFor(jobs()),
            reply('the build is done'),
          ],
        },
        {},
      );
      const chat = await chatOn(place, provider);
      await chat.say('build in the background');
      expect(chat.printed('REPLY')).toContain('the build is done');
      const all = seen(provider);
      expect(all).toContain('job_1: started in the background');
      expect(all).toContain(
        'Background command job_1 (sleep 1; echo built-ok) has ended [exited(0)',
      );
      expect(all).toContain('built-ok');
      expect(all).toContain('a background command of yours has ended');
    },
    TIMEOUT,
  );

  it(
    'reads a running job, lists it and stops it, and is told it was stopped',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            run('echo first; sleep 60', { runInBackground: true }),
            { wait: delay(800), then: tool('job_output', { jobId: 'job_1' }) },
            tool('job_list', {}),
            tool('job_kill', { jobId: 'job_1' }),
            sleepFor(jobs()),
            reply('stopped the server'),
          ],
        },
        {},
      );
      const chat = await chatOn(place, provider);
      await chat.say('start a server');
      expect(chat.printed('REPLY')).toContain('stopped the server');
      const all = seen(provider);
      expect(all).toMatch(/first\s*\n\[job_1 status: running\]/u);
      expect(all).toContain('- job_1: echo first; sleep 60 — running');
      expect(all).toContain('job_1: stopping it');
      expect(all).toMatch(/Background command job_1 \(echo first; sleep 60\) has ended \[stopped/u);
    },
    TIMEOUT,
  );

  it(
    'moves a command that runs past its timeout to the background instead of stopping it',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            run('echo early; sleep 2; echo late > late.txt; echo late', { timeoutMs: 500 }),
            sleepFor(jobs()),
            reply('it finished'),
          ],
        },
        {},
      );
      const chat = await chatOn(place, provider);
      await chat.say('run the slow one');
      expect(chat.printed('REPLY')).toContain('it finished');
      const all = seen(provider);
      expect(all).toContain('job_1: still running after 1 s: moved to the background');
      expect(all).toContain('early');
      expect(all).toMatch(/has ended \[exited\(0\)/u);
      expect(await exists(join(place.repository, 'late.txt'))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'hands the job of a task that delivered to the task above, which is woken by its end',
    async () => {
      const place = await roots({ 'out/.keep': '' });
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              tasks: [
                {
                  name: 'starter',
                  agent: 'worker',
                  goal: 'start a slow writer and return',
                  writeScope: ['out'],
                },
              ],
            }),
            sleepFor({ kind: 'children', mode: 'all' }),
            // Woken by the child's end; it sleeps on a long timer, and the job's end wakes it.
            sleepFor({ kind: 'timer', seconds: 120 }),
            reply('the writer of the child is done'),
          ],
        },
        {
          starter: [
            run('sleep 2; echo x > out/late.txt', { runInBackground: true }),
            tool('finish_subagent', {
              summary: 'started it',
              changedFiles: [],
              status: 'done',
              validation: [],
            }),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('delegate');
      expect(chat.printed('REPLY')).toContain('the writer of the child is done');
      expect(await exists(join(place.repository, 'out/late.txt'))).toBe(true);
      const all = seen(provider);
      expect(all).toContain('It was started by the subtask starter, which has ended.');
      expect(all).toContain('a background command of yours has ended');
    },
    TIMEOUT,
  );

  it(
    'stops the jobs of a task that was stopped',
    async () => {
      const place = await roots({ 'out/.keep': '' });
      const provider = scriptedAgents(
        {
          main: [
            tool('run_subagents', {
              tasks: [
                {
                  name: 'starter',
                  agent: 'worker',
                  goal: 'start a slow writer',
                  writeScope: ['out'],
                },
              ],
            }),
            sleepFor({ kind: 'timer', seconds: 1 }),
            tool('stop_subagents', { names: ['starter'], reason: 'not needed' }),
            sleepFor({ kind: 'children', mode: 'all' }),
            { wait: delay(3000), then: reply('stopped the child') },
          ],
        },
        {
          starter: [
            run('sleep 2; echo x > out/late.txt', { runInBackground: true }),
            sleepFor(jobs()),
            tool('finish_subagent', { summary: 'never reached' }),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('delegate');
      expect(chat.printed('REPLY')).toContain('stopped the child');
      expect(await exists(join(place.repository, 'out/late.txt'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "wakes a chat's main that waits for the user when its background command ends (4.4)",
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            run('sleep 1; echo built-ok', { runInBackground: true }),
            reply('the build runs in the background'),
            // A segment of its own, with no message of the user before it.
            reply('the build finished: built-ok'),
          ],
        },
        {},
      );
      const chat = await chatOn(place, provider);
      await chat.say('build in the background');
      expect(chat.printed('REPLY')).toEqual(['the build runs in the background']);
      const deadline = Date.now() + 30_000;
      while (chat.printed('REPLY').length < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chat.printed('REPLY')).toEqual([
        'the build runs in the background',
        'the build finished: built-ok',
      ]);
      expect(chat.printed('NOTICE').join('\n')).toContain('后台命令结束，main 继续');
      const last = provider.requests
        .at(-1)
        ?.messages.map((message) => textOf(message))
        .join('\n');
      expect(last).toContain('a background command of yours has ended');
      expect(last).toContain('built-ok');
    },
    TIMEOUT,
  );

  it(
    'refuses to sleep on jobs when the task has none running',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        { main: [sleepFor(jobs()), reply('nothing to wait for')] },
        {},
      );
      const chat = await chatOn(place, provider);
      await chat.say('wait');
      expect(chat.printed('REPLY')).toContain('nothing to wait for');
      expect(seen(provider)).toContain('you have no background commands that are still running');
    },
    TIMEOUT,
  );
});
