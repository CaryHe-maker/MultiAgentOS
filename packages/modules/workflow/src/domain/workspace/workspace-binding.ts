import type { SessionLogRecord } from '@multiagentos/contracts';

/**
 * The folder a Session is worked on in (M2Design 2.3). The log says it: the folder the Session
 * started in, and then each `WORKSPACE_BOUND`. Everything of a Session that belongs to a folder
 * counts from the last of these on.
 */
export function lastWorkspaceOf(records: readonly SessionLogRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type === 'WORKSPACE_BOUND' || record?.type === 'SESSION_STARTED')
      return record.repositoryRoot;
  }
  return undefined;
}

const PATH_SHOWN = 300;
const shown = (path: string): string =>
  path.length <= PATH_SHOWN ? path : `${path.slice(0, PATH_SHOWN)}…`;

/** What the model is told when the folder changes: what it knows of the old one may not hold. */
export function workspaceChangedNote(previousRoot: string, repositoryRoot: string): string {
  return `The working folder changed from ${shown(previousRoot)} to ${shown(repositoryRoot)}. The files, paths and project instructions mentioned above belong to the old folder: they may not exist in the new one, or may differ. The project instructions of the new folder are read again, and nothing the earlier turns changed can be undone.`;
}
