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
      // Nor the tools of background commands (Orchestration 6.2).
      expect(tools).not.toContain('job_output');
    },
    TIMEOUT,
  );
});

describe('waking as each subtask ends, and waiting for siblings (Orchestration 4.2, D28)', () => {
  it(
    'wakes the parent as each child ends by default, while the others still run',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'quick', agent: 'explorer', goal: 'answer at once' },
              { name: 'slow', agent: 'explorer', goal: 'answer after a while' },
            ),
            sleepFor({ kind: 'children' }),
            // Woken by quick alone: slow still runs, so this sleep is taken.
            sleepFor({ kind: 'children' }),
            reply('both are in'),
          ],
        },
        {
          quick: [finish('quick result')],
          slow: [{ wait: delay(2500), then: finish('slow result') }],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('ask both');
      expect(chat.printed('REPLY')).toContain('both are in');
      const all = seen(provider);
      expect(all).toContain('Asleep until: children (any)');
      expect(all).not.toContain('Not asleep');
      expect(all).toContain('quick result');
      expect(all).toContain('slow result');
    },
    TIMEOUT,
  );

  it(
    'wakes a task that waits for a sibling when the sibling has ended',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'code', agent: 'explorer', goal: 'look at the code' },
              { name: 'docs', agent: 'explorer', goal: 'describe the code once it is looked at' },
            ),
            sleepFor(children()),
            reply('code and docs done'),
          ],
        },
        {
          code: [{ wait: delay(1500), then: finish('the code has two modules') }],
          docs: [sleepFor({ kind: 'siblings', names: ['code'] }), finish('docs written')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('look and describe');
      expect(chat.printed('REPLY')).toContain('code and docs done');
      const docs = seenBy(provider, 'docs');
      expect(docs).toContain('Asleep until: siblings (all)');
      expect(docs).toContain('the sibling tasks you waited for have ended');
    },
    TIMEOUT,
  );

  it(
    'hints at siblings when a task guesses with a timer while its siblings work',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'code', agent: 'explorer', goal: 'look at the code' },
              { name: 'docs', agent: 'explorer', goal: 'wait, then describe' },
            ),
            sleepFor(children()),
            reply('done'),
          ],
        },
        {
          code: [{ wait: delay(1500), then: finish('looked') }],
          docs: [sleepFor({ kind: 'timer', seconds: 1 }), finish('described')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('done');
      expect(seenBy(provider, 'docs')).toContain(
        'sleep with until siblings (names) instead of a timer',
      );
    },
    TIMEOUT,
  );

  it(
    'wakes a parent that waits for all of them as soon as one fails',
    async () => {
      const place = await roots();
      const broken = {
        response: () =>
          new Response(JSON.stringify({ error: { message: 'bad request' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      };
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'broken', agent: 'explorer', goal: 'fail' },
              { name: 'slow', agent: 'explorer', goal: 'answer after a while' },
            ),
            sleepFor(children()),
            // Woken by the failure: slow still runs, so this sleep is taken.
            sleepFor(children()),
            reply('handled the failure'),
          ],
        },
        {
          broken: [broken, broken, broken, broken],
          slow: [{ wait: delay(3000), then: finish('slow result') }],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('handled the failure');
      expect(seen(provider)).not.toContain('Not asleep');
    },
    TIMEOUT,
  );
});

