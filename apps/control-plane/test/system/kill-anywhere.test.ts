/**
 * The frozen robustness case (docs/M2/M2FrozenTests.md): the process is killed with SIGKILL after
 * each of several records of the Session log, and the next process must open the Session, find a
 * log that reads, redo nothing that already happened, and carry on with a new message. Where the
 * kill falls is the one thing the system does not control, so it is tried at many places.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSessions,
  openChat,
  reply,
  scriptedChat,
  until,
  type Chat,
} from '../acceptance/chat-driver.js';
import { metricsOf } from '../eval/metrics.js';

const TIMEOUT = 90_000;
const entry = fileURLToPath(new URL('./kill-entry.ts', import.meta.url));
const directories: string[] = [];
const open: Chat[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((chat) => chat.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const logFile = async (dataDir: string): Promise<string | undefined> => {
  const [id] = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
  return id === undefined ? undefined : join(dataDir, 'sessions', id, 'workflow', 'log.v1.jsonl');
};
const lines = async (path: string | undefined): Promise<string[]> =>
  path === undefined
    ? []
    : (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);

/** Kills a child that runs the scripted chat as soon as its log holds `records` records. */
async function killAfter(records: number, dataDir: string, repository: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, dataDir, repository], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gone = new Promise((resolve) => child.once('close', resolve));
  let closed = false;
  void gone.then(() => {
    closed = true;
  });
  const deadline = Date.now() + 60_000;
  while (!closed && Date.now() < deadline) {
    if ((await lines(await logFile(dataDir))).length >= records) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill('SIGKILL');
  await gone;
}

describe('a process killed between any two records of the log', () => {
  // The log of this script holds about thirty records; these points reach the start of the Session,
  // the first model call, the read, the question, the write and the end of the Turn.
  for (const records of [3, 8, 13, 18, 23, 28])
    it(
      `after ${String(records)} records: the next process opens the Session, redoes nothing, and carries on`,
      async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mas-kill-data-'));
        const repository = await mkdtemp(join(tmpdir(), 'mas-kill-repo-'));
        directories.push(dataDir, repository);
        await writeFile(join(repository, 'a.txt'), 'line one\n');
        await killAfter(records, dataDir, repository);

        const written = await stat(join(repository, 'out.txt')).then(
          () => true,
          () => false,
        );
        const before = await lines(await logFile(dataDir));

        const provider = scriptedChat(reply('resumed'));
        const chat = await openChat({ dataDir, repository, provider });
        open.push(chat);
        await until(() => chat.printed('NOTICE').length > 0, 'the welcome');
        if ((await readdir(join(dataDir, 'sessions')).catch(() => [])).length > 0) {
          await listSessions(chat);
          await chat.console.submit('/resume 1');
          await until(() => chat.console.sessionId !== undefined, 'the resumed Session');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Nothing runs before the user speaks.
        expect(provider.requests).toHaveLength(0);
        await chat.console.submit('go on');
        await until(() => chat.printed('REPLY').length > 0, 'a reply after the restart', 30_000);
        expect(chat.printed('REPLY')).toEqual(['resumed']);

        // Whatever the log held reads, and what it held is still there, byte for byte at its start.
        const after = await lines(await logFile(dataDir));
        for (const line of after) expect(() => JSON.parse(line) as unknown).not.toThrow();
        expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1));
        // The write happened at most once, and what was written is what was asked for.
        const metrics = metricsOf(after.map((line) => JSON.parse(line) as Record<string, unknown>));
        expect(metrics.toolOutcomes['write_file:OK'] ?? 0).toBeLessThanOrEqual(1);
        expect(metrics.toolRequests['write_file'] ?? 0).toBeLessThanOrEqual(1);
        if (written) expect(await readFile(join(repository, 'out.txt'), 'utf8')).toBe('written\n');
      },
      TIMEOUT,
    );
});
