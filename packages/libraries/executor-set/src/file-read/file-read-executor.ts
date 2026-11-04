import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEDIA_TYPES,
  isExcluded,
  sha256Hex,
  type Executor,
  type ExecutorEnvironment,
  type FileReadInput,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import { readGuardedFile, type GuardHooks } from '../repository-access/guarded-file.js';
import {
  resolveRepositoryScope,
  type RepositoryScope,
} from '../repository-access/repository-scope.js';
import { previewLimitsOf } from '../retention/retention.js';
import { lineRangeText, numberLines, parseText } from '../text/text-document.js';

/** At most this many lines per read. */
export const MAX_READ_LINES = 400;

/** Numbered lines take room the raw text does not: at most 400 lines of 8 bytes, and the header. */
export const RENDERING_BYTES = 4096;

/**
 * FILE_READ: one guarded file, lines `startLine..endLine` (default 1..400),
 * cut back to the last whole line that fits both 400 lines and `limits.maxOutputBytes`. The
 * artifact is exactly the returned text, LF-terminated, and `contentSha256` is its digest.
 */
export function createFileReadExecutor(hooks: GuardHooks = {}): Executor<'FILE_READ'> {
  return {
    executionKind: 'FILE_READ',
    execute: (input, environment) => guarded(() => readFile(input, environment, hooks)),
  };
}

/**
 * The `AGENTS.md` between the file and the root, outermost first (ExecutorSet 3): only looked at,
 * under the same rules as any read. An excluded directory or a link ends the way down.
 */
async function nestedInstructionsOf(
  scope: RepositoryScope,
  path: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  const segments = path.split('/').slice(0, -1);
  let directory = '';
  for (const segment of segments) {
    directory = directory === '' ? segment : `${directory}/${segment}`;
    if (isExcluded(directory, scope.rules)) break;
    const entry = await lstat(join(scope.root, directory)).catch(() => undefined);
    if (entry?.isDirectory() !== true) break;
    const candidate = `${directory}/AGENTS.md`;
    if (isExcluded(candidate, scope.rules)) continue;
    const file = await lstat(join(scope.root, candidate)).catch(() => undefined);
    if (file?.isFile() === true) found.push(candidate);
  }
  return found;
}

async function readFile(input: FileReadInput, environment: ExecutorEnvironment, hooks: GuardHooks) {
  throwIfAborted(environment.signal);
  const scope = await resolveRepositoryScope(environment.scope);
  if (scope === undefined) return violation('SCOPE_MISSING');
  const read = await readGuardedFile(scope, input.path, hooks);
  if (!read.ok) return read.outcome;
  throwIfAborted(environment.signal);
  const nested = await nestedInstructionsOf(scope, read.file.path);
  const found = nested.length === 0 ? {} : { nestedInstructions: [...nested] };
  const document = parseText(read.file.content);
  const totalLines = document.lines.length;
  const fileSha256 = sha256Hex(read.file.content);
  const asked = input.startLine !== undefined || input.endLine !== undefined;

  if (totalLines === 0) {
    if (asked) return rejected('INVALID_RANGE');
    return completed({
      output: {
        path: read.file.path,
        startLine: 1,
        endLine: 0,
        totalLines: 0,
        contentSha256: sha256Hex(''),
        fileSha256,
        ...found,
      },
      artifact: { mediaType: MEDIA_TYPES.fileText, text: `${read.file.path} (empty file)` },
    });
  }

  const startLine = input.startLine ?? 1;
  if (startLine > totalLines) return rejected('INVALID_RANGE');
  if (input.endLine !== undefined && input.endLine < startLine) return rejected('INVALID_RANGE');
  let endLine = Math.min(input.endLine ?? totalLines, totalLines, startLine + MAX_READ_LINES - 1);

  // Cut to the last whole line within the preview; the first line alone must fit.
  const limit = Math.max(1, previewLimitsOf(environment).maxBytes - RENDERING_BYTES);
  let bytes = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    bytes += Buffer.byteLength(lineRangeText(document, line, line), 'utf8');
    if (bytes > limit) {
      if (line === startLine) return rejected('LIMIT_EXCEEDED');
      endLine = line - 1;
      break;
    }
  }

  const rest =
    endLine < totalLines
      ? `\n[Lines ${String(endLine + 1)}-${String(totalLines)} not shown; call read_file with startLine ${String(endLine + 1)} to continue.]`
      : '';
  return completed({
    output: {
      path: read.file.path,
      startLine,
      endLine,
      totalLines,
      contentSha256: sha256Hex(lineRangeText(document, startLine, endLine)),
      fileSha256,
      ...found,
    },
    artifact: {
      mediaType: MEDIA_TYPES.fileText,
      text: `${read.file.path} (lines ${String(startLine)}-${String(endLine)} of ${String(totalLines)})\n${numberLines(document.lines.slice(startLine - 1, endLine), startLine)}${rest}`,
    },
  });
}