real('stopping and interrupting cancel the work in flight (Orchestration 5.1, 5.2)', () => {
  it(
    'stops a task in the middle of a long command at once, and the parent goes on',
    async () => {
      const place = await roots({ 'scan/.keep': '' });
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'scan', agent: 'worker', goal: 'scan slowly', writeScope: ['scan'] }),
            {
              wait: delay(1500),
              then: tool('stop_subagents', { names: ['scan'], reason: 'enough' }),
            },
            sleepFor(children()),
            reply('stopped the scan'),
          ],
        },
        {
          scan: [
            tool('run_command', {
              command: 'sleep 60; echo done > scan/result.txt',
              timeoutMs: 120_000,
              promoteOnTimeout: false,
            }),
            finish('should not be reached'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      const started = Date.now();
      await chat.say('scan, then stop it');
      expect(chat.printed('REPLY')).toContain('stopped the scan');
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(await exists(join(place.repository, 'scan/result.txt'))).toBe(false);
      expect(seen(provider)).toContain('stopped by its parent: enough');
      expect(seen(provider)).not.toContain('should not be reached');
    },
    TIMEOUT,
  );

  it(
    'interrupts a task in the middle of a long command at once: it starts again with the message',
    async () => {
      const place = await roots({ 'scan/.keep': '' });
      const provider = scriptedAgents(
        {
          main: [
            spawn({ name: 'scan', agent: 'worker', goal: 'scan slowly', writeScope: ['scan'] }),
            {
              wait: delay(1500),
              then: tool('send_message', { to: 'scan', text: 'Report now', interrupt: true }),
            },
            sleepFor(children()),
            reply('it reported'),
          ],
        },
        {
          scan: [
            tool('run_command', {
              command: 'sleep 60',
              timeoutMs: 120_000,
              promoteOnTimeout: false,
            }),
            finish('reported at once'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      const started = Date.now();
      await chat.say('scan, then hurry it');
      expect(chat.printed('REPLY')).toContain('it reported');
      expect(Date.now() - started).toBeLessThan(30_000);
      const scan = seenBy(provider, 'scan');
      expect(scan).toContain('⚠ INTERRUPT from your parent task main');
      expect(scan).toContain('this call was stopped before it finished');
    },
    TIMEOUT,
  );
});

describe('requests, replies and attachments between tasks (Orchestration 5.3, D25)', () => {
  /** A call made when it is answered, from what the provider has received by then. */
  const later = (make: () => { name: string; arguments: unknown }) => ({
    get calls() {
      return [make()];
    },
  });
  const requestIdIn = (provider: ScriptedChat): string =>
    /Request (\S+) from task/u.exec(seen(provider))?.[1] ?? 'none';
  const ownCallId = (provider: ScriptedChat, task: string, tool: string): string => {
    for (const request of provider.requests) {
      if (!request.messages.some((message) => textOf(message).includes(`Your task (${task},`)))
        continue;
      for (const message of request.messages)
        for (const call of message.tool_calls ?? [])
          if (call.function.name === tool && call.id !== undefined) return call.id;
    }
    return 'none';
  };

  it(
    'asks a sibling, gets its reply, and the reply names the request',
    async () => {
      const place = await roots();
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'asker', agent: 'explorer', goal: 'ask the other' },
              { name: 'answerer', agent: 'explorer', goal: 'answer the other' },
            ),
            sleepFor(children()),
            reply('they talked'),
          ],
        },
        {
          asker: [
            tool('send_message', {
              to: 'answerer',
              kind: 'request',
              summary: 'Which port does the API use?',
              text: 'I need the port to write the client.',
            }),
            sleepFor({ kind: 'message' }),
            finish('got the port'),
          ],
          answerer: [
            sleepFor({ kind: 'message' }),
            later(() => ({
              name: 'send_message',
              arguments: {
                to: 'asker',
                kind: 'reply',
                replyTo: requestIdIn(provider),
                summary: 'Port 8080',
                text: 'The API listens on 8080.',
              },
            })),
            finish('answered'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('let them talk');
      expect(chat.printed('REPLY')).toContain('they talked');
      expect(seenBy(provider, 'answerer')).toContain('Summary: Which port does the API use?');
      const asker = seenBy(provider, 'asker');
      expect(asker).toContain('Reply from task answerer to your message');
      expect(asker).toContain('The API listens on 8080.');
    },
    TIMEOUT,
  );

  it(
    'tells the task that asked when the other ends without answering, and wakes it',
    async () => {
      const place = await roots();
      const provider = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'asker', agent: 'explorer', goal: 'ask the other' },
              { name: 'silent', agent: 'explorer', goal: 'do not answer' },
            ),
            sleepFor(children()),
            reply('handled the silence'),
          ],
        },
        {
          asker: [
            tool('send_message', { to: 'silent', kind: 'request', text: 'Are you there?' }),
            sleepFor({ kind: 'message' }),
            finish('no answer came'),
          ],
          silent: [sleepFor({ kind: 'message' }), finish('ignored it')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('ask');
      expect(chat.printed('REPLY')).toContain('handled the silence');
      expect(seenBy(provider, 'asker')).toContain(
        'Task silent ended without answering your request',
      );
    },
    TIMEOUT,
  );

  it(
    'hands a tool result over with a message, readable by its receiver',
    async () => {
      const place = await roots({ 'notes.md': 'the secret number is 42\n' });
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn({ name: 'reader', agent: 'explorer', goal: 'read the notes' }),
            sleepFor(children()),
            later(() => ({
              name: 'read_output',
              arguments: {
                toolCallId:
                  /read_output\): (ref_\d+\/\S+) \(read_file\)/u.exec(seen(provider))?.[1] ??
                  'none',
              },
            })),
            reply('got it'),
          ],
        },
        {
          reader: [
            tool('read_file', { path: 'notes.md' }),
            later(() => ({
              name: 'send_message',
              arguments: {
                to: 'parent',
                summary: 'The notes, attached',
                text: 'Here is what I read.',
                references: [ownCallId(provider, 'reader', 'read_file')],
              },
            })),
            finish('sent'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('read');
      expect(chat.printed('REPLY')).toContain('got it');
      expect(seen(provider)).toMatch(
        /Attached tool results \(read with read_output\): ref_\d+\/\S+ \(read_file\)/u,
      );
      // The receiver (main, whose requests carry no task of their own) read what was attached.
      const mainSaw = provider.requests
        .filter(
          (request) => !request.messages.some((message) => textOf(message).includes('Your task (')),
        )
        .flatMap((request) => request.messages.map((message) => textOf(message)))
        .join('\n');
      expect(mainSaw).toContain('the secret number is 42');
    },
    TIMEOUT,
  );
});

