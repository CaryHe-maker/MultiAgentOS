import { isProjectInstructionPath, type SessionLogRecord } from '@multiagentos/contracts';
import type { ProjectionScope } from './history-projection.js';

export interface InstructionsToLoad {
  readonly path: string;
  /** Beyond the limit it is only noted; the model can still read it as a file. */
  readonly skip: boolean;
}

const outputField = (output: unknown, field: string): unknown =>
  typeof output === 'object' && output !== null
    ? (output as Record<string, unknown>)[field]
    : undefined;

/**
 * What this projection must read before its next assembly (Module/Workflow 8.2): every
 * `AGENTS.md` its `read_file` calls passed in this run and it has not loaded in this run,
 * outermost first as they were reported, and any it loaded that an approved write changed since.
 * A load in a reverted Turn does not count.
 */
export function instructionsToLoad(
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
  workflowRunId: string,
  agentRunId: string,
  /** `maxNestedInstructions`: how many below the root a projection loads (M2Design 9.5). */
  limit: number,
): readonly InstructionsToLoad[] {
  const mine = new Set<string>([agentRunId]);
  const owners = new Map<string, string>();
  const loadedThisRun = new Map<string, string | undefined>();
  const loadedEver = new Map<string, string | undefined>();
  const skipped = new Set<string>();
  const wanted = new Set<string>();
  let turnId: string | undefined;

  for (const record of records)
    switch (record.type) {
      case 'TURN_STARTED':
        turnId = record.turnId;
        break;
      case 'AGENT_RUN_REGISTERED':
        if (scope.kind === 'MAIN' && record.agentRef.id === 'main') mine.add(record.agentRunId);
        break;
      case 'UNIT_SUBMITTED':
        owners.set(record.requestId, record.agentRunId);
        break;
      case 'PROJECT_FILE_LOADED': {
        const owner = record.agentRunId;
        // The root file is read once per run, by the runner itself.
        if (owner === undefined && !loadedEver.has(record.path)) {
          loadedEver.set(record.path, undefined);
          if (record.workflowRunId === workflowRunId) loadedThisRun.set(record.path, undefined);
          break;
        }
        if (owner === undefined || !mine.has(owner)) break;
        if ('skipped' in record) {
          skipped.add(record.path);
          wanted.delete(record.path);
          break;
        }
        loadedEver.set(record.path, turnId);
        if (record.workflowRunId === workflowRunId) loadedThisRun.set(record.path, turnId);
        wanted.delete(record.path);
        break;
      }
      case 'WORKSPACE_REVERTED':
        for (const loaded of [loadedThisRun, loadedEver])
          for (const [path, turn] of loaded)
            if (turn !== undefined && record.revertedTurnIds.includes(turn)) loaded.delete(path);
        break;
      case 'UNIT_COMPLETED': {
        const owner = owners.get(record.requestId);
        if (record.workflowRunId !== workflowRunId || owner === undefined || !mine.has(owner))
          break;
        const nested = outputField(record.output, 'nestedInstructions');
        if (Array.isArray(nested))
          for (const path of nested as readonly string[])
            if (!loadedThisRun.has(path) && !skipped.has(path)) wanted.add(path);
        const written = outputField(record.output, 'path');
        if (
          outputField(record.output, 'operation') !== undefined &&
          typeof written === 'string' &&
          isProjectInstructionPath(written) &&
          loadedEver.has(written)
        ) {
          loadedThisRun.delete(written);
          wanted.add(written);
        }
        break;
      }
      default:
        break;
    }

  let nestedCount = [...loadedEver.keys()].filter((path) => path.includes('/')).length;
  return [...wanted].map((path) => {
    if (loadedEver.has(path) || !path.includes('/')) return { path, skip: false };
    nestedCount += 1;
    return { path, skip: nestedCount > limit };
  });
}
