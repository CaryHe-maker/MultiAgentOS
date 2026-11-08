/**
 * The thinking of a model call, streamed beside the work (docs/M2/Phase1Console.md 4): it reaches
 * the console while the call runs, it is folded after two Turns, and it changes nothing the
 * system decides and writes nothing into the Session log.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openChat, scriptedChat, until, type Chat, type ProviderTurn } from './chat-driver.js';

const TIMEOUT = 60_000;
const directories: string[] = [];
const open: Chat[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** An answer that thinks first and then replies. */
const thinking = (reasoning: string, text: string): ProviderTurn => ({
  calls: [{ name: 'reply', arguments: { text } }],
  reasoning,
});

async function conversation(...turns: ProviderTurn[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-think-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-think-repo-'));
  directories.push(dataDir, repository);
  await writeFile(join(repository, 'a.txt'), 'one\n');
  const chat = await openChat({ dataDir, repository, provider: scriptedChat(...turns) });
  open.push(chat);
  return { chat, dataDir };
}

const thinkingSeen = (chat: Chat) =>
  chat.lives.flatMap((live) => live.thinking ?? []).map((block) => block.text);

describe('thinking streamed to the console', () => {
  it(
    'reaches the console while the call runs, in pieces, and ends done',
    async () => {
      const { chat } = await conversation(
        thinking('The user says hi. I should greet back and keep it short.', 'Hello!'),
      );
      await chat.say('hi');
      await until(() => chat.lives.at(-1)?.thinking?.[0]?.state === 'DONE', 'the thinking to end');
      const seen = thinkingSeen(chat);
      // A scripted answer comes whole, inside one merge window; that it arrives in pieces for a
      // real provider is covered by the Executor's and the merger's tests.
      expect(seen.at(-1)).toBe('The user says hi. I should greet back and keep it short.');
      expect(chat.lives.at(-1)?.thinking?.[0]).toMatchObject({ label: 'main', number: 1 });
      // The answer is the same as without watching.
      expect(chat.printed('REPLY')).toEqual(['Hello!']);
    },
    TIMEOUT,
  );

  it(
    'says that a reply is being written, without its text, and hands over to the reply itself',
    async () => {
      const text = 'The answer is a rather long sentence, written in several pieces.';
      const { chat } = await conversation(thinking('short thought', text));
      await chat.say('hi');
      await until(() => chat.printed('REPLY').length === 1, 'the reply');
      const writing = (live: (typeof chat.lives)[number]) =>
        live.activity.filter((line) => line.phase === '正在输出回答');
      const seen = chat.lives.flatMap(writing);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toMatchObject({ label: 'main' });
      // The text is only there when it is published: the live state carries none of it.
      expect(JSON.stringify(chat.lives)).not.toContain(text);
      // Once the reply is printed, nothing is being written any more.
      await until(
        () => chat.lives.at(-1) !== undefined && writing(chat.lives.at(-1)!).length === 0,
        'the line to go',
      );
      expect(chat.printed('REPLY')).toEqual([text]);
    },
    TIMEOUT,
  );

  it(
    'is not written into the Session log, which holds only the reference to the whole thinking',
    async () => {
      const secret = 'a-very-distinctive-thought-that-must-not-be-in-the-log';
      const { chat, dataDir } = await conversation(thinking(secret, 'ok'));
      await chat.say('hi');
      await until(() => thinkingSeen(chat).at(-1) === secret, 'the thinking to arrive');
      const [sessionId] = await readdir(join(dataDir, 'sessions'));
      const log = await readFile(
        join(dataDir, 'sessions', sessionId ?? '', 'workflow', 'log.v1.jsonl'),
        'utf8',
      );
      expect(log).not.toContain(secret);
      expect(log).toContain('reasoningRef');
    },
    TIMEOUT,
  );

  it(
    'numbers every model call, and /think has the whole of each',
    async () => {
      const { chat } = await conversation(
        thinking('first thought', 'one'),
        thinking('second thought', 'two'),
        thinking('third thought', 'three'),
      );
      await chat.say('a');
      await chat.say('b');
      await chat.say('c');
      await until(
        () =>
          chat.lives
            .at(-1)
            ?.thinking?.map((block) => block.number)
            .join() === '1,2,3',
        'three numbered blocks',
      );
      expect(chat.lives.at(-1)?.thinking?.map((block) => block.text)).toEqual([
        'first thought',
        'second thought',
        'third thought',
      ]);

      await chat.console.submit('/think 1');
      expect(chat.printed('THINKING').at(-1)).toContain('first thought');
      await chat.console.submit('/think');
      expect(chat.printed('NOTICE').at(-1)).toContain('第 3 段');
      await chat.console.submit('/think 9');
      expect(chat.printed('NOTICE').at(-1)).toContain('没有第 9 段思考');
    },
    TIMEOUT,
  );

  it(
    'strips control characters from what the model thought before it reaches the screen',
    async () => {
      const { chat } = await conversation(thinking('fine\u001b[2J\u001b]0;owned\u0007 text', 'ok'));
      await chat.say('hi');
      await until(() => thinkingSeen(chat).length > 0, 'the thinking');
      const last = thinkingSeen(chat).at(-1) ?? '';
      expect(last).not.toContain('\u001b');
      expect(last).not.toContain('\u0007');
      expect(last).toContain('fine');
    },
    TIMEOUT,
  );
});

describe('how full the context is, from the Kernel to the console', () => {
  it(
    'is told after each assembly of main, never before the first, and is a share of its limit',
    async () => {
      const { chat } = await conversation(thinking('a thought', 'one'), thinking('another', 'two'));
      await chat.say('hi');
      await until(() => chat.printed('REPLY').length === 1, 'the first reply');
      await until(
        () => chat.lives.some((live) => live.context !== undefined),
        'the share of the context',
      );
      // Nothing of the kind before the first assembly of this Session.
      expect(chat.lives.find((live) => live.context !== undefined)).toBeDefined();
      const first = chat.lives.findIndex((live) => live.context !== undefined);
      expect(chat.lives.slice(0, first).every((live) => live.context === undefined)).toBe(true);
      const shares = chat.lives.flatMap((live) =>
        live.context === undefined ? [] : [live.context],
      );
      expect(shares.every((share) => share >= 0 && share <= 100)).toBe(true);
      // A small conversation takes a small share of the limit of main.
      expect(Math.max(...shares)).toBeLessThan(5);
    },
    TIMEOUT,
  );
});