describe('a message or a look at the tree with other tool calls (Orchestration 5.3)', () => {
  /** What main read: its requests carry no task of their own. */
  const mainSaw = (provider: ScriptedChat): string =>
    provider.requests
      .filter(
        (request) => !request.messages.some((message) => textOf(message).includes('Your task (')),
      )
      .flatMap((request) => request.messages.map((message) => textOf(message)))
      .join('\n');

  it(
    'runs a message and a read in one reply, and goes on when both are back',
    async () => {
      const place = await roots({ 'notes.md': 'the port is 8080\n' });
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn({ name: 'reader', agent: 'explorer', goal: 'read the notes and tell me' }),
            // The message wakes main; it sleeps again until the reader has finished.
            sleepFor(children()),
            sleepFor(children()),
            reply('heard from it'),
          ],
        },
        {
          reader: [
            {
              calls: [
                { name: 'read_file', arguments: { path: 'notes.md' } },
                {
                  name: 'send_message',
                  arguments: { to: 'parent', text: 'Reading the notes now.' },
                },
                { name: 'view_tasks', arguments: {} },
              ],
            },
            finish('the port is 8080'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('heard from it');
      const reader = seenBy(provider, 'reader');
      // All three calls ran in the same round: the file, the message and the tree.
      expect(reader).toContain('the port is 8080');
      expect(reader).toContain('Sent to main.');
      expect(reader).toMatch(/reader \(explorer/u);
      expect(reader).not.toContain('Not executed');
      expect(mainSaw(provider)).toContain('Reading the notes now.');
    },
    TIMEOUT,
  );

  it(
    'sends two messages of one reply, each to its task',
    async () => {
      const place = await roots();
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'teller', agent: 'explorer', goal: 'tell the others' },
              { name: 'left', agent: 'explorer', goal: 'listen' },
              { name: 'right', agent: 'explorer', goal: 'listen' },
            ),
            sleepFor(children()),
            reply('all told'),
          ],
        },
        {
          teller: [
            {
              calls: [
                { name: 'send_message', arguments: { to: 'left', text: 'Left: use port 8080.' } },
                { name: 'send_message', arguments: { to: 'right', text: 'Right: use port 9090.' } },
              ],
            },
            finish('told both'),
          ],
          left: [sleepFor({ kind: 'message' }), finish('heard')],
          right: [sleepFor({ kind: 'message' }), finish('heard')],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('all told');
      expect(seenBy(provider, 'left')).toContain('Left: use port 8080.');
      expect(seenBy(provider, 'right')).toContain('Right: use port 9090.');
    },
    TIMEOUT,
  );

  it(
    'still refuses a call that must be alone, naming it and saying that nothing ran',
    async () => {
      const place = await roots({ 'notes.md': 'notes\n' });
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn({ name: 'mixer', agent: 'explorer', goal: 'read, then finish' }),
            sleepFor(children()),
            reply('done'),
          ],
        },
        {
          mixer: [
            {
              calls: [
                { name: 'read_file', arguments: { path: 'notes.md' } },
                { name: 'finish_subagent', arguments: { summary: 'too early' } },
              ],
            },
            finish('finished on its own'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('done');
      const mixer = seenBy(provider, 'mixer');
      expect(mixer).toContain(
        'Not executed: finish_subagent must be the only tool call in its reply, and this reply also had read_file.',
      );
      expect(mixer).toContain('None of the 2 calls of this reply ran, finish_subagent included');
    },
    TIMEOUT,
  );
});

