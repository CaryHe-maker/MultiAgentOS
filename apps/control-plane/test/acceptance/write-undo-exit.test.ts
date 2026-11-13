/**
 * The deterministic acceptance cases (M2Design 14): group A for writes and nested
 * `AGENTS.md`, H5, H8, H10, S4 and L8. All run through the real product, git included, with a
 * scripted provider; H9 and the attacks on the file tools are tested where they can be timed.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSubprocessRunner } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSessions,
  openChat,
  reply,
  scriptedChat,
  textOf,
  tool,
  until,
  type Answer,
  type Chat,
  type ChatRequest,
} from './chat-driver.js';

const TIMEOUT = 60_000;
const AWAITING = '等待输入';
const directories: string[] = [];
const open: Chat[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function roots(files: Readonly<Record<string, string>> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-write-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-write-repo-'));
  directories.push(dataDir, repository);
  for (const [name, content] of Object.entries({ 'a.txt': 'one\n', ...files })) {
    await mkdir(dirname(join(repository, name)), { recursive: true });
    await writeFile(join(repository, name), content);
  }
  return { dataDir, repository };
}

async function chatOn(
  place: { dataDir: string; repository: string },
  provider: ReturnType<typeof scriptedChat>,
  answer?: (question: string) => Answer,
): Promise<Chat> {
  const chat = await openChat({
    ...place,
    provider,
    ...(answer === undefined ? {} : { answer }),
  });
  open.push(chat);
  return chat;
}

const contents = (request: ChatRequest | undefined) =>
  (request?.messages ?? []).map((message) => textOf(message));
const lastRequest = (provider: ReturnType<typeof scriptedChat>) => provider.requests.at(-1);
const sessionsIn = (dataDir: string) => readdir(join(dataDir, 'sessions'));
const logOf = (dataDir: string, sessionId: string) =>
  readFile(join(dataDir, 'sessions', sessionId, 'workflow', 'log.v1.jsonl'), 'utf8');
/** A reply is printed before its Turn ends: undo and diff are about Turns that have ended. */
const turnEnded = (chat: Chat) =>
  until(() => chat.lives.at(-1)?.status.includes(AWAITING) === true, 'the end of the Turn');
const pendingUndo = (chat: Chat) => chat.lives.at(-1)?.pending?.kind === 'UNDO';
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A chat whose first message read a.txt and rewrote it. */
async function afterOneWrite(place: Awaited<ReturnType<typeof roots>>) {
  const provider = scriptedChat(
    tool('read_file', { path: 'a.txt' }),
    tool('write_file', { path: 'a.txt', content: 'two\n' }),
    reply('written'),
  );
  const chat = await chatOn(place, provider);
  await chat.say('first request zebra');
  await turnEnded(chat);
  return { chat, provider, file: join(place.repository, 'a.txt') };
}

