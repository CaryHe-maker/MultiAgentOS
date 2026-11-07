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
      expect(chat.lives.at(-1)?.thinking?.[0]).toMatchObject({ label: 'main', turn: 1 });
      // The answer is the same as without watching.
      expect(chat.printed('REPLY')).toEqual(['Hello!']);
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
    'shows the current and the previous Turn, folds older ones to a line, and /think has them all',
    async () => {
      const { chat } = await conversation(
        thinking('first turn thought', 'one'),
        thinking('second turn thought', 'two'),
        thinking('third turn thought', 'three'),
      );
      await chat.say('a');
      await chat.say('b');
      await until(
        () => chat.lives.at(-1)?.thinking?.some((block) => block.turn === 2) === true,
        'the second Turn',
      );
      // Two Turns are in view, nothing folded yet.
      expect(chat.printed('THINKING')).toEqual([]);
      expect(chat.lives.at(-1)?.thinking?.map((block) => block.turn)).toEqual([1, 2]);

      await chat.say('c');
      await until(
        () => chat.printed('THINKING').some((line) => line.includes('第 1 轮思考')),
        'the first Turn to fold',
      );
      // The live area now holds Turns 2 and 3 only.
      await until(
        () =>
          chat.lives
            .at(-1)
            ?.thinking?.map((block) => block.turn)
            .join() === '2,3',
        'the view to move on',
      );

      await chat.console.submit('/think 1');
      expect(chat.printed('THINKING').at(-1)).toContain('first turn thought');
      await chat.console.submit('/think');
      expect(chat.printed('NOTICE').at(-1)).toContain('第 3 轮');
      await chat.console.submit('/think 9');
      expect(chat.printed('NOTICE').at(-1)).toContain('第 9 轮没有思考内容');
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
