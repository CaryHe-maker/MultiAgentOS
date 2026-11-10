/**
 * A Session opened in another folder (M2Design 2.3), through the real product with a scripted
 * provider: Kernel, Workflow, the console and git, two folders and one data directory. Each case
 * is a way the folder of a Session can change, or go away, and what must hold afterwards:
 * the user is asked first; the conversation and its artifacts come along; the project
 * instructions, the file baselines and the snapshots are the new folder's; nothing is undone
 * across the change; and a folder that is gone does not stop the run or the Session.
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { completionResponse } from '../support/scripted-model.js';
import {
  listSessions,
  openChat,
  reply,
  scriptedChat,
  textOf,
  tool,
  until,
  type Chat,
  type ProviderTurn,
} from './chat-driver.js';

const TIMEOUT = 120_000;
const AWAITING = '等待输入';
const directories: string[] = [];
const open: Chat[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const seed = async (root: string, files: Readonly<Record<string, string>>) => {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
};

/** Two folders, each with a file of its own and project instructions of its own, and one data directory. */
async function places() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-switch-data-'));
  const a = await mkdtemp(join(tmpdir(), 'mas-switch-a-'));
  const b = await mkdtemp(join(tmpdir(), 'mas-switch-b-'));
  directories.push(dataDir, a, b);
  await seed(a, { 'a.txt': 'content-of-A\n', 'AGENTS.md': 'RULES-OF-A: say A.\n' });
  await seed(b, { 'a.txt': 'content-of-B\n', 'AGENTS.md': 'RULES-OF-B: say B.\n' });
  return { dataDir, a, b, aRoot: await realpath(a), bRoot: await realpath(b) };
}

async function chatOn(
  dataDir: string,
  repository: string,
  provider: ReturnType<typeof scriptedChat>,
) {
  const chat = await openChat({ dataDir, repository, provider });
  open.push(chat);
  return chat;
}

const turnEnded = (chat: Chat) =>
  until(() => chat.lives.at(-1)?.status.includes(AWAITING) === true, 'the end of the Turn');
