/**
 * Background commands of a task (Orchestration 6, D5, D9), end to end with the real product, the
 * real sandbox and a provider scripted per Agent and per task: a command started in the
 * background, one moved there at its timeout, reading and stopping one, waking on its end, and a
 * task that ends stopping its jobs.
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
      for (const name of [
        'sleep',
        'send_message',
        'view_tasks',
        'stop_subagents',
        'job_output',
        'job_list',
        'job_kill',
        'run_command',
      ])
        expect(tools).toContain(name);
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
    'stops the jobs of a task when the task ends',
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
            { wait: delay(3500), then: reply('the child is done') },
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
      expect(chat.printed('REPLY')).toContain('the child is done');
      expect(await exists(join(place.repository, 'out/late.txt'))).toBe(false);
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
