/**
 * The deterministic exit cases of stage 5 (M2Plan 6.6; M2Design 13): what the user does to a run
 * while it works (H1, H2, H11, H12) and a question the agent waits on (H4). Every case runs the real
 * product from the console down to the Executors, with only the provider's HTTP API scripted; what
 * the model would see is read from the requests the provider received. A model call that waits is
 * a scripted turn behind a gate, which the cancel of a pause or an abort ends like a real request.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openChat,
  scriptedAgents,
  textOf,
  tool,
  until,
  type Chat,
  type ChatOptions,
  type ScriptedChat,
} from './chat-driver.js';

const TIMEOUT = 60_000;
const directories: string[] = [];
const open: Chat[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function chatOn(provider: ScriptedChat, options: Partial<ChatOptions> = {}): Promise<Chat> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-stage5-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-stage5-repo-'));
  directories.push(dataDir, repository);
  await mkdir(dirname(join(repository, 'a.txt')), { recursive: true });
  await writeFile(join(repository, 'a.txt'), 'one\n');
  const chat = await openChat({ dataDir, repository, provider, ...options });
  open.push(chat);
  return chat;
}

const reply = (text: string) => tool('reply', { text });
const todos = () =>
  tool('update_todos', { todos: [{ content: 'look around', status: 'in_progress' }] });
const requestText = (request: ScriptedChat['requests'][number] | undefined): string =>
  (request?.messages ?? []).map((message) => textOf(message)).join('\n');
const everything = (provider: ScriptedChat): string =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const gate = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};
const status = (chat: Chat) => chat.lives.at(-1)?.status;
const asked = (provider: ScriptedChat, count: number) =>
  until(() => provider.requests.length >= count, `${String(count)} model requests`);

describe('H1: pause, then continue with a note', () => {
  it(
    'cancels the model call that was out, and makes the next one with the note in it',
    async () => {
      const held = gate();
      const provider = scriptedAgents({
        main: [{ wait: held.opened, then: reply('not seen') }, reply('done the other way')],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('do it');
      await asked(provider, 1);

      await chat.console.interrupt();
      await until(() => status(chat) === '已暂停', 'the run to be paused');
      expect(chat.lives.at(-1)?.hint).toContain('/continue');
      // Nothing was asked of the model while it is paused.
      expect(provider.requests).toHaveLength(1);

      await chat.console.submit('/continue 改用另一种实现');
      await until(() => chat.printed('REPLY').length >= 1, 'the reply');
      expect(chat.printed('REPLY')).toEqual(['done the other way']);
      expect(provider.requests).toHaveLength(2);
      // The note is the user's message in the context of the call that was made again.
      expect(requestText(provider.requests[1])).toContain('改用另一种实现');
      expect(chat.printed('ERROR')).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('H2 and H12: pause, abort, and go on in the same conversation', () => {
  it(
    'ends the Turn and keeps the run open, and the next message goes on from the same history',
    async () => {
      const held = gate();
      const provider = scriptedAgents({
        main: [{ wait: held.opened, then: reply('never') }, reply('continuing')],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('first task');
      await asked(provider, 1);
      await chat.console.interrupt();
      await until(() => status(chat) === '已暂停', 'the run to be paused');
      await chat.console.interrupt();
      await until(() => status(chat) === '等待输入', 'the Turn to end');
      expect(chat.printed('ERROR').join('\n')).toContain('已中止');
      expect(chat.printed('REPLY')).toEqual([]);

      await chat.say('继续');
      expect(chat.printed('REPLY')).toEqual(['continuing']);
      // main knows that the last run was stopped, and still has its first message.
      const seen = everything(provider);
      expect(seen).toContain('first task');
      expect(seen).toContain('the user stopped it');
    },
    TIMEOUT,
  );
});

describe('H11: a note while the run goes on', () => {
  it(
    'reaches main at its next call, without pausing anything',
    async () => {
      const held = gate();
      const provider = scriptedAgents({
        main: [{ wait: held.opened, then: todos() }, reply('looked at both')],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('look at a.txt');
      await asked(provider, 1);
      await chat.console.steer('也看看 b.txt');
      held.open();
      await until(() => chat.printed('REPLY').length >= 1, 'the reply');
      expect(provider.requests).toHaveLength(2);
      expect(requestText(provider.requests[0])).not.toContain('b.txt');
      expect(requestText(provider.requests[1])).toContain('也看看 b.txt');
      expect(chat.printed('REPLY')).toEqual(['looked at both']);
    },
    TIMEOUT,
  );
});

describe('H4: ask_user', () => {
  it(
    'waits for the answer and goes on with it as the result of the call',
    async () => {
      const provider = scriptedAgents({
        main: [
          tool('ask_user', { kind: 'ask', question: 'which file first?' }),
          reply('starting with the second'),
        ],
      });
      const chat = await chatOn(provider);
      await chat.console.submit('work on the files');
      await until(() => chat.lives.at(-1)?.pending?.kind === 'QUESTION', 'the question');
      expect(chat.lives.at(-1)?.pending?.text).toContain('which file first?');
      // The agent waits: no further call of the model, and the run is not over.
      expect(provider.requests).toHaveLength(1);
      expect(chat.printed('REPLY')).toEqual([]);

      await chat.console.submit('第二个');
      await until(() => chat.printed('REPLY').length >= 1, 'the reply');
      expect(provider.requests).toHaveLength(2);
      const request = provider.requests[1];
      const answer = request?.messages.find((message) => textOf(message).includes('第二个'));
      expect(textOf(answer)).toContain('The user answered');
      // It is the result of the call, so the history stays valid for the provider.
      expect(answer?.role).toBe('tool');
      expect(chat.printed('REPLY')).toEqual(['starting with the second']);
    },
    TIMEOUT,
  );
});
