/**
 * What a parent task can do while its tasks run (Orchestration 3.7, 5.1, 5.2, 8.2; D17-D21), end
 * to end with the real product and a provider scripted per Agent and per task: write what it has
 * not lent, see the tree, stop a task, interrupt one; and what it cannot: write what it lent,
 * interrupt upwards.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-control-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-control-repo-'));
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
const seenBy = (provider: ScriptedChat, task: string): string =>
  provider.requests
    .filter((request) =>
      request.messages.some((message) => textOf(message).includes(`Your task (${task},`)),
    )
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const toolsOf = (provider: ScriptedChat, task: string): string[] =>
  (
    provider.requests.find((request) =>
      request.messages.some((message) => textOf(message).includes(`Your task (${task},`)),
    )?.tools ?? []
  ).map((each) => each.function.name);
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

const spawn = (...tasks: Record<string, unknown>[]) => tool('run_subagents', { tasks });
const sleepFor = (...until: Record<string, unknown>[]) => tool('sleep', { until });
const children = () => ({ kind: 'children', mode: 'all' });
const reply = (text: string) => tool('reply', { text });
const finish = (summary: string) => tool('finish_subagent', { summary });

describe('the tree a task sees (Orchestration 3.7, D18)', () => {
  it(
    'shows a task its role, its parent and its siblings, and the parent the tree with view_tasks',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              {
                name: 'front',
                agent: 'explorer',
                goal: 'look at the UI',
                role: 'responsible for the frontend',
              },
              {
                name: 'back',
                agent: 'explorer',
                goal: 'look at the API',
                role: 'responsible for the backend',
              },
            ),
            tool('view_tasks', {}),
            sleepFor(children()),
            reply('looked'),
          ],
        },
        {
          front: [finish('the UI is fine')],
          back: [finish('the API is fine')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('look at both parts');
      expect(chat.printed('REPLY')).toContain('looked');
      const front = seenBy(provider, 'front');
      expect(front).toContain('The work you are part of');
      expect(front).toContain('front (explorer) — responsible for the frontend');
      expect(front).toContain('<- you');
      expect(front).toContain('back (explorer) — responsible for the backend');
      // The parent's view: its children, each with its role and state.
      const all = seen(provider);
      expect(all).toMatch(
        /- front \(explorer\) — responsible for the frontend — (running|not started|ended)/u,
      );
    },
    TIMEOUT,
  );
});

describe('stopping a task (Orchestration 5.1, D19)', () => {
  it(
    'stops a task that sleeps at once, and the parent gets it as stopped',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'waiter', agent: 'explorer', goal: 'wait for a sign' }),
            tool('stop_subagents', { names: ['waiter'], reason: 'no longer needed' }),
            sleepFor(children()),
            reply('stopped it'),
          ],
        },
        { waiter: [sleepFor({ kind: 'timer', seconds: 600 })] },
      );
      const chat = await chatOn(place, provider);
      await chat.say('start and stop');
      expect(chat.printed('REPLY')).toContain('stopped it');
      const all = seen(provider);
      expect(all).toContain('Stopping waiter');
      expect(all).toContain('stopped by its parent: no longer needed');
    },
    TIMEOUT,
  );

  it(
    'stops a task that works after the step it is in, and its next step never runs',
    async () => {
      const place = await roots({ 'a.txt': 'one\n' });
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'busy', agent: 'explorer', goal: 'read a lot' }),
            tool('stop_subagents', { names: ['all'], reason: 'wrong direction' }),
            sleepFor(children()),
            reply('redirected'),
          ],
        },
        {
          busy: [
            { wait: delay(1500), then: tool('read_file', { path: 'a.txt' }) },
            finish('should not be reached'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('redirected');
      expect(seen(provider)).toContain('stopped by its parent: wrong direction');
      expect(seen(provider)).not.toContain('should not be reached');
    },
    TIMEOUT,
  );
});

describe('interrupts go down the tree only (Orchestration 5.2, D20, D21)', () => {
  it(
    'wakes a sleeping child at once with the interrupt shown at the end of its context',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'slow', agent: 'explorer', goal: 'wait long, then report' }),
            tool('send_message', { to: 'slow', text: 'Report now instead', interrupt: true }),
            sleepFor(children()),
            reply('it reported'),
          ],
        },
        {
          slow: [sleepFor({ kind: 'timer', seconds: 600 }), finish('reported early, as asked')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('it reported');
      const slow = seenBy(provider, 'slow');
      expect(slow).toContain('⚠ INTERRUPT from your parent task main');
      expect(slow).toContain('Report now instead');
      expect(slow).toContain('your parent interrupted you');
    },
    TIMEOUT,
  );

  it(
    'refuses an interrupt from a child to its parent',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'up', agent: 'explorer', goal: 'try to interrupt' }),
            sleepFor(children()),
            reply('done'),
          ],
        },
        {
          up: [
            tool('send_message', { to: 'parent', text: 'stop everything', interrupt: true }),
            finish('tried'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('done');
      expect(seenBy(provider, 'up')).toContain('interrupt is only for your own subtasks');
    },
    TIMEOUT,
  );
});

real('the write permission lent with a task (Orchestration 8.2, D17)', () => {
  it(
    'lets the parent write what it has not lent, and keeps its writes and commands out of what it lent',
    async () => {
      const place = await roots({ 'api/old.txt': 'old\n', 'docs/old.txt': 'old\n' });
      const provider = scriptedAgents(
        {
          main: [
            spawn({
              name: 'api',
              agent: 'worker',
              goal: 'change the api',
              role: 'responsible for the API',
              writeScope: ['api'],
            }),
            tool('write_file', { path: 'docs/plan.md', content: 'plan\n' }),
            tool('write_file', { path: 'api/stolen.txt', content: 'x\n' }),
            tool('run_command', { command: 'echo y > api/also.txt' }),
            sleepFor(children()),
            reply('worked beside it'),
          ],
        },
        {
          api: [
            {
              wait: delay(2000),
              then: tool('write_file', { path: 'api/new.txt', content: 'api\n' }),
            },
            tool('run_command', { command: 'cat api/new.txt' }),
            tool('finish_subagent', {
              summary: 'changed the api',
              changedFiles: ['api/new.txt'],
              status: 'done',
              validation: [{ command: 'cat api/new.txt', exitCode: 0 }],
            }),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('work in parallel');
      expect(chat.printed('REPLY')).toContain('worked beside it');
      expect(await readFile(join(place.repository, 'docs/plan.md'), 'utf8')).toBe('plan\n');
      expect(await readFile(join(place.repository, 'api/new.txt'), 'utf8')).toBe('api\n');
      expect(await exists(join(place.repository, 'api/stolen.txt'))).toBe(false);
      expect(await exists(join(place.repository, 'api/also.txt'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'gives a task lent without commands no command tool',
    async () => {
      const place = await roots({ 'docs/old.txt': 'old\n' });
      const provider = scriptedAgents(
        {
          main: [
            spawn({
              name: 'writer',
              agent: 'worker',
              goal: 'write the docs',
              writeScope: ['docs'],
              commands: false,
            }),
            sleepFor(children()),
            reply('written'),
          ],
        },
        {
          writer: [
            tool('write_file', { path: 'docs/a.md', content: 'a\n' }),
            tool('finish_subagent', {
              summary: 'wrote the docs',
              changedFiles: ['docs/a.md'],
              status: 'done',
              validation: [],
            }),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('write');
      expect(chat.printed('REPLY')).toContain('written');
      const tools = toolsOf(provider, 'writer');
      expect(tools).toContain('write_file');
      expect(tools).not.toContain('run_command');
    },
    TIMEOUT,
  );
});
