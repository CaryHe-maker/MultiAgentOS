import {
  MEDIA_TYPES,
  type Executor,
  type ExecutorEnvironment,
  type ExecutorOutcome,
  type FileWriteOutput,
} from '@multiagentos/contracts';
import { completed, guarded, rejected, violation } from '../outcome/outcomes.js';
import { isText } from '../text/text-document.js';
import { applyEdit } from './edit-match.js';
import {
  resolveWorkspaceScope,
  writeGuarded,
  type PathLocks,
  type WriteHooks,
  type WriteRequest,
} from './guarded-write.js';

const SUMMARY: Readonly<Record<FileWriteOutput['operation'], string>> = {
  CREATED: 'created',
  OVERWRITTEN: 'overwritten',
  APPENDED: 'appended to',
  EDITED: 'edited',
};

/** Said when an edit was applied to a file that had changed since it was read (D76). */
const REBASED =
  '. The file had changed since you read it (a command you ran, or someone else); the text to replace was found exactly once in it, so the edit was applied to its current content.';

/**
 * A text to replace specific enough to be found again in a changed file: more than one line, or
 * at least this many characters other than white space. A short one can land inside a word the
 * change wrote ("one" inside "someone"), so it is refused as before.
 */
const SPECIFIC_CHARS = 20;

/** The text to replace is specific and occurs exactly once, as written (line ends aside). */
const foundOnce = (content: string, oldString: string): boolean => {
  const view = content.replaceAll('\r\n', '\n');
  const target = oldString.replaceAll('\r\n', '\n');
  const specific =
    target.trim().includes('\n') || target.replace(/\s/gu, '').length >= SPECIFIC_CHARS;
  if (!specific) return false;
  const first = view.indexOf(target);
  return first >= 0 && view.indexOf(target, first + 1) < 0;
};

async function run(
  environment: ExecutorEnvironment,
  locks: PathLocks,
  hooks: WriteHooks,
  request: Pick<WriteRequest, 'path' | 'expected' | 'produce' | 'rebase'>,
  operationOf: (existed: boolean) => FileWriteOutput['operation'],
): Promise<ExecutorOutcome> {
  const scope = await resolveWorkspaceScope(environment.scope);
  if (scope === undefined) return violation('SCOPE_MISSING');
  const written = await writeGuarded(
    { ...request, scope, signal: environment.signal },
    locks,
    hooks,
  );
  if (!written.ok) return written.outcome;
  const operation = operationOf(written.existed);
  return completed({
    output: { path: written.path, operation, sha256: written.sha256 },
    artifact: {
      mediaType: MEDIA_TYPES.fileText,
      text: `${written.path} ${SUMMARY[operation]}${written.rebased === true ? REBASED : ''}`,
    },
  });
}

/** FILE_WRITE (ExecutorSet 5b). Runs in this process: its defence is the code, not the system. */
export function createFileWriteExecutor(
  locks: PathLocks,
  hooks: WriteHooks = {},
): Executor<'FILE_WRITE'> {
  return {
    executionKind: 'FILE_WRITE',
    execute: (input, environment) =>
      guarded(() => {
        const content = Buffer.from(input.content, 'utf8');
        const append = input.append === true;
        return run(
          environment,
          locks,
          hooks,
          {
            path: input.path,
            expected:
              input.baseSha === undefined ? { expectAbsent: true } : { baseSha: input.baseSha },
            produce: (current) =>
              append && current !== undefined ? Buffer.concat([current, content]) : content,
          },
          (existed) => (!existed ? 'CREATED' : append ? 'APPENDED' : 'OVERWRITTEN'),
        );
      }),
  };
}

/** FILE_EDIT (ExecutorSet 5b). */
export function createFileEditExecutor(
  locks: PathLocks,
  hooks: WriteHooks = {},
): Executor<'FILE_EDIT'> {
  return {
    executionKind: 'FILE_EDIT',
    execute: (input, environment) =>
      guarded(() =>
        run(
          environment,
          locks,
          hooks,
          {
            path: input.path,
            expected: { baseSha: input.baseSha },
            // A file changed since it was read is still edited when the text to replace is found
            // exactly once in it: a whole edit again would cost the model a round (D76).
            rebase: (current) =>
              input.replaceAll !== true &&
              isText(current) &&
              foundOnce(current.toString('utf8'), input.oldString),
            produce: (current) => {
              if (current === undefined) return rejected('FILE_CHANGED');
              if (!isText(current)) return rejected('UNSUPPORTED_FILE');
              const edited = applyEdit(current.toString('utf8'), {
                oldString: input.oldString,
                newString: input.newString,
                replaceAll: input.replaceAll === true,
              });
              return edited.ok ? Buffer.from(edited.content, 'utf8') : rejected(edited.reasonCode);
            },
          },
          () => 'EDITED',
        ),
      ),
  };
}
