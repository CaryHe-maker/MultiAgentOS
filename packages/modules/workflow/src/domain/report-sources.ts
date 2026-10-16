import type { VerifiedSource } from '@multiagentos/contracts';
import type { WorkflowState } from './state.js';

/**
 * Splits the successful reads into report sources and empty files. Empty reads stay in the
 * private run record; they cannot be line sources, so they are listed by path, once each, in
 * the order they were first received.
 */
export function reportSources(reads: WorkflowState['reads']): {
  readonly readSources: readonly VerifiedSource[];
  readonly emptyPaths: readonly string[];
} {
  const emptyPaths: string[] = [];
  const readSources: VerifiedSource[] = [];
  for (const { requestId, output } of reads) {
    if (output.totalLines === 0) {
      if (!emptyPaths.includes(output.path)) emptyPaths.push(output.path);
      continue;
    }
    readSources.push({
      path: output.path,
      startLine: output.startLine,
      endLine: output.endLine,
      readRequestId: requestId,
      readContentSha256: output.contentSha256,
    });
  }
  return { readSources, emptyPaths };
}
