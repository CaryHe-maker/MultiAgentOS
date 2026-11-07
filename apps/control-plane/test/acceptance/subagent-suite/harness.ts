/**
 * What every case of the SubAgent suite is made of (docs/History/M2/Evaluation/Stage4SubAgents.md): a
 * repository, a prompt, a check that runs outside the model on the files a run left, and a
 * reference solution the check must accept.
 */
// The child-process rule guards the product's own code; this file only judges what a run left.
// eslint-disable-next-line no-restricted-imports
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Files = Readonly<Record<string, string>>;
export type Checks = Readonly<Record<string, boolean>>;

export interface CaseDef {
  readonly id: string;
  /** Whether spreading the work over SubAgents is what the task invites. */
  readonly invites: 'spawn' | 'no-spawn';
  readonly prompt: string;
  readonly files: Files;
  /** What must hold for the work to count as done; every entry true. */
  readonly check: (repository: string, replies: readonly string[]) => Promise<Checks>;
  /** A solution the check must accept, on a repository made of `files`; absent for a question. */
  readonly reference?: (repository: string) => Promise<void>;
}

export const PACKAGE: Files = {
  'package.json': '{ "name": "fixture", "type": "module", "private": true }\n',
};

export const read = (repository: string, path: string) =>
  readFile(join(repository, path), 'utf8').catch(() => undefined);

export async function put(repository: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), content);
}

/** The user's own `node --test`; this harness is not the product, so it may start a process. */
export function testsPass(repository: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--test'], { cwd: repository, timeout: 60_000 }, (error) => {
      resolve(error === null);
    });
  });
}

/** A named export of a module the run left, or undefined when it does not load. */
export async function importNamed(
  repository: string,
  path: string,
  name: string,
): Promise<unknown> {
  try {
    const url = `${pathToFileURL(join(repository, path)).href}?t=${String(Date.now())}`;
    return ((await import(url)) as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

export const importDefault = (repository: string, path: string): Promise<unknown> =>
  importNamed(repository, path, 'default');

export const listFiles = (repository: string, directory: string): Promise<string[]> =>
  readdir(join(repository, directory)).catch(() => []);

/** Every file under the repository, except dependencies and `.git`. */
export async function allFiles(repository: string, directory = ''): Promise<string[]> {
  const found: string[] = [];
  for (const name of await listFiles(repository, directory)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = directory === '' ? name : `${directory}/${name}`;
    const info = await stat(join(repository, path)).catch(() => undefined);
    if (info?.isDirectory() === true) found.push(...(await allFiles(repository, path)));
    else found.push(path);
  }
  return found;
}

/** A table row of a markdown document, split into its cells. */
export const rowsOf = (text: string): string[][] =>
  text
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== ''),
    );
