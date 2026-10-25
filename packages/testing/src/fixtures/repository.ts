import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A small repository with one file of every kind the repository Executors must tell apart
 * (docs/M1/Library/ExecutorSet.md 3). Paths are relative to the root and use `/`.
 */
export const FIXTURE_FILES = Object.freeze({
  /** Ordinary text files: part of the file set and the snapshot. */
  text: Object.freeze({
    'README.md': '# Fixture\n\nA tiny repository for Executor tests.\n',
    'package.json': '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n',
    'src/math.ts':
      'export function add(left: number, right: number): number {\n  return left + right;\n}\n',
    'src/util/strings.ts':
      'export const greeting = "hello";\nexport function shout(text: string): string {\n  return text.toUpperCase();\n}\n',
    'docs/empty.txt': '',
  }),
  /** Hit DEFAULT_EXCLUSIONS: never read, never searched, not in the snapshot. */
  excluded: Object.freeze({
    '.env': 'SECRET=do-not-read\n',
    '.git/config': '[core]\n',
    'keys/server.pem': '-----BEGIN PRIVATE KEY-----\n',
    'node_modules/dependency/index.js': 'module.exports = 1;\n',
  }),
  /** Contains a NUL byte in its first 8 KiB: UNSUPPORTED_FILE, and not in the snapshot. */
  binary: Object.freeze({ 'assets/logo.bin': 'PNG\u0000\u0001\u0002' }),
});

export interface FixtureRepository {
  /** Absolute path of the repository root. */
  readonly root: string;
  /**
   * Relative path of a symbolic link that points outside the root, or undefined when the
   * platform did not allow creating one (native Windows without Developer Mode).
   */
  readonly escapingLink: string | undefined;
}

/**
 * Writes the fixture repository into `root`, which must exist and be empty. `outside` is a file
 * outside the root that the escaping link points at.
 */
export async function createFixtureRepository(
  root: string,
  outside: string,
): Promise<FixtureRepository> {
  const all = { ...FIXTURE_FILES.text, ...FIXTURE_FILES.excluded, ...FIXTURE_FILES.binary };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(outside, 'outside the repository\n');
  let escapingLink: string | undefined = 'src/escape.ts';
  try {
    await symlink(outside, join(root, escapingLink));
  } catch {
    escapingLink = undefined;
  }
  return { root, escapingLink };
}
