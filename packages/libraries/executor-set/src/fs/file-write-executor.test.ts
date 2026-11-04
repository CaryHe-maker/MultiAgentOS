import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Hex, type ExecutionScope, type ExecutorOutcome } from '@multiagentos/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDirectory, environmentFor } from '../test-support/environments.js';
import { createFileEditExecutor, createFileWriteExecutor } from './file-write-executor.js';
import { PathLocks, type WriteHooks } from './guarded-write.js';

let root: string;
let outside: string;
let scope: ExecutionScope;

beforeEach(async () => {
  root = await emptyDirectory('fs-root');
  outside = await emptyDirectory('fs-outside');
  scope = { kind: 'WORKSPACE', repositoryRoot: root, writableRoots: ['.'], exclusions: [] };
});

const put = async (path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const read = (path: string) => readFile(join(root, path), 'utf8');
const exists = (path: string) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

const write = (
  input: { path: string; content: string; append?: boolean } & (
    { baseSha: string; expectAbsent?: never } | { expectAbsent: true; baseSha?: never }
  ),
  hooks?: WriteHooks,
  withScope: ExecutionScope = scope,
): Promise<ExecutorOutcome> =>
  createFileWriteExecutor(new PathLocks(), hooks).execute(
    input,
    environmentFor('FILE_WRITE', withScope),
  );

const edit = (
  input: {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    baseSha: string;
  },
  hooks?: WriteHooks,
): Promise<ExecutorOutcome> =>
  createFileEditExecutor(new PathLocks(), hooks).execute(input, environmentFor('FILE_EDIT', scope));

const refused = (reasonCode: string) => ({ outcome: 'REJECTED', reasonCode });

describe('file-write', () => {
  it('creates a file with its directories, and reports the digest of the new content', async () => {
    const outcome = await write({ path: 'a/b/c.txt', content: 'new\n', expectAbsent: true });
    expect(outcome).toMatchObject({
      outcome: 'COMPLETED',
      result: {
        output: { path: 'a/b/c.txt', operation: 'CREATED', sha256: sha256Hex('new\n') },
        artifact: { text: 'a/b/c.txt created' },
      },
    });
    expect(await read('a/b/c.txt')).toBe('new\n');
  });

  it('overwrites only what it last saw, and keeps the mode', async () => {
    await put('f.sh', 'old');
    await chmod(join(root, 'f.sh'), 0o750);
    const outcome = await write({ path: 'f.sh', content: 'new', baseSha: sha256Hex('old') });
    expect(outcome).toMatchObject({ result: { output: { operation: 'OVERWRITTEN' } } });
    expect(await read('f.sh')).toBe('new');
    if (process.platform !== 'win32')
      expect((await stat(join(root, 'f.sh'))).mode & 0o777).toBe(0o750);
  });

  it('refuses when the file is not what was expected, and touches nothing', async () => {
    await put('f.txt', 'theirs');
    expect(await write({ path: 'f.txt', content: 'x', baseSha: sha256Hex('old') })).toMatchObject(
      refused('FILE_CHANGED'),
    );
    expect(await write({ path: 'f.txt', content: 'x', expectAbsent: true })).toMatchObject(
      refused('FILE_CHANGED'),
    );
    expect(
      await write({ path: 'gone.txt', content: 'x', baseSha: sha256Hex('old') }),
    ).toMatchObject(refused('FILE_CHANGED'));
    expect(await read('f.txt')).toBe('theirs');
    expect(await exists('gone.txt')).toBe(false);
  });

  it('a refusal creates no directory', async () => {
    await write({ path: 'x/y/f.txt', content: 'c', baseSha: sha256Hex('old') });
    expect(await exists('x')).toBe(false);
  });

  it('appends', async () => {
    await put('log.txt', 'one\n');
    const outcome = await write({
      path: 'log.txt',
      content: 'two\n',
      append: true,
      baseSha: sha256Hex('one\n'),
    });
    expect(outcome).toMatchObject({
      result: { output: { operation: 'APPENDED', sha256: sha256Hex('one\ntwo\n') } },
    });
    expect(await read('log.txt')).toBe('one\ntwo\n');
  });

  it('leaves no temporary file behind, whatever happens', async () => {
    await put('f.txt', 'old');
    await write({ path: 'f.txt', content: 'x', baseSha: sha256Hex('old') });
    await write({ path: 'f.txt', content: 'y', baseSha: sha256Hex('stale') });
    expect(await readdir(root)).toEqual(['f.txt']);
  });

  it('refuses a directory, and refuses a file used as a directory', async () => {
    await mkdir(join(root, 'dir'));
    await put('file.txt', 'x');
    expect(await write({ path: 'dir', content: 'x', expectAbsent: true })).toMatchObject(
      refused('UNSUPPORTED_FILE'),
    );
    expect(await write({ path: 'file.txt/a', content: 'x', expectAbsent: true })).toMatchObject(
      refused('UNSUPPORTED_FILE'),
    );
  });

  it('serializes writers of one path: the later one sees the earlier', async () => {
    await put('f.txt', 'base');
    const locks = new PathLocks();
    const executor = createFileWriteExecutor(locks);
    const environment = environmentFor('FILE_WRITE', scope);
    const input = { path: 'f.txt', baseSha: sha256Hex('base') };
    const outcomes = await Promise.all([
      executor.execute({ ...input, content: 'first' }, environment),
      executor.execute({ ...input, content: 'second' }, environment),
    ]);
    // Which gets there first is not fixed; that one of them loses is.
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['COMPLETED', 'REJECTED']);
    const winner = outcomes[0]?.outcome === 'COMPLETED' ? 'first' : 'second';
    expect(await read('f.txt')).toBe(winner);
  });

  it('fails as a violation without a workspace scope', async () => {
    const repository: ExecutionScope = { kind: 'REPOSITORY', repositoryRoot: root, exclusions: [] };
    expect(
      await write({ path: 'f.txt', content: 'x', expectAbsent: true }, undefined, repository),
    ).toMatchObject({ outcome: 'VIOLATION', reasonCode: 'SCOPE_MISSING' });
  });
});

