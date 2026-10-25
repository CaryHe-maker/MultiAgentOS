import {
  MEDIA_TYPES,
  sha256Hex,
  type Executor,
  type ExecutorEnvironment,
  type FileReadInput,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, throwIfAborted, violation } from '../outcome/outcomes.js';
import { readGuardedFile, type GuardHooks } from '../repository-access/guarded-file.js';
import { resolveRepositoryScope } from '../repository-access/repository-scope.js';
import { lineRangeText, parseText } from '../text/text-document.js';

/** At most this many lines per read (ExecutorSet 4.3). */
export const MAX_READ_LINES = 400;

/**
 * FILE_READ (ExecutorSet 4.3): one guarded file, lines `startLine..endLine` (default 1..400),
 * cut back to the last whole line that fits both 400 lines and `limits.maxOutputBytes`. The
 * artifact is exactly the returned text, LF-terminated, and `contentSha256` is its digest.
 */
export function createFileReadExecutor(hooks: GuardHooks = {}): Executor<'FILE_READ'> {
  return {
    executionKind: 'FILE_READ',
    execute: (input, environment) => guarded(() => readFile(input, environment, hooks)),
  };
}

async function readFile(input: FileReadInput, environment: ExecutorEnvironment, hooks: GuardHooks) {
  throwIfAborted(environment.signal);
  const scope = await resolveRepositoryScope(environment.scope);
  if (scope === undefined) return violation('SCOPE_MISSING');
  const read = await readGuardedFile(scope, input.path, hooks);
  if (!read.ok) return read.outcome;
  throwIfAborted(environment.signal);
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
      },
      artifact: { mediaType: MEDIA_TYPES.fileText, text: '' },
    });
  }

  const startLine = input.startLine ?? 1;
  if (startLine > totalLines) return rejected('INVALID_RANGE');
  if (input.endLine !== undefined && input.endLine < startLine) return rejected('INVALID_RANGE');
  let endLine = Math.min(input.endLine ?? totalLines, totalLines, startLine + MAX_READ_LINES - 1);

  // Cut to the last whole line within maxOutputBytes; the first line alone must fit.
  const limit = environment.limits.maxOutputBytes;
  let bytes = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    bytes += Buffer.byteLength(lineRangeText(document, line, line), 'utf8');
    if (bytes > limit) {
      if (line === startLine) return rejected('LIMIT_EXCEEDED');
      endLine = line - 1;
      break;
    }
  }

  const text = lineRangeText(document, startLine, endLine);
  return completed({
    output: {
      path: read.file.path,
      startLine,
      endLine,
      totalLines,
      contentSha256: sha256Hex(text),
      fileSha256,
    },
    artifact: { mediaType: MEDIA_TYPES.fileText, text },
  });
}