describe('a request is answered, an inform need not be (Orchestration 5.3)', () => {
  const requestIdIn = (provider: ScriptedChat): string =>
    /Request (\S+) from task/u.exec(seen(provider))?.[1] ?? 'none';

  it(
    'reminds a task that left a request unanswered, then refuses its reply until it answers',
    async () => {
      const place = await roots({ 'a.md': 'alpha\n', 'b.md': 'beta\n' });
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'teller', agent: 'explorer', goal: 'tell the other' },
              { name: 'listener', agent: 'explorer', goal: 'listen' },
            ),
            sleepFor(children()),
            reply('they talked'),
          ],
        },
        {
          teller: [
            tool('send_message', {
              to: 'listener',
              kind: 'request',
              text: 'The API is on port 8080: confirm.',
            }),
            sleepFor({ kind: 'message' }),
            finish('told it'),
          ],
          listener: [
            sleepFor({ kind: 'message' }),
            // The first round that reads it does not answer: the next one is reminded.
            tool('read_file', { path: 'a.md' }),
            // Reminded, and still no answer: nothing of this reply runs.
            tool('read_file', { path: 'b.md' }),
            {
              get calls() {
                return [
                  {
                    name: 'send_message',
                    arguments: {
                      to: 'teller',
                      kind: 'reply',
                      replyTo: requestIdIn(provider),
                      text: 'Got it.',
                    },
                  },
                ];
              },
            },
            finish('heard'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('they talked');
      const listener = seenBy(provider, 'listener');
      expect(listener).toContain('answer it in this reply with send_message kind reply');
      expect(listener).toContain('alpha');
      expect(listener).toContain('You have not answered this request');
      expect(listener).toContain('Not executed: you still have not answered');
      expect(listener).not.toContain('beta');
      expect(seenBy(provider, 'teller')).toContain('Got it.');
    },
    TIMEOUT,
  );

  it(
    'lets an inform go unanswered: nothing is reminded or refused',
    async () => {
      const place = await roots({ 'a.md': 'alpha\n', 'b.md': 'beta\n' });
      const provider: ScriptedChat = scriptedAgents(
        {
          main: [
            spawn(
              { name: 'reporter', agent: 'explorer', goal: 'report progress' },
              { name: 'worker', agent: 'explorer', goal: 'work on' },
            ),
            sleepFor(children()),
            reply('heard the progress'),
          ],
        },
        {
          // The reporter sleeps until the worker has read it, so the inform stays owed if it were.
          reporter: [
            tool('send_message', { to: 'worker', text: 'Half done.' }),
            sleepFor({ kind: 'message' }),
            finish('done'),
          ],
          // Three rounds read the inform without answering it, and every call of them runs.
          worker: [
            sleepFor({ kind: 'message' }),
            tool('read_file', { path: 'a.md' }),
            tool('read_file', { path: 'b.md' }),
            tool('send_message', { to: 'reporter', text: 'Finished too.' }),
            finish('worked'),
          ],
        },
      );
      const chat = await chatOn(place, provider);
      await chat.say('go');
      expect(chat.printed('REPLY')).toContain('heard the progress');
      const worker = seenBy(provider, 'worker');
      expect(worker).toContain('Half done.');
      expect(worker).toContain('no answer is needed');
      expect(worker).toContain('alpha');
      expect(worker).toContain('beta');
      expect(worker).not.toContain('You have not answered');
      expect(worker).not.toContain('Not executed: you still have not answered');
    },
    TIMEOUT,
  );
});
