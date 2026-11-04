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

async function run(
  environment: ExecutorEnvironment,
  locks: PathLocks,
  hooks: WriteHooks,
  request: Pick<WriteRequest, 'path' | 'expected' | 'produce'>,
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
      text: `${written.path} ${SUMMARY[operation]}`,
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