const sessionsIn = (dataDir: string) => readdir(join(dataDir, 'sessions'));
const readLog = async (dataDir: string, sessionId: string) =>
  (await readFile(join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const readSnapshotIndex = async (dataDir: string, sessionId: string) =>
  (
    await readFile(
      join(dataDir, 'sessions', sessionId, 'kernel-execution', 'snapshot-index.jsonl'),
      'utf8',
    ).catch(() => '')
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const rootOfRef = async (dataDir: string, sessionId: string) => {
  const lines = (await readFile(join(dataDir, 'kernel-core', 'session-refs.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sessionId: string; repositoryRoot: string });
  return lines.filter((line) => line.sessionId === sessionId).at(-1)?.repositoryRoot;
};
const requestText = (provider: ReturnType<typeof scriptedChat>) =>
  provider.requests
    .flatMap((request) => request.messages.map((message) => textOf(message)))
    .join('\n');
const boundRecords = (log: readonly Record<string, unknown>[]) =>
  log.filter((record) => record['type'] === 'WORKSPACE_BOUND');
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The first Turn of a new Session in `root`: it reads a.txt, so the instructions of the folder are read. */
async function firstTurnIn(
  place: Awaited<ReturnType<typeof places>>,
  root: string,
  text = 'look here',
) {
  const provider = scriptedChat(tool('read_file', { path: 'a.txt' }), reply('seen'));
  const chat = await chatOn(place.dataDir, root, provider);
  await chat.say(text);
  await turnEnded(chat);
  const [sessionId = ''] = await sessionsIn(place.dataDir);
  await chat.close();
  return { provider, sessionId };
}

/** Opens the Session of the list in `root`, saying yes when it comes from another folder. */
async function resumeIn(
  place: Awaited<ReturnType<typeof places>>,
  root: string,
  provider: ReturnType<typeof scriptedChat>,
  options: { readonly confirm: boolean } = { confirm: true },
) {
  const chat = await chatOn(place.dataDir, root, provider);
  await listSessions(chat);
  await chat.console.submit('/resume 1');
  if (options.confirm && chat.console.sessionId === undefined) {
    await until(
      () => chat.printed('NOTICE').some((notice) => notice.includes('确认请再输入一次')),
      'the question about the other folder',
    );
    await chat.console.submit('/resume 1');
  }
  if (options.confirm)
    await until(() => chat.console.sessionId !== undefined, 'the Session to open');
  return chat;
}

describe('opening a Session of another folder', () => {
  it(
    'asks first, says what it means, and opens only when told twice',
    async () => {
      const place = await places();
      const { sessionId } = await firstTurnIn(place, place.a);
      const provider = scriptedChat(reply('hello from B'));
      const chat = await resumeIn(place, place.b, provider, { confirm: false });
      // Listed under the folders of others, with the folder, and not opened.
      expect(chat.printed('NOTICE').some((notice) => notice.includes('其他文件夹的对话'))).toBe(
        true,
      );
      expect(chat.printed('LIST').join('\n')).toContain(place.aRoot);
      const asked = chat.printed('NOTICE').at(-1) ?? '';
      expect(asked).toContain('确认请再输入一次 /resume 1');
      expect(asked).toContain('快照');
      expect(chat.console.sessionId).toBeUndefined();
      // Nothing changed for the Session: not its folder, not its log, not its snapshots.
      expect(await rootOfRef(place.dataDir, sessionId)).toBe(place.aRoot);
      expect(boundRecords(await readLog(place.dataDir, sessionId))).toEqual([]);
      expect(
        (await readSnapshotIndex(place.dataDir, sessionId)).some(
          (line) => line['kind'] === 'EPOCH',
        ),
      ).toBe(false);
      await chat.console.submit('/resume 1');
      await until(() => chat.console.sessionId !== undefined, 'the Session to open');
      expect(await rootOfRef(place.dataDir, sessionId)).toBe(place.bRoot);
    },
    TIMEOUT,
  );

  it(
    'brings the conversation and drops the instructions of the old folder, reads those of the new one',
    async () => {
      const place = await places();
      const { sessionId } = await firstTurnIn(place, place.a, 'look at A first');
      const provider = scriptedChat(tool('read_file', { path: 'a.txt' }), reply('seen B'));
      const chat = await resumeIn(place, place.b, provider);
      await chat.say('now B');
      await turnEnded(chat);
      const [first = { messages: [] }, second = { messages: [] }] = provider.requests;
      const before = first.messages.map((message) => textOf(message)).join('\n');
      const after = second.messages.map((message) => textOf(message)).join('\n');
      // The conversation came along, with what the tools showed of the old folder.
      expect(before).toContain('look at A first');
      expect(before).toContain('content-of-A');
      // The model is told, before it does anything.
      expect(before).toContain('The working folder changed from');
      expect(before).toContain(place.aRoot);
      expect(before).toContain(place.bRoot);
      // The instructions of the old folder are not in what it is shown, ever.
      expect(requestText(provider)).not.toContain('RULES-OF-A');
      // Those of the new one are read when the repository is first read in the run.
      expect(before).not.toContain('RULES-OF-B');
      expect(after).toContain('RULES-OF-B');
      // The log says it, and the folder of the Session is the new one.
      const bound = boundRecords(await readLog(place.dataDir, sessionId));
      expect(bound).toMatchObject([{ repositoryRoot: place.bRoot, previousRoot: place.aRoot }]);
      expect(await rootOfRef(place.dataDir, sessionId)).toBe(place.bRoot);
    },
    TIMEOUT,
  );

  it(
    'does not tell the model that every file changed from outside',
    async () => {
      const place = await places();
      await firstTurnIn(place, place.a);
      const provider = scriptedChat(reply('ok'));
      const chat = await resumeIn(place, place.b, provider);
      await chat.say('go on');
      expect(requestText(provider)).not.toContain('changed outside this session');
    },
    TIMEOUT,
  );

  it(
    'lists the Session under the folder it is in now, after it was opened here',
    async () => {
      const place = await places();
      await firstTurnIn(place, place.a);
      const second = await resumeIn(place, place.b, scriptedChat(reply('hello')));
      await second.close();
      const again = await chatOn(place.dataDir, place.b, scriptedChat());
      await listSessions(again);
      expect(again.printed('NOTICE').some((notice) => notice.includes('其他文件夹的对话'))).toBe(
        false,
      );
      expect(again.printed('LIST').join('\n')).not.toContain('原来在');
    },
    TIMEOUT,
  );
});

describe('undoing across a change of folder', () => {
  it(
    "undoes nothing of the old folder, leaves its files as they are, and undoes the new folder's own",
    async () => {
      const place = await places();
      // In A: a Turn that rewrites a.txt.
      const inA = scriptedChat(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'changed-in-A\n' }),
        reply('written in A'),
      );
      const chatA = await chatOn(place.dataDir, place.a, inA);
      await chatA.say('change it');
      await turnEnded(chatA);
      await chatA.close();
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('changed-in-A\n');

      // Opened in B: that Turn has no way back, whatever the user asks.
      const inB = scriptedChat(
        tool('write_file', { path: 'new-in-b.txt', content: 'b\n' }),
        reply('written in B'),
      );
      const chatB = await resumeIn(place, place.b, inB);
      await turnEnded(chatB);
      await chatB.console.submit('/undo all');
      await until(
        () => chatB.printed('NOTICE').some((notice) => notice.includes('没有可以回退')),
        'the answer to the undo',
      );
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('changed-in-A\n');
      expect(await readFile(join(place.b, 'a.txt'), 'utf8')).toBe('content-of-B\n');

      // A Turn of B is undone as ever, and only it.
      await chatB.say('write here');
      await turnEnded(chatB);
      expect(await exists(join(place.b, 'new-in-b.txt'))).toBe(true);
      await chatB.console.submit('/undo all');
      await until(
        () => chatB.printed('NOTICE').some((notice) => notice.includes('已回退 1')),
        'the undo',
      );
      expect(await exists(join(place.b, 'new-in-b.txt'))).toBe(false);
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('changed-in-A\n');
    },
    TIMEOUT,
  );

  it(
    'cannot undo it either when the Session comes back to the folder it was written in',
    async () => {
      const place = await places();
      const inA = scriptedChat(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'changed-in-A\n' }),
        reply('written in A'),
      );
      const chatA = await chatOn(place.dataDir, place.a, inA);
      await chatA.say('change it');
      await turnEnded(chatA);
      await chatA.close();
      const chatB = await resumeIn(place, place.b, scriptedChat(reply('b')));
      await chatB.say('in b');
      await turnEnded(chatB);
      await chatB.close();
      const back = await resumeIn(place, place.a, scriptedChat(reply('back')));
      await turnEnded(back);
      await back.console.submit('/undo all');
      await until(
        () => back.printed('NOTICE').some((notice) => notice.includes('没有可以回退')),
        'the answer to the undo',
      );
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('changed-in-A\n');
    },
    TIMEOUT,
  );

  it(
    'keeps an undo done before the change as it was',
    async () => {
      const place = await places();
      const inA = scriptedChat(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'changed-in-A\n' }),
        reply('written in A'),
      );
      const chatA = await chatOn(place.dataDir, place.a, inA);
      await chatA.say('change it');
      await turnEnded(chatA);
      await chatA.console.submit('/undo');
      await until(
        () => chatA.printed('NOTICE').some((notice) => notice.includes('已回退 1')),
        'the undo',
      );
      await chatA.close();
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('content-of-A\n');
      const chatB = await resumeIn(place, place.b, scriptedChat(reply('b')));
      await chatB.say('in b');
      expect(await readFile(join(place.a, 'a.txt'), 'utf8')).toBe('content-of-A\n');
    },
    TIMEOUT,
  );
});

