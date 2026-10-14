import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@multiagentos/contracts';
import { throwIfAborted } from '../outcome/outcomes.js';
import { BINARY_PROBE_BYTES } from '../text/text-document.js';
import { excludesDirectory, isExcluded } from './glob.js';
import { isInside, relativeToRoot } from './guarded-file.js';
import type { RepositoryScope } from './repository-scope.js';

/** One file of the snapshot (ExecutorSet 3.1). */
export interface RepositoryFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface FileSet {
  /** Sorted by path in UTF-16 code unit order. */
  readonly files: readonly RepositoryFile[];
  readonly totalBytes: number;
  readonly snapshotId: string;
}

export type FileSetResult = { readonly ok: true; readonly set: FileSet } | { readonly ok: false };

/**
 * Remembers the digest of files whose identity and timestamps did not change, so repeated
 * searches in one run hash only what changed. The key includes `ctime`, which every write
 * updates, so a stale entry needs the file to be rewritten with the same size and both
 * timestamps restored, which the read-only analysis does not do.
 */
export class FileDigestCache {
  private readonly entries = new Map<string, { sha256: string; binary: boolean }>();

  public get(key: string): { sha256: string; binary: boolean } | undefined {
    return this.entries.get(key);
  }

  public set(key: string, value: { sha256: string; binary: boolean }): void {
    if (this.entries.size >= 200_000) this.entries.clear();
    this.entries.set(key, value);
  }
}

const HASH_CHUNK_BYTES = 1024 * 1024;
const PARALLEL_READS = 8;

/**
 * Walks the repository without following links and builds the file set and its snapshot:
 * regular files only, minus excluded paths and binary files. `ok: false` means the set has more
 * than `maxFiles` files (LIMIT_EXCEEDED); the walk stops as soon as that is known.
 */
export async function buildFileSet(
  scope: RepositoryScope,
  options: { signal: AbortSignal; maxFiles?: number | undefined; cache: FileDigestCache },
): Promise<FileSetResult> {
  const candidates = await listCandidates(scope, options.signal);
  const files: RepositoryFile[] = [];
  let next = 0;
  let overLimit = false;
  const results: (RepositoryFile | undefined)[] = new Array<RepositoryFile | undefined>(
    candidates.length,
  );
  let textFiles = 0;
  const worker = async () => {
    while (next < candidates.length && !overLimit) {
      const index = next;
      next += 1;
      throwIfAborted(options.signal);
      const path = candidates[index] as string;
      const digest = await digestFile(join(scope.root, path), options.cache);
      if (digest === undefined || digest.binary) continue;
      results[index] = { path, size: digest.size, sha256: digest.sha256 };
      textFiles += 1;
      if (options.maxFiles !== undefined && textFiles > options.maxFiles) overLimit = true;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_READS }, worker));
  throwIfAborted(options.signal);
  if (overLimit) return { ok: false };
  for (const file of results) if (file !== undefined) files.push(file);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const snapshotId = `snp_${sha256Hex(canonicalJson(files.map((file) => ({ ...file }))))}`;
  return { ok: true, set: { files, totalBytes, snapshotId } };
}

/** Relative paths of every regular, non-excluded file, sorted by UTF-16 code units. */
async function listCandidates(scope: RepositoryScope, signal: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const directory = pending.pop() as string;
    let handle;
    try {
      handle = await opendir(directory === '' ? scope.root : join(scope.root, directory));
    } catch {
      continue; // unreadable directory: nothing in it can be read either
    }
    for await (const entry of handle) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!excludesDirectory(path, scope.rules)) pending.push(path);
      } else if (entry.isFile() && !isExcluded(path, scope.rules)) found.push(path);
      // Links, sockets, devices and FIFOs are never part of the set.
    }
  }
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function digestFile(
  absolute: string,
  cache: FileDigestCache,
): Promise<{ sha256: string; binary: boolean; size: number } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined; // replaced by a link, removed or unreadable since the walk
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return undefined;
    const size = Number(info.size);
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = cache.get(key);
    if (cached !== undefined) return { ...cached, size };
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    let binary = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (position < BINARY_PROBE_BYTES)
        binary ||= chunk.subarray(0, BINARY_PROBE_BYTES - position).includes(0);
      hash.update(chunk);
      position += bytesRead;
    }
    const digest = { sha256: hash.digest('hex'), binary };
    cache.set(key, digest);
    return { ...digest, size: position };
  } finally {
    await handle.close();
  }
}

/**
 * Reads a file of the set again for orient excerpts and search snippets. The hit passes steps
 * 2–5 of ExecutorSet 3.2 by construction (it was found by a walk that never followed a link),
 * and is checked once more here: its real path must be itself, inside the root, and its content
 * must still be the content the snapshot hashed. Otherwise undefined, and the caller drops it.
 */
export async function readSnapshotFile(
  scope: RepositoryScope,
  file: RepositoryFile,
): Promise<Buffer | undefined> {
  const absolute = join(scope.root, file.path);
  try {
    const real = await realpath(absolute);
    if (!isInside(scope.root, real) || relativeToRoot(scope.root, real) !== file.path)
      return undefined;
    if (isExcluded(file.path, scope.rules)) return undefined;
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const content = await handle.readFile();
      return sha256Hex(content) === file.sha256 ? content : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
