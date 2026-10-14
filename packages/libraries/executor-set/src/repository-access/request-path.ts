import { posix } from 'node:path';

/**
 * Step 2 of ExecutorSet 3.2: a path asked for by a model must be relative, free of NUL and of
 * `..` segments once normalized. Backslashes and drive letters are refused as well, so a path
 * means the same thing on every platform. Returns the normalized `/`-separated path, `.` for
 * the root itself, or undefined when the path leaves the repository.
 */
export function normalizeRequestPath(input: string): string | undefined {
  if (input.length === 0 || input.includes('\0') || input.includes('\\')) return undefined;
  if (input.startsWith('/') || /^[A-Za-z]:/u.test(input)) return undefined;
  const normalized = posix.normalize(input).replace(/\/+$/u, '');
  if (normalized === '' || normalized === '.') return '.';
  if (normalized.split('/').includes('..')) return undefined;
  return normalized;
}