describe('A: writing', () => {
  it(
    'asks once for the repository and once to write, then not again in the run',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('write_file', { path: 'b.txt', content: 'b\n' }),
        tool('write_file', { path: 'sub/c.txt', content: 'c\n' }),
        reply('done'),
        tool('write_file', { path: 'd.txt', content: 'd\n' }),
        reply('done again'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('write');
      await chat.say('write more');
      expect(chat.questions).toHaveLength(1);
      expect(chat.questions[0]).toContain('修改');
      expect(await readFile(join(place.repository, 'b.txt'), 'utf8')).toBe('b\n');
      expect(await readFile(join(place.repository, 'sub/c.txt'), 'utf8')).toBe('c\n');
      expect(await readFile(join(place.repository, 'd.txt'), 'utf8')).toBe('d\n');
    },
    TIMEOUT,
  );

  it(
    'hands a refused path back without asking, and the Turn goes on',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('write_file', { path: '.env', content: 'x' }),
        tool('write_file', { path: '../outside.txt', content: 'x' }),
        tool('write_file', { path: '.git/config', content: 'x' }),
        reply('could not'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('write');
      expect(chat.questions).toEqual([]);
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('protected');
      expect(seen).toContain('outside what you may write');
      expect(await exists(join(place.repository, '.env'))).toBe(false);
      expect(await exists(join(place.repository, '.git'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'a refusal is a tool result, the same AgentRun does not ask again, the next Turn may',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('write_file', { path: 'b.txt', content: 'b' }),
        reply('fine, I will not'),
        tool('write_file', { path: 'b.txt', content: 'b' }),
        reply('written'),
      );
      let answers = 0;
      const chat = await chatOn(place, provider, () => {
        answers += 1;
        return answers === 1 ? 'n' : 'y';
      });
      await chat.say('write');
      expect(contents(lastRequest(provider)).join('\n')).toContain('the user rejected tool');
      expect(await exists(join(place.repository, 'b.txt'))).toBe(false);
      await chat.say('please, now');
      expect(chat.questions).toHaveLength(2);
      expect(await exists(join(place.repository, 'b.txt'))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'an edit needs a read, and a file changed since the read is refused',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('edit_file', { path: 'a.txt', oldString: 'one', newString: 'uno' }),
        tool('read_file', { path: 'a.txt' }),
        tool('list_files'),
        reply('stale'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('edit');
      expect(contents(provider.requests[1]).join('\n')).toContain('read the file before editing');

      await writeFile(join(place.repository, 'a.txt'), 'changed by someone\n');
      provider.add(
        tool('edit_file', { path: 'a.txt', oldString: 'one', newString: 'uno' }),
        reply('gave up'),
      );
      await chat.say('edit it now');
      expect(contents(lastRequest(provider)).join('\n')).toContain('not as you last read it');
      expect(await readFile(join(place.repository, 'a.txt'), 'utf8')).toBe('changed by someone\n');
    },
    TIMEOUT,
  );

  it(
    'after a write, reading the file again really reads it',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('read_file', { path: 'a.txt' }),
        tool('edit_file', { path: 'a.txt', oldString: 'one', newString: 'uno' }),
        tool('read_file', { path: 'a.txt' }),
        reply('checked'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('edit and check');
      expect(contents(lastRequest(provider)).join('\n')).toContain('uno');
      expect(contents(lastRequest(provider)).join('\n')).not.toContain('Not executed');
    },
    TIMEOUT,
  );

  it(
    'several edits of one file in one reply all land, in order, without a refusal',
    async () => {
      const place = await roots({ 'many.txt': 'first\nsecond\nthird\n' });
      const edit = (oldString: string, newString: string) => ({
        name: 'edit_file',
        arguments: { path: 'many.txt', oldString, newString },
      });
      const provider = scriptedChat(
        tool('read_file', { path: 'many.txt' }),
        { calls: [edit('first', 'one'), edit('second', 'two'), edit('third', 'three')] },
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('change all three');
      expect(await readFile(join(place.repository, 'many.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).not.toContain('not as you last read it');
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      expect(await logOf(place.dataDir, sessionId)).not.toContain('FILE_CHANGED');
    },
    TIMEOUT,
  );

  it(
    'a failed edit in a reply does not stop the next edit of that file',
    async () => {
      const place = await roots({ 'many.txt': 'first\nsecond\n' });
      const edit = (oldString: string, newString: string) => ({
        name: 'edit_file',
        arguments: { path: 'many.txt', oldString, newString },
      });
      const provider = scriptedChat(
        tool('read_file', { path: 'many.txt' }),
        { calls: [edit('absent', 'x'), edit('second', 'two')] },
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('change it');
      expect(await readFile(join(place.repository, 'many.txt'), 'utf8')).toBe('first\ntwo\n');
      expect(contents(lastRequest(provider)).join('\n')).toContain('oldString is not in the file');
    },
    TIMEOUT,
  );

  it(
    'asks for each AGENTS.md with its content, and what it approved is then trusted',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('write_file', { path: 'b.txt', content: 'b' }),
        tool('write_file', { path: 'AGENTS.md', content: 'Use tabs.\n' }),
        reply('written'),
        tool('read_file', { path: 'a.txt' }),
        reply('read'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('write the rules');
      const critical = chat.questions.find((question) => question.includes('AGENTS.md'));
      expect(critical).toContain('Use tabs.');
      expect(await readFile(join(place.repository, 'AGENTS.md'), 'utf8')).toBe('Use tabs.\n');

      const asked = chat.questions.length;
      await chat.say('read something');
      expect(chat.questions.filter((q) => q.includes('是否信任'))).toEqual([]);
      expect(chat.questions.length).toBeLessThanOrEqual(asked + 1);
      expect(contents(lastRequest(provider)).join('\n')).toContain('trusted by the user');
    },
    TIMEOUT,
  );
});

describe('A: nested AGENTS.md', () => {
  it(
    'loads it on the first read below it, at the end, and only once in the run',
    async () => {
      const place = await roots({
        'pkg/AGENTS.md': 'Package rules.\n',
        'pkg/sub/AGENTS.md': 'Sub rules.\n',
        'pkg/sub/x.ts': 'x\n',
        'pkg/sub/y.ts': 'y\n',
      });
      const provider = scriptedChat(
        tool('read_file', { path: 'pkg/sub/x.ts' }),
        tool('read_file', { path: 'pkg/sub/y.ts' }),
        reply('read'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('read');
      const [, afterFirst, afterSecond] = provider.requests;
      const first = contents(afterFirst);
      const outer = first.findIndex((text) => text.includes('Package rules.'));
      const inner = first.findIndex((text) => text.includes('Sub rules.'));
      expect(outer).toBeGreaterThan(-1);
      expect(inner).toBeGreaterThan(outer);
      expect(contents(afterSecond).filter((t) => t.includes('Sub rules.'))).toHaveLength(1);
      // The status at the end moves; everything before it stays as it was.
      expect(contents(afterSecond).slice(0, first.length - 1)).toEqual(first.slice(0, -1));
      expect(chat.questions.filter((q) => q.includes('是否信任'))).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    'keeps an untrusted one as material, and notes what is beyond the limit',
    async () => {
      const files: Record<string, string> = {};
      const reads: ReturnType<typeof tool>[] = [];
      for (let i = 0; i < 9; i += 1) {
        files[`d${String(i)}/AGENTS.md`] = `Rules ${String(i)}.\n`;
        files[`d${String(i)}/f.ts`] = `f${String(i)}\n`;
        reads.push(tool('read_file', { path: `d${String(i)}/f.ts` }));
      }
      const place = await roots(files);
      const provider = scriptedChat(...reads, reply('read'));
      const chat = await chatOn(place, provider, (question) =>
        question.includes('是否信任') ? 'n' : 'y',
      );
      await chat.say('read them');
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('not trusted by the user');
      expect(seen).toContain('d8/AGENTS.md exists but was not loaded');
      expect(seen).not.toContain('Rules 8.');
    },
    TIMEOUT,
  );
});

describe('checkpoints (Orchestration 7.4, 7.5)', () => {
  it(
    'lists the start of every Turn with what changed after it, and shows the stretch of one',
    async () => {
      const place = await roots();
      const { chat, provider } = await afterOneWrite(place);
      provider.add(tool('write_file', { path: 'b.txt', content: 'bee\n' }), reply('added b'));
      await chat.say('add b');
      await turnEnded(chat);
      await chat.console.submit('/checkpoints');
      await until(
        () => chat.printed('NOTICE').some((n) => n.includes('#2  第 2 次输入')),
        'the list of checkpoints',
      );
      const list = chat.printed('NOTICE').find((n) => n.includes('#1  第 1 次输入')) ?? '';
      expect(list).toContain('#1  第 1 次输入（之后改动 1 个文件）');
      expect(list).toContain('#2  第 2 次输入（之后改动 1 个文件）');
      await chat.console.submit('/diff #2');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('+bee')), 'the diff of #2');
      expect(chat.printed('NOTICE').some((n) => n.includes('+bee') && n.includes('a.txt'))).toBe(
        false,
      );
    },
    TIMEOUT,
  );
});

describe('H5: undo and diff', () => {
  it(
    'goes back without asking, one Turn at a time, and all at once',
    async () => {
      const place = await roots();
      const { chat, provider, file } = await afterOneWrite(place);
      provider.add(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'three\n' }),
        reply('written again'),
      );
      await chat.say('again');
      expect(await readFile(file, 'utf8')).toBe('three\n');

      await turnEnded(chat);

      await chat.console.submit('/diff');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('+three')), 'the diff');

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      expect(await readFile(file, 'utf8')).toBe('two\n');
      expect(pendingUndo(chat)).toBe(false);

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(
        () => chat.printed('NOTICE').filter((n) => n.includes('已撤销')).length === 2,
        'the second undo',
      );
      expect(await readFile(file, 'utf8')).toBe('one\n');

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('没有可以回退')), 'nothing');

      provider.add(reply('hello again'));
      await chat.say('anything left?');
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('The user undid');
      expect(seen).not.toContain('first request zebra');
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      expect(await logOf(place.dataDir, sessionId)).toContain('"undo":true');
    },
    TIMEOUT,
  );

  it(
    '/undo all takes every Turn back',
    async () => {
      const place = await roots();
      const { chat, provider, file } = await afterOneWrite(place);
      provider.add(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'three\n' }),
        reply('written again'),
      );
      await chat.say('again');
      await turnEnded(chat);
      await chat.console.submit('/undo all');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      expect(await readFile(file, 'utf8')).toBe('one\n');
    },
    TIMEOUT,
  );
});

describe('H8 and H10: changes from outside', () => {
  it(
    'names them; cancel touches nothing, force overwrites',
    async () => {
      const place = await roots({ 'other.txt': 'other\n' });
      const { chat, file } = await afterOneWrite(place);
      await writeFile(file, 'by hand\n');
      await writeFile(join(place.repository, 'other.txt'), 'other by hand\n');

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(() => pendingUndo(chat), 'the confirmation');
      await chat.console.submit('n');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已取消回退')), 'the cancel');
      expect(await readFile(file, 'utf8')).toBe('by hand\n');

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(() => pendingUndo(chat), 'the second confirmation');
      await chat.console.submit('y');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      expect(await readFile(file, 'utf8')).toBe('one\n');
      // H10: not in the range of the undo, so it stays.
      expect(await readFile(join(place.repository, 'other.txt'), 'utf8')).toBe('other by hand\n');
    },
    TIMEOUT,
  );

  it(
    'the next message cancels a confirmation',
    async () => {
      const place = await roots();
      const { chat, provider, file } = await afterOneWrite(place);
      await writeFile(file, 'by hand\n');
      await turnEnded(chat);
      await chat.console.submit('/undo');
      await until(() => pendingUndo(chat), 'the confirmation');
      provider.add(reply('ok'));
      await chat.say('never mind');
      expect(chat.printed('USER')).toContain('never mind');
      expect(chat.printed('NOTICE').some((n) => n.includes('已取消回退'))).toBe(true);
      expect(pendingUndo(chat)).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('by hand\n');
    },
    TIMEOUT,
  );
});

describe('S4: forks', () => {
  it(
    'keeps two logs apart, and going back says what changed',
    async () => {
      const place = await roots();
      const { chat, provider, file } = await afterOneWrite(place);
      const [original = ''] = await sessionsIn(place.dataDir);
      const before = await logOf(place.dataDir, original);
      const fromHistory = chat.console.sessionId;

      await chat.console.submit('/fork');
      provider.add(
        tool('read_file', { path: 'a.txt' }),
        tool('write_file', { path: 'a.txt', content: 'forked\n' }),
        reply('in the fork'),
      );
      await chat.say('go on here');
      const forked = chat.console.sessionId;
      expect(forked).not.toBe(fromHistory);
      expect(await readFile(file, 'utf8')).toBe('forked\n');
      // The fork carries the history: the model still sees the first message.
      expect(contents(lastRequest(provider)).join('\n')).toContain('first request zebra');

      const forkLog = await logOf(place.dataDir, forked ?? '');
      expect(forkLog).toContain('SESSION_FORKED');
      // The original gained only what closing it wrote.
      expect((await logOf(place.dataDir, original)).startsWith(before)).toBe(true);
      expect(await logOf(place.dataDir, original)).not.toContain('go on here');

      // The fork's undo covers its own Turns only.
      await turnEnded(chat);
      await chat.console.submit('/undo all');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      expect(await readFile(file, 'utf8')).toBe('two\n');
      await writeFile(file, 'fork again\n');

      await listSessions(chat);
      await chat.console.submit(`/resume ${fromHistory ?? ''}`);
      await until(() => chat.console.sessionId === fromHistory, 'the original Session');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('被改动过')), 'the note');
      expect(await readFile(file, 'utf8')).toBe('fork again\n');

      provider.add(
        tool('edit_file', { path: 'a.txt', oldString: 'fork', newString: 'x' }),
        reply('must read first'),
      );
      await chat.say('edit it');
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('changed outside this session');
      expect(seen).toContain('read the file before editing');
    },
    TIMEOUT,
  );
});