describe('changing back and forth', () => {
  it(
    'binds again every time, each folder shows only its own instructions, and the log is one chain',
    async () => {
      const place = await places();
      const { sessionId } = await firstTurnIn(place, place.a, 'first in A');
      const route: [string, string, string][] = [
        [place.b, 'RULES-OF-B', 'RULES-OF-A'],
        [place.a, 'RULES-OF-A', 'RULES-OF-B'],
        [place.b, 'RULES-OF-B', 'RULES-OF-A'],
        [place.a, 'RULES-OF-A', 'RULES-OF-B'],
      ];
      for (const [root, wanted, unwanted] of route) {
        const provider = scriptedChat(tool('read_file', { path: 'a.txt' }), reply('seen'));
        const chat = await resumeIn(place, root, provider);
        await chat.say('turn in this folder');
        await turnEnded(chat);
        const all = requestText(provider);
        expect(all).toContain(wanted);
        expect(all).not.toContain(unwanted);
        expect(all).toContain('first in A');
        await chat.close();
      }
      const log = await readLog(place.dataDir, sessionId);
      expect(
        boundRecords(log).map((record) => [record['previousRoot'], record['repositoryRoot']]),
      ).toEqual([
        [place.aRoot, place.bRoot],
        [place.bRoot, place.aRoot],
        [place.aRoot, place.bRoot],
        [place.bRoot, place.aRoot],
      ]);
      expect(log.map((record) => record['seq'])).toEqual(log.map((_, index) => index + 1));
      expect(await rootOfRef(place.dataDir, sessionId)).toBe(place.aRoot);
      expect(
        (await readSnapshotIndex(place.dataDir, sessionId)).filter(
          (line) => line['kind'] === 'EPOCH',
        ),
      ).toHaveLength(4);
    },
    TIMEOUT * 2,
  );

  it(
    'opens in the folder it is in without asking, however often it has been moved',
    async () => {
      const place = await places();
      await firstTurnIn(place, place.a);
      const inB = await resumeIn(place, place.b, scriptedChat(reply('b')));
      await inB.say('b');
      await inB.close();
      const again = await chatOn(place.dataDir, place.b, scriptedChat(reply('again')));
      await listSessions(again);
      await again.console.submit('/resume 1');
      await until(() => again.console.sessionId !== undefined, 'the Session to open');
      expect(again.printed('NOTICE').some((notice) => notice.includes('确认请再输入一次'))).toBe(
        false,
      );
    },
    TIMEOUT,
  );
});