describe('file-edit', () => {
  it('replaces and keeps the line endings', async () => {
    await put('f.txt', 'one\r\ntwo\r\n');
    const outcome = await edit({
      path: 'f.txt',
      oldString: 'one\ntwo',
      newString: 'uno\ndos',
      baseSha: sha256Hex('one\r\ntwo\r\n'),
    });
    expect(outcome).toMatchObject({ result: { output: { operation: 'EDITED' } } });
    expect(await read('f.txt')).toBe('uno\r\ndos\r\n');
  });

  it.each([
    ['nothing', 'zzz', 'EDIT_NO_MATCH'],
    ['more than one', 'a', 'EDIT_NOT_UNIQUE'],
  ])('refuses when %s matches', async (_, oldString, reasonCode) => {
    await put('f.txt', 'a a');
    expect(
      await edit({ path: 'f.txt', oldString, newString: 'x', baseSha: sha256Hex('a a') }),
    ).toMatchObject(refused(reasonCode));
    expect(await read('f.txt')).toBe('a a');
  });

  it('refuses a stale base before it looks for the text', async () => {
    await put('f.txt', 'a');
    expect(
      await edit({ path: 'f.txt', oldString: 'a', newString: 'b', baseSha: sha256Hex('other') }),
    ).toMatchObject(refused('FILE_CHANGED'));
  });

  it('refuses a binary file', async () => {
    await put('f.bin', 'a\0b');
    expect(
      await edit({ path: 'f.bin', oldString: 'a', newString: 'b', baseSha: sha256Hex('a\0b') }),
    ).toMatchObject(refused('UNSUPPORTED_FILE'));
  });
});

