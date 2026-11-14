/**
 * A long task the process left in the middle goes on (Orchestration 7.6): the process is killed
 * while a worker of the task is at work; the next process opens the Session, says the task was
 * interrupted, and goes on with it only when the user says `/recover`: the files are back at the
 * latest checkpoint, the work after it is taken back, and the run waits paused for `/continue`.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSandbox } from '@multiagentos/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSessions,
  openChat,
  reply,
  scriptedAgents,
  until,
  type Chat,
} from '../acceptance/chat-driver.js';

const TIMEOUT = 120_000;
const entry = fileURLToPath(new URL('./resume-entry.ts', import.meta.url));
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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function logOf(dataDir: string): Promise<Record<string, unknown>[]> {
  const [id] = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
  if (id === undefined) return [];
  const text = await readFile(
    join(dataDir, 'sessions', id, 'workflow', 'log.v1.jsonl'),
    'utf8',
  ).catch(() => '');
  return (
    text
      .split('\n')
      .filter(Boolean)
      // The log is read while the system writes it: a line that is not whole yet is not there yet.
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
  );
}

/** Runs the long task in a child and kills it once the worker has written and the root sleeps. */
async function killInTheMiddle(dataDir: string, repository: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, dataDir, repository], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gone = new Promise((resolve) => child.once('close', resolve));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const log = await logOf(dataDir);
    const written = await exists(join(repository, 'out/notes.md'));
    if (written && log.some((record) => record['type'] === 'SEGMENT_YIELDED')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL');
  await gone;
}

real('a long task the process left in the middle (Orchestration 7.6)', () => {
  it(
    'goes on from its latest checkpoint when the user says so, and only then',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'mas-resume-data-'));
      const repository = await mkdtemp(join(tmpdir(), 'mas-resume-repo-'));
      directories.push(dataDir, repository);
      await writeFile(join(repository, 'README.md'), 'demo\n');
      await mkdir(join(repository, 'out'), { recursive: true });
      await writeFile(join(repository, 'out/.keep'), '');
      await killInTheMiddle(dataDir, repository);
      expect(await exists(join(repository, 'out/notes.md'))).toBe(true);

      // The root decides again after the resume: the worker started after the checkpoint is gone.
      const provider = scriptedAgents({ main: [reply('delivered after the resume')] });
      const chat = await openChat({ dataDir, repository, provider });
      open.push(chat);
      await until(() => chat.printed('NOTICE').length > 0, 'the welcome');
      await listSessions(chat);
      await chat.console.submit('/resume 1');
      await until(
        () => chat.printed('NOTICE').some((line) => line.includes('/recover')),
        'the word that the long task was interrupted',
        30_000,
      );
      // Nothing goes on by itself.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(provider.requests).toHaveLength(0);
      expect(await exists(join(repository, 'out/notes.md'))).toBe(true);

      await chat.console.submit('/recover');
      await until(() => chat.lives.at(-1)?.status === '已暂停', 'the resumed run, paused', 30_000);
      // The files are back at the checkpoint: before the worker started.
      expect(await exists(join(repository, 'out/notes.md'))).toBe(false);
      await chat.console.submit('/continue');
      await until(
        () => chat.printed('REPLY').includes('delivered after the resume'),
        'the delivery',
        30_000,
      );
      const log = await logOf(dataDir);
      expect(log.some((record) => record['type'] === 'WORKFLOW_RUN_RESUMED')).toBe(true);
      expect(
        log.some((record) => record['type'] === 'ROLLED_BACK' && record['resumed'] === true),
      ).toBe(true);
      const seen = provider.requests
        .at(-1)
        ?.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n');
      expect(seen).toContain('The process stopped in the middle of this work');
    },
    TIMEOUT,
  );
});
