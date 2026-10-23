import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const entry = fileURLToPath(new URL('./process-entry.ts', import.meta.url));
const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Running {
  readonly child: ChildProcess;
  readonly done: Promise<{ code: number | null; signal: string | null }>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function start(
  script: string,
  args: readonly string[],
  dataDir: string,
  repository = dataDir,
): Running {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ENTRY_DATA_DIR: dataDir,
    ENTRY_REPO: repository,
  };
  delete env['MULTIAGENTOS_CONFIG'];
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

async function ready(running: Running): Promise<void> {
  for (let index = 0; index < 150; index += 1) {
    if (running.stdout().includes('READY')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`entry did not become ready; stderr=${running.stderr()}`);
}

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multiagentos-process-'));
  roots.push(root);
  return root;
}

async function entryRoots(): Promise<{ data: string; repository: string }> {
  const data = await dataDir();
  const repository = await mkdtemp(join(tmpdir(), 'multiagentos-review-'));
  roots.push(repository);
  return { data, repository };
}

async function runEntry(mode: string): Promise<{ code: number | null; signal: string | null }> {
  const roots = await entryRoots();
  const running = start(entry, [mode], roots.data, roots.repository);
  return running.done;
}

describe('process entry exit codes', () => {
  it.each([
    ['normal', 0],
    ['failed', 1],
    ['timeout', 2],
    ['violation', 3],
    ['cancelled', 130],
    ['panic', 70],
    ['sync-throw', 70],
    ['uncaught', 70],
    ['unhandled', 70],
  ])('exits with %s as %i', async (mode, expected) => {
    const result = await runEntry(mode);
    expect(result.code).toBe(expected);
    expect(result.signal).toBeNull();
  });

  it('leaves the first interrupt to the command and the second to the guard', async () => {
    const roots = await entryRoots();
    const running = start(entry, ['hang'], roots.data, roots.repository);
    await ready(running);
    running.child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(running.child.exitCode).toBeNull();
    running.child.kill('SIGINT');
    const result = await running.done;
    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
  });

  it('allows the first interrupt to end with the command exit code', async () => {
    const roots = await entryRoots();
    const running = start(entry, ['first-interrupt'], roots.data, roots.repository);
    await ready(running);
    running.child.kill('SIGINT');
    const result = await running.done;
    expect(result.code).toBe(130);
    expect(result.signal).toBeNull();
  });

  it('returns 64 for an invalid command line before composing', async () => {
    const root = await dataDir();
    const running = start(bin, ['analyze', '--repo', 'relative', 'Explain X'], root);
    const result = await running.done;
    expect(result.code).toBe(64);
    expect(result.signal).toBeNull();
  });

  it('returns 70 when configuration cannot be loaded', async () => {
    const root = await dataDir();
    const env = {
      ...process.env,
      ENTRY_DATA_DIR: root,
      MULTIAGENTOS_CONFIG: join(root, 'missing.json'),
    };
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', bin, 'analyze', '--repo', tmpdir(), 'X'],
      {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    expect(await done).toBe(70);
  });
});
