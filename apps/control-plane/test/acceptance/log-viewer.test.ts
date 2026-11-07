/**
 * `mas log` on a Session the real product wrote (docs/M2/Phase1Console.md 3): the viewer reads
 * the log and the artifacts of a scripted conversation, also while that conversation is still
 * open, and says what it cannot show instead of failing.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogCommand } from '../../src/log-command.js';
import { runLogCommand } from '../../src/log-command.js';
import { openChat, reply, scriptedChat, tool, type Chat } from './chat-driver.js';

const TIMEOUT = 60_000;
const directories: string[] = [];
const open: Chat[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function conversation() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mas-log-data-'));
  const repository = await mkdtemp(join(tmpdir(), 'mas-log-repo-'));
  directories.push(dataDir, repository);
  await writeFile(join(repository, 'a.txt'), 'line one\nline two\n');
  const chat = await openChat({
    dataDir,
    repository,
    provider: scriptedChat(tool('read_file', { path: 'a.txt' }), reply('It has two lines.')),
    answer: () => 'y',
  });
  open.push(chat);
  await chat.say('read a.txt and tell me what is in it');
  return { chat, dataDir, repository };
}

const command = (changes: Partial<Omit<LogCommand, 'kind'>> = {}): LogCommand => ({
  kind: 'LOG',
  full: false,
  json: false,
  list: false,
  ...changes,
});

async function view(
  dataDir: string,
  repository: string,
  changes: Partial<Omit<LogCommand, 'kind'>> = {},
) {
  let out = '';
  let err = '';
  const code = await runLogCommand(command(changes), {
    dataDir,
    cwd: repository,
    write: (text) => void (out += text),
    writeError: (text) => void (err += text),
  });
  return { code, out, err };
}

describe('mas log', () => {
  it(
    'shows what the user asked, what the model called and what came back, while the Session is open',
    async () => {
      const { dataDir, repository } = await conversation();
      const shown = await view(dataDir, repository);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain('第 1 轮');
      expect(shown.out).toContain('你：read a.txt and tell me what is in it');
      expect(shown.out).toContain('调用：read_file {"path":"a.txt"}');
      expect(shown.out).toContain('工具 read_file  OK');
      expect(shown.out).toContain('line one');
      expect(shown.out).toContain('It has two lines.');
      // The provider's usage is kept with the model's output, not on the log record.
      expect(shown.out).toMatch(/模型 main .*输入 100 输出 10/u);
      expect(shown.out).toContain('2 次模型调用');
    },
    TIMEOUT,
  );

  it(
    'lists the Sessions of the repository and opens one by number, id or the start of its id',
    async () => {
      const { chat, dataDir, repository } = await conversation();
      await chat.close();
      const listed = await view(dataDir, repository, { list: true });
      expect(listed.out).toContain('1. ');
      expect(listed.out).toContain('1 轮');
      const sessionId = /(ses_\S+)/u.exec(listed.out)?.[1];
      expect(sessionId).toBeDefined();
      for (const session of ['1', sessionId ?? '', (sessionId ?? '').slice(0, 10)]) {
        const shown = await view(dataDir, repository, { session });
        expect(shown.code, session).toBe(0);
        expect(shown.out).toContain('第 1 轮');
      }
      const missing = await view(dataDir, repository, { session: '9' });
      expect(missing.code).toBe(1);
      expect(missing.err).toContain('没有第 9 个');
    },
    TIMEOUT,
  );

  it(
    'gives the structure as JSON, one Turn on request, and refuses a Turn that is not there',
    async () => {
      const { dataDir, repository } = await conversation();
      const json = await view(dataDir, repository, { json: true });
      const parsed = JSON.parse(json.out) as { sessionId: string; turns: { entries: unknown[] }[] };
      expect(parsed.sessionId).toMatch(/^ses_/u);
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]?.entries.length).toBeGreaterThan(1);

      expect((await view(dataDir, repository, { turn: 1 })).code).toBe(0);
      const none = await view(dataDir, repository, { turn: 2 });
      expect(none.code).toBe(1);
      expect(none.err).toContain('没有第 2 轮');
    },
    TIMEOUT,
  );

  it('says there is nothing to show for a repository without Sessions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mas-log-empty-'));
    directories.push(dataDir);
    const none = await view(dataDir, dataDir);
    expect(none.code).toBe(1);
    expect(none.err).toContain('还没有对话');
    expect((await view(dataDir, dataDir, { list: true })).out).toContain('还没有对话');
  });
});