describe('a folder that is gone', () => {
  it(
    'before the Session is opened elsewhere: it is listed with the folder it was in, and opens in the new one',
    async () => {
      const place = await places();
      const { sessionId } = await firstTurnIn(place, place.a, 'work in A');
      await rm(place.a, { recursive: true, force: true });
      const provider = scriptedChat(tool('read_file', { path: 'a.txt' }), reply('seen B'));
      const chat = await resumeIn(place, place.b, provider);
      expect(chat.printed('LIST').join('\n')).toContain(place.aRoot);
      await chat.say('go on');
      await turnEnded(chat);
      expect(requestText(provider)).toContain('work in A');
      expect(requestText(provider)).not.toContain('RULES-OF-A');
      expect(requestText(provider)).toContain('RULES-OF-B');
      expect(boundRecords(await readLog(place.dataDir, sessionId))).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'recreated empty at the same path: the Session opens there at once, and the model is told the files are gone',
    async () => {
      const place = await places();
      await firstTurnIn(place, place.a);
      await rm(place.a, { recursive: true, force: true });
      await mkdir(place.a, { recursive: true });
      const provider = scriptedChat(reply('hello'));
      const chat = await resumeIn(place, place.a, provider, { confirm: false });
      await until(() => chat.console.sessionId !== undefined, 'the Session to open');
      expect(chat.printed('NOTICE').some((notice) => notice.includes('确认请再输入一次'))).toBe(
        false,
      );
      await chat.say('anyone there');
      expect(requestText(provider)).toContain('changed outside this session');
      expect(requestText(provider)).toContain('a.txt');
    },
    TIMEOUT,
  );

  it(
    'in the middle of a run: the tool fails, the Turn ends, the next Turn runs, and the Session opens elsewhere',
    async () => {
      const place = await places();
      const vanish: ProviderTurn = {
        response: async () => {
          await rm(place.a, { recursive: true, force: true });
          return completionResponse(
            { calls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] },
            'vanished',
          );
        },
      };
      const inA = scriptedChat(
        tool('read_file', { path: 'a.txt' }),
        vanish,
        reply('after the loss'),
      );
      const chatA = await chatOn(place.dataDir, place.a, inA);
      await chatA.say('read twice');
      await turnEnded(chatA);
      expect(chatA.printed('REPLY').join('\n')).toContain('after the loss');
      // The folder is gone for good: the next Turn still runs, without a way back.
      inA.add(reply('still here'));
      await chatA.say('and now');
      expect(chatA.printed('REPLY').join('\n')).toContain('still here');
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      await chatA.close();

      const inB = scriptedChat(reply('in B'));
      const chatB = await resumeIn(place, place.b, inB);
      await chatB.say('here now');
      expect(chatB.printed('REPLY').join('\n')).toContain('in B');
      expect(requestText(inB)).toContain('read twice');
      expect(boundRecords(await readLog(place.dataDir, sessionId))).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe('what a change of folder leaves the model that it cannot use', () => {
  it(
    'is the tool results about the old folder, and nothing it is told is hidden from it',
    async () => {
      const place = await places();
      await firstTurnIn(place, place.a, 'what is in a.txt');
      const provider = scriptedChat(reply('noted'));
      const chat = await resumeIn(place, place.b, provider);
      await chat.say('and now?');
      const text = requestText(provider);
      // It still sees what the old folder held, and is told that it may not hold any more.
      expect(text).toContain('content-of-A');
      expect(text).toContain('may not exist in the new one');
    },
    TIMEOUT,
  );
});
