import type { SessionLogRecord } from '@multiagentos/contracts';

/**
 * The artifacts an AgentRun can read itself, and so may hand to a task (M2Design 3.6): what its
 * own steps produced, the prompts of the user it answers, and the project files it was given.
 */
export function readableArtifacts(
  records: readonly SessionLogRecord[],
  agentRunId: string,
): ReadonlySet<string> {
  const own = new Set<string>();
  const found = new Set<string>();
  for (const record of records) {
    switch (record.type) {
      case 'UNIT_SUBMITTED':
        if (record.agentRunId === agentRunId) own.add(record.requestId);
        break;
      case 'UNIT_COMPLETED':
        if (!own.has(record.requestId)) break;
        if (record.outputRef !== undefined) found.add(record.outputRef.artifactId);
        if (record.fullRef !== undefined) found.add(record.fullRef.artifactId);
        break;
      case 'MODEL_TURN':
        if (record.agentRunId !== agentRunId) break;
        found.add(record.outputRef.artifactId);
        if (record.reasoningRef !== undefined) found.add(record.reasoningRef.artifactId);
        break;
      case 'HUMAN_ANSWERED':
        found.add(record.contentRef.artifactId);
        break;
      case 'PROJECT_FILE_LOADED':
        if ('ref' in record) found.add(record.ref.artifactId);
        break;
      default:
        break;
    }
  }
  return found;
}
