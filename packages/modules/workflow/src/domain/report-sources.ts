import type { VerifiedSource } from '@multiagentos/contracts';
import type { WorkflowState } from './state.js';

/** Empty reads remain in private records; report sources always refer to real text lines. */
export function reportSources(reads: WorkflowState['reads']): {
  readonly readSources: readonly VerifiedSource[];
  readonly emptyFileCount: number;
} {
  const emptyPaths = new Set<string>();
  const readSources: VerifiedSource[] = [];
  for (const { requestId, output } of reads) {
    if (output.totalLines === 0) {
      emptyPaths.add(output.path);
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
  return { readSources, emptyFileCount: emptyPaths.size };
}

/** Reserve room for the notice inside the existing summary limit without splitting UTF-16. */
export function withEmptyFileNotice(summary: string, emptyFileCount: number): string {
  if (emptyFileCount === 0) return summary;
  const notice = ` 本次另成功读取了 ${emptyFileCount} 个空文件，未列入行范围来源。`;
  const room = 4000 - notice.length;
  if (summary.length <= room) return summary + notice;
  let prefix = summary.slice(0, room - 1);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + '…' + notice;
}
