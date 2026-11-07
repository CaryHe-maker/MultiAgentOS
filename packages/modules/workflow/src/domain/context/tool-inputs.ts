import {
  COMMAND_DEFAULT_TIMEOUT_MS,
  normalizeRequestPath,
  type ArtifactRef,
  type ExecutionKind,
  type FileEditArgs,
  type FileWriteArgs,
  type OutputReadArgs,
  type RunCommandArgs,
  type SessionLogRecord,
  type UnitInput,
} from '@multiagentos/contracts';
import type { ToolInput } from '../agent/agent-cycle.js';
import type { ProjectionScope } from './history-projection.js';

/** What the log last says about a file: read or written at a digest, or read as missing. */
export type FileBaseline =
  { readonly kind: 'SHA'; readonly sha256: string } | { readonly kind: 'ABSENT' };

const shaOf = (output: unknown): { path: string; sha256: string } | undefined => {
  if (typeof output !== 'object' || output === null) return undefined;
  const fields = output as Record<string, unknown>;
  const sha256 = fields['fileSha256'] ?? fields['sha256'];
  const { path } = fields;
  return typeof path === 'string' && typeof sha256 === 'string' ? { path, sha256 } : undefined;
};

/**
 * Replayed from the log, so a reopened Session knows the same. After an undo nothing read before
 * it can be relied on, and a diverged file is read again before it is written (Module/Workflow 7).
 */
export function fileBaselines(records: readonly SessionLogRecord[]): Map<string, FileBaseline> {
  const baselines = new Map<string, FileBaseline>();
  const requested = new Map<string, string>();
  for (const record of records) {
    if (record.type === 'UNIT_SUBMITTED' && record.inputSource.kind === 'TOOL_CALL') {
      const path = record.inputSource.workflowFields?.['path'];
      if (typeof path === 'string') requested.set(record.requestId, path);
    } else if (record.type === 'UNIT_COMPLETED') {
      const known = shaOf(record.output);
      const path = requested.get(record.requestId);
      if (known !== undefined) baselines.set(known.path, { kind: 'SHA', sha256: known.sha256 });
      else if (record.reasonCode === 'NOT_FOUND' && path !== undefined)
        baselines.set(path, { kind: 'ABSENT' });
    } else if (record.type === 'WORKSPACE_REVERTED') baselines.clear();
    else if (record.type === 'WORKSPACE_DIVERGED')
      for (const file of record.files) baselines.delete(file);
  }
  return baselines;
}

/** The full output a `read_output` means, looked up in the log and not in the projection. */
function fullOutputOf(
  toolCallId: string,
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
): { readonly fullRef?: ArtifactRef } | undefined {
  const reverted = new Set<string>();
  const callers = new Set<string>();
  const main = new Set<string>();
  for (const record of records) {
    if (record.type === 'WORKSPACE_REVERTED')
      for (const turnId of record.revertedTurnIds) reverted.add(turnId);
    if (record.type === 'AGENT_RUN_REGISTERED' && record.agentRef.id === 'main')
      main.add(record.agentRunId);
  }
  if (scope.kind === 'MAIN') for (const agentRunId of main) callers.add(agentRunId);
  else callers.add(scope.agentRunId);
  let requestId: string | undefined;
  for (const record of records)
    if (
      record.type === 'UNIT_SUBMITTED' &&
      record.inputSource.kind === 'TOOL_CALL' &&
      record.inputSource.toolCallId === toolCallId &&
      callers.has(record.agentRunId) &&
      (record.turnId === undefined || !reverted.has(record.turnId))
    )
      ({ requestId } = record);
  if (requestId === undefined) return undefined;
  const completed = records.find(
    (record) => record.type === 'UNIT_COMPLETED' && record.requestId === requestId,
  );
  if (completed?.type !== 'UNIT_COMPLETED') return undefined;
  if (completed.fullRef !== undefined) return { fullRef: completed.fullRef };
  // A result that was cut by a compaction reads back from what the cut kept for it.
  for (const record of records)
    if (record.type === 'TOOL_RESULTS_PRUNED')
      for (const item of record.items)
        if (item.requestId === requestId) return { fullRef: item.readableRef };
  return {};
}

const READ_FIRST =
  'Not executed: read the file before editing it, so the edit is based on what is there.';
const BAD_WORKDIR =
  'Not executed: workdir must be a relative path inside the repository, without `..`.';
const NO_SUCH_CALL = 'Not executed: there is no tool call with this id.';
const NOT_CUT = 'Not executed: the output of that call was not cut; its result above is all of it.';

/** Module/Workflow 7, items 8 and 10: what the model cannot give, it is not asked for. */
export function toolInputOf(
  kind: ExecutionKind,
  args: unknown,
  records: readonly SessionLogRecord[],
  scope: ProjectionScope,
): ToolInput {
  const unchanged = { ok: true, input: args as UnitInput } as const;
  switch (kind) {
    case 'FILE_READ': {
      const path = normalizeRequestPath((args as { readonly path: string }).path);
      return path === undefined ? unchanged : { ...unchanged, workflowFields: { path } };
    }
    case 'FILE_WRITE': {
      const write = args as FileWriteArgs;
      const path = normalizeRequestPath(write.path);
      const baseline = path === undefined ? undefined : fileBaselines(records).get(path);
      const known =
        baseline?.kind === 'SHA'
          ? ({ baseSha: baseline.sha256 } as const)
          : ({ expectAbsent: true } as const);
      return { ok: true, input: { ...write, ...known }, workflowFields: known };
    }
    case 'FILE_EDIT': {
      const edit = args as FileEditArgs;
      const path = normalizeRequestPath(edit.path);
      const baseline = path === undefined ? undefined : fileBaselines(records).get(path);
      if (baseline?.kind !== 'SHA') return { ok: false, message: READ_FIRST };
      const known = { baseSha: baseline.sha256 };
      return { ok: true, input: { ...edit, ...known }, workflowFields: known };
    }
    case 'COMMAND': {
      // The model gives the command; the defaults are the system's (M2Design 8.1).
      const run = args as RunCommandArgs;
      const workdir = run.workdir === undefined ? '' : normalizeRequestPath(run.workdir);
      if (workdir === undefined) return { ok: false, message: BAD_WORKDIR };
      const input = {
        command: run.command,
        workdir: workdir === '.' ? '' : workdir,
        timeoutMs: run.timeoutMs ?? COMMAND_DEFAULT_TIMEOUT_MS,
        network: run.network ?? false,
      };
      return { ok: true, input, workflowFields: input };
    }
    case 'OUTPUT_READ': {
      const read = args as OutputReadArgs;
      const found = fullOutputOf(read.toolCallId, records, scope);
      if (found === undefined) return { ok: false, message: NO_SUCH_CALL };
      if (found.fullRef === undefined) return { ok: false, message: NOT_CUT };
      return {
        ok: true,
        input: { ...read, fullRef: found.fullRef },
        workflowFields: { fullRef: found.fullRef },
      };
    }
    default:
      return unchanged;
  }
}