describe('L8: read_output', () => {
  it(
    'reads a cut output in windows, never shows the reference, and finds no reverted call',
    async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 2200; i += 1) files[`many/f${String(i)}.txt`] = 'x';
      const place = await roots(files);
      let listId = '';
      const provider = scriptedChat(tool('list_files', { path: 'many' }));
      const chat = await chatOn(place, provider);
      void chat.console.submit('list');
      await until(() => provider.requests.length >= 1, 'the first request');
      provider.add(
        {
          response: () => {
            const calls = provider.requests.at(-1)?.messages.flatMap((message) => {
              const toolCalls = (message as { tool_calls?: readonly { id: string }[] }).tool_calls;
              return toolCalls ?? [];
            });
            listId = calls?.[0]?.id ?? '';
            return new Response(
              JSON.stringify({
                id: 'chatcmpl-read-output',
                object: 'chat.completion',
                created: 1_767_225_600,
                model: 'deepseek-flash',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_read_output',
                          type: 'function',
                          function: {
                            name: 'read_output',
                            arguments: JSON.stringify({
                              toolCallId: listId,
                              pattern: 'f2199',
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        },
        reply('found it'),
      );
      await until(() => chat.printed('REPLY').length > 0, 'the reply');
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('f2199');
      expect(seen).toContain('containing the pattern');
      expect(JSON.stringify(lastRequest(provider))).not.toContain('fullRef');
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      const log = await logOf(place.dataDir, sessionId);
      expect(log).toContain('"workflowFields":{"fullRef"');

      await turnEnded(chat);

      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      provider.add(tool('read_output', { toolCallId: listId }), reply('gone'));
      await chat.say('read it again');
      expect(contents(lastRequest(provider)).join('\n')).toContain('no tool call with this id');
    },
    TIMEOUT,
  );

  it(
    'says an output that was not cut has nothing more',
    async () => {
      const place = await roots();
      const provider = scriptedChat(
        tool('read_output', { toolCallId: 'call_nowhere' }),
        reply('nothing'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('read');
      expect(contents(lastRequest(provider)).join('\n')).toContain('no tool call with this id');
    },
    TIMEOUT,
  );
});

describe('L8: an output that cannot be read', () => {
  const idOfFirstCall = (provider: ReturnType<typeof scriptedChat>): string => {
    const calls = (provider.requests.at(-1)?.messages ?? []).flatMap(
      (message) => (message as { tool_calls?: readonly { id: string }[] }).tool_calls ?? [],
    );
    return calls[0]?.id ?? '';
  };
  const many = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2200; i += 1) files[`many/f${String(i)}.txt`] = 'x';
    return files;
  };

  it(
    'says the output has expired, once its seven days are over',
    async () => {
      const place = await roots(many());
      let now = new Date('2026-11-04T00:00:00.000Z');
      const provider = scriptedChat(tool('list_files', { path: 'many' }), reply('listed'));
      const chat = await openChat({ ...place, provider, now: () => now });
      open.push(chat);
      await chat.say('list');
      await turnEnded(chat);
      const listId = idOfFirstCall(provider);

      now = new Date('2026-11-12T00:00:00.000Z');
      provider.add(tool('read_output', { toolCallId: listId }), reply('gone'));
      await chat.say('read it');
      expect(contents(lastRequest(provider)).join('\n')).toContain('no longer kept');
    },
    TIMEOUT,
  );

  it(
    'refuses an output over maxFullOutputBytes instead of keeping it',
    async () => {
      const place = await roots(many());
      const provider = scriptedChat(tool('list_files', { path: 'many' }), reply('too much'));
      const chat = await openChat({
        ...place,
        provider,
        configure: (config) => ({
          ...config,
          kernel: {
            ...config.kernel,
            executionLimits: {
              ...config.kernel.executionLimits,
              REPOSITORY_LIST: {
                ...config.kernel.executionLimits.REPOSITORY_LIST,
                maxFullOutputBytes: 1_000,
              },
            },
          },
        }),
      });
      open.push(chat);
      await chat.say('list');
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      expect(await logOf(place.dataDir, sessionId)).toContain('"reasonCode":"LIMIT_EXCEEDED"');
      expect(contents(lastRequest(provider)).join('\n')).not.toContain('f2199');
    },
    TIMEOUT,
  );
});

describe('a Turn that cannot go on', () => {
  it(
    'tells the user, and the next message still works',
    async () => {
      const place = await roots();
      const provider = scriptedChat({
        response: () => new Response('{"error":{"message":"no"}}', { status: 401 }),
      });
      const chat = await chatOn(place, provider);
      await chat.console.submit('hello');
      await until(() => chat.printed('ERROR').some((e) => e.includes('API 密钥')), 'the error');
      await turnEnded(chat);
      provider.add(reply('back'));
      await chat.say('again');
      expect(chat.printed('REPLY')).toContain('back');
    },
    TIMEOUT,
  );
});

describe('H5: an Orchestration run that has ended', () => {
  it(
    'can be undone from the Session it leaves behind',
    async () => {
      const place = await roots({ 'a.txt': 'one\n' });
      const file = join(place.repository, 'a.txt');
      const handoff = scriptedChat(
        tool('handoff_to_code_viewer', { task: 'look', focusAreas: [], openQuestions: [] }),
      );
      const provider = scriptedChat(
        {
          // No Agent of the analyze template writes yet , so the change comes from here.
          response: async () => {
            await writeFile(file, 'two\n');
            return handoff.fetch('https://api.invalid', { body: '{}' });
          },
        },
        tool('finish_analysis', { summary: 'done', conclusions: [], unconfirmed: [] }),
      );
      const first = await chatOn(place, provider);
      await first.console.run({ id: 'analyze', version: 'v0.1.0' }, 'look around');
      await first.close();
      expect(await readFile(file, 'utf8')).toBe('two\n');

      const [sessionId = ''] = await sessionsIn(place.dataDir);
      const chat = await chatOn(place, scriptedChat());
      await listSessions(chat);
      await chat.console.submit(`/resume ${sessionId}`);
      await until(() => chat.console.sessionId === sessionId, 'the Session');
      await turnEnded(chat);
      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('已撤销')), 'the undo');
      expect(await readFile(file, 'utf8')).toBe('one\n');
    },
    TIMEOUT,
  );
});

describe('update_todos', () => {
  it(
    'goes with other tools, answers with a count, and reaches the activity area',
    async () => {
      const place = await roots();
      const todos = [
        { content: 'read', status: 'completed' },
        { content: 'write', status: 'in_progress' },
      ];
      const provider = scriptedChat(
        {
          calls: [
            { name: 'update_todos', arguments: { todos } },
            { name: 'read_file', arguments: { path: 'a.txt' } },
          ],
        },
        tool('update_todos', {
          todos: todos.map((t) => ({ ...t, status: 'finished' })),
        }),
        reply('done'),
      );
      const chat = await chatOn(place, provider);
      await chat.say('work');
      const second = contents(provider.requests[1]).join('\n');
      expect(second).toContain('Todos: 2 items, 1 completed, 1 in progress.');
      expect(second).toContain('one');
      expect(contents(lastRequest(provider)).join('\n')).toContain(
        'Not executed: the arguments do not match',
      );
      expect(
        chat.lives.some((live) => live.activity.some((line) => line.tool === '1/2 · write')),
      ).toBe(true);
      const [sessionId = ''] = await sessionsIn(place.dataDir);
      expect(await logOf(place.dataDir, sessionId)).toContain('TODOS_UPDATED');
    },
    TIMEOUT,
  );
});

describe('a machine without git', () => {
  it(
    'stays read-only: no write tool is offered, and undo says it cannot',
    async () => {
      const place = await roots();
      const provider = scriptedChat(reply('hello'));
      const real = createSubprocessRunner();
      const chat = await openChat({
        ...place,
        provider,
        subprocess: {
          killAll: () => {
            real.killAll();
          },
          run: (command, args, options) =>
            command === 'git'
              ? Promise.resolve({ exitCode: null, signal: null, stdout: '', truncated: false })
              : real.run(command, args, options),
        },
      });
      open.push(chat);
      await chat.say('hi');
      const offered = (provider.requests[0]?.tools ?? []).map((t) => t.function.name);
      expect(offered).toContain('read_file');
      expect(offered).not.toContain('write_file');
      expect(offered).not.toContain('edit_file');
      await turnEnded(chat);
      await chat.console.submit('/undo');
      await until(() => chat.printed('NOTICE').some((n) => n.includes('现在不能回退')), 'the note');
    },
    TIMEOUT,
  );
});

describe('S4: a workspace that changed in many files', () => {
  it(
    'names as many as fit, counts the rest, and the Session goes on instead of ending in a fault',
    async () => {
      const place = await roots();
      const { chat } = await afterOneWrite(place);
      const original = chat.console.sessionId;
      await chat.close();
      open.splice(open.indexOf(chat), 1);

      // More changed files than a note about them can name.
      for (let i = 0; i < 150; i += 1) {
        const name = `generated/${'directory-'.repeat(3)}${String(i)}/file-${String(i)}.txt`;
        await mkdir(dirname(join(place.repository, name)), { recursive: true });
        await writeFile(join(place.repository, name), 'x');
      }

      const provider = scriptedChat(reply('still here'));
      const again = await chatOn(place, provider);
      await listSessions(again);
      await again.console.submit(`/resume ${original ?? ''}`);
      await until(() => again.console.sessionId === original, 'the Session');
      await until(() => again.printed('NOTICE').some((n) => n.includes('被改动过')), 'the note');
      await again.say('go on');

      expect(again.printed('REPLY')).toEqual(['still here']);
      const seen = contents(lastRequest(provider)).join('\n');
      expect(seen).toContain('changed outside this session');
      expect(seen).toMatch(/\(and \d+ more; use git status to see them all\)/u);
    },
    TIMEOUT,
  );
});
