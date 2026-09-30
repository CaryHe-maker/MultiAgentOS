import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  FileReadExecutorPort,
  FileReadRequest,
  FileReadResponse,
  RepositoryFileSummary,
  RepositoryOverview,
  RepositoryViewRequest,
  Result,
} from '../contracts.js';

const MAX_READ_LINES = 120;
const MAX_READ_BYTES = 64 * 1024;
const MAX_OVERVIEW_FILES = 200;

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

function normalizeRelativePath(path: string): string | undefined {
  if (path.length === 0 || isAbsolute(path)) return undefined;
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some((part) => part === '..' || part.length === 0)) return undefined;
  return parts.join('/');
}

function isWithinRoot(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r?\n/u);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

async function pathContainsSymlink(root: string, normalizedPath: string): Promise<boolean> {
  let current = root;
  for (const part of normalizedPath.split('/')) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) return true;
  }
  return false;
}

export class FileReadExecutor implements FileReadExecutorPort {
  public async read(request: FileReadRequest): Promise<Result<FileReadResponse>> {
    const normalized = normalizeRelativePath(request.input.path);
    if (normalized === undefined) {
      return failure('INVALID_FILE_PATH', 'File path must be a non-empty safe relative path.');
    }

    try {
      const root = await realpath(request.repository.rootPath);
      const requestedPath = resolve(root, normalized);
      if (!isWithinRoot(root, requestedPath)) {
        return failure('PATH_OUTSIDE_REPOSITORY', 'File path escapes the repository root.');
      }

      if (await pathContainsSymlink(root, normalized)) {
        return failure('FILE_READ_SYMLINK', 'Symlink and junction paths are not allowed.');
      }

      const fileInfo = await lstat(requestedPath);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        return failure('FILE_READ_NOT_REGULAR_FILE', 'Only regular non-symlink files can be read.');
      }

      const resolvedPath = await realpath(requestedPath);
      if (!isWithinRoot(root, resolvedPath)) {
        return failure(
          'PATH_OUTSIDE_REPOSITORY',
          'Resolved file path escapes the repository root.',
        );
      }
      if (fileInfo.size > MAX_READ_BYTES) {
        return failure('FILE_READ_OUTPUT_LIMIT', `File exceeds the ${MAX_READ_BYTES}-byte limit.`);
      }

      const content = await readFile(resolvedPath, 'utf8');
      const lines = content.split(/\r?\n/u);
      if (lines.at(-1) === '') lines.pop();
      const totalLines = lines.length;
      const startLine = request.input.startLine ?? 1;
      const requestedEndLine = request.input.endLine ?? Math.min(totalLines, startLine + 119);

      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(requestedEndLine) ||
        startLine < 1 ||
        requestedEndLine < startLine
      ) {
        return failure('INVALID_LINE_RANGE', 'Line range must contain positive ordered integers.');
      }
      if (totalLines > 0 && startLine > totalLines) {
        return failure('INVALID_LINE_RANGE', 'Start line is beyond the end of the file.');
      }

      const endLine = Math.min(requestedEndLine, totalLines, startLine + MAX_READ_LINES - 1);
      const selected = lines.slice(startLine - 1, endLine);
      const numbered = selected
        .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
        .join('\n');

      return {
        ok: true,
        value: {
          path: normalized,
          revision: request.repository.revision,
          startLine,
          endLine,
          totalLines,
          content: numbered,
          truncated: requestedEndLine > endLine,
        },
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return failure('FILE_READ_FAILED', `Unable to read ${normalized}: ${detail}`);
    }
  }

  public async view(request: RepositoryViewRequest): Promise<Result<RepositoryOverview>> {
    if (!Number.isInteger(request.maxDepth) || request.maxDepth < 1 || request.maxDepth > 8) {
      return failure('INVALID_VIEW_DEPTH', 'Repository view depth must be between 1 and 8.');
    }

    try {
      const root = await realpath(request.repository.rootPath);
      const extensions = new Set(
        request.includeExtensions.map((extension) => extension.toLowerCase()),
      );
      const files: RepositoryFileSummary[] = [];
      let truncated = false;

      const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > request.maxDepth || truncated) return;
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
          if (files.length >= MAX_OVERVIEW_FILES) {
            truncated = true;
            return;
          }
          const entryPath = resolve(directory, entry.name);
          const entryInfo = await lstat(entryPath);
          if (entryInfo.isSymbolicLink()) continue;
          if (entryInfo.isDirectory()) {
            await visit(entryPath, depth + 1);
            continue;
          }
          if (!entryInfo.isFile()) continue;

          const relativePath = relative(root, entryPath).split(sep).join('/');
          const dot = entry.name.lastIndexOf('.');
          const extension = dot < 0 ? '' : entry.name.slice(dot).toLowerCase();
          if (extensions.size > 0 && !extensions.has(extension)) continue;
          if (entryInfo.size > MAX_READ_BYTES) continue;

          const content = await readFile(entryPath, 'utf8');
          files.push({
            path: relativePath,
            sizeBytes: entryInfo.size,
            totalLines: countLines(content),
          });
        }
      };

      await visit(root, 1);
      files.sort((left, right) => left.path.localeCompare(right.path));
      return {
        ok: true,
        value: { revision: request.repository.revision, files, truncated },
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return failure('REPOSITORY_VIEW_FAILED', `Unable to inspect repository: ${detail}`);
    }
  }
}