/** The exit condition of stage 2 (M2Design 6.3): here the code is the only defence. */
describe('against an attacker', () => {
  it.each([
    ['/etc/passwd', 'WRITE_OUT_OF_SCOPE'],
    ['../outside.txt', 'WRITE_OUT_OF_SCOPE'],
    ['a/../../outside.txt', 'WRITE_OUT_OF_SCOPE'],
    ['a\\..\\..\\outside.txt', 'WRITE_OUT_OF_SCOPE'],
    ['C:/outside.txt', 'WRITE_OUT_OF_SCOPE'],
    ['nul\0byte', 'WRITE_OUT_OF_SCOPE'],
    ['.git/hooks/pre-commit', 'PROTECTED_PATH'],
    ['.GIT/config', 'PROTECTED_PATH'],
    ['sub/.git/config', 'PROTECTED_PATH'],
    ['.multiagentos/workflows/x.yaml', 'PROTECTED_PATH'],
    ['.env', 'PROTECTED_PATH'],
    ['id_rsa', 'PROTECTED_PATH'],
    ['node_modules/a/index.js', 'PROTECTED_PATH'],
  ])('refuses %j', async (path, reasonCode) => {
    expect(await write({ path, content: 'x', expectAbsent: true })).toMatchObject(
      refused(reasonCode),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('applies the write roots and the rules of the scope', async () => {
    const narrow: ExecutionScope = {
      kind: 'WORKSPACE',
      repositoryRoot: root,
      writableRoots: ['src'],
      exclusions: ['src/secret/**'],
    };
    const attempt = (path: string) =>
      write({ path, content: 'x', expectAbsent: true }, undefined, narrow);
    expect(await attempt('lib/a.ts')).toMatchObject(refused('WRITE_OUT_OF_SCOPE'));
    expect(await attempt('src/secret/a.ts')).toMatchObject(refused('PROTECTED_PATH'));
    expect(await attempt('src/a.ts')).toMatchObject({ outcome: 'COMPLETED' });
  });

  /** Native Windows without Developer Mode cannot make links; the rule is judged on Linux. */
  const linked = async (target: string, path: string): Promise<boolean> => {
    try {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await symlink(target, join(root, path));
      return true;
    } catch {
      return false;
    }
  };

  it('does not follow a link in the target or on the way to it', async () => {
    await writeFile(join(outside, 'target.txt'), 'outside');
    if (!(await linked(join(outside, 'target.txt'), 'link.txt'))) return;
    await linked(outside, 'dir');
    expect(
      await write({ path: 'link.txt', content: 'x', baseSha: sha256Hex('outside') }),
    ).toMatchObject(refused('OUT_OF_SCOPE'));
    expect(await write({ path: 'dir/new.txt', content: 'x', expectAbsent: true })).toMatchObject(
      refused('OUT_OF_SCOPE'),
    );
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside');
    expect(await readdir(outside)).toEqual(['target.txt']);
  });

  it('does not follow a dangling link to create a file outside', async () => {
    if (!(await linked(join(outside, 'created.txt'), 'dangling.txt'))) return;
    expect(await write({ path: 'dangling.txt', content: 'x', expectAbsent: true })).toMatchObject(
      refused('OUT_OF_SCOPE'),
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it('notices the target swapped for a link at the last moment', async () => {
    await put('f.txt', 'old');
    await writeFile(join(outside, 'target.txt'), 'outside');
    if (!(await linked(join(outside, 'target.txt'), 'probe'))) return;
    await rm(join(root, 'probe'));
    const outcome = await write(
      { path: 'f.txt', content: 'x', baseSha: sha256Hex('old') },
      {
        beforeCommit: async () => {
          await rm(join(root, 'f.txt'));
          await symlink(join(outside, 'target.txt'), join(root, 'f.txt'));
        },
      },
    );
    expect(outcome).toMatchObject(refused('OUT_OF_SCOPE'));
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside');
    expect((await readdir(root)).sort()).toEqual(['f.txt']);
  });

  it('notices a change made between the checks and the rename', async () => {
    await put('f.txt', 'old');
    const outcome = await write(
      { path: 'f.txt', content: 'mine', baseSha: sha256Hex('old') },
      {
        beforeCommit: async () => {
          await writeFile(join(root, 'f.txt'), 'theirs');
        },
      },
    );
    expect(outcome).toMatchObject(refused('FILE_CHANGED'));
    expect(await read('f.txt')).toBe('theirs');
  });

  it('reports a parent swapped for a link after the rename', async () => {
    await put('dir/f.txt', 'old');
    await mkdir(join(outside, 'moved'));
    if (!(await linked(outside, 'probe'))) return;
    await rm(join(root, 'probe'));
    const outcome = await write(
      { path: 'dir/f.txt', content: 'x', baseSha: sha256Hex('old') },
      {
        afterRename: async () => {
          await rename(join(root, 'dir'), join(outside, 'moved', 'dir'));
          await symlink(join(outside, 'moved', 'dir'), join(root, 'dir'));
        },
      },
    );
    expect(outcome).toMatchObject({ outcome: 'VIOLATION', reasonCode: 'GUARD_FAILURE' });
  });

  it('refuses a directory on the way swapped for a link before the checks', async () => {
    await mkdir(join(root, 'dir'));
    if (!(await linked(outside, 'probe'))) return;
    await rm(join(root, 'probe'));
    await rm(join(root, 'dir'), { recursive: true });
    await symlink(outside, join(root, 'dir'));
    expect(await write({ path: 'dir/f.txt', content: 'x', expectAbsent: true })).toMatchObject(
      refused('OUT_OF_SCOPE'),
    );
    expect(await readdir(outside)).toEqual([]);
  });
});
