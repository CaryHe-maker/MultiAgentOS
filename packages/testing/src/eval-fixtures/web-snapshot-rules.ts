import { createHash } from 'node:crypto';
import type { EvalTask, WebSnapshotManifest } from './eval-task-schema.js';
import type { FixtureIssue } from './eval-task-rules.js';

/** 已从磁盘读出的快照：清单 + 清单引用的文件内容（缺失的文件为 undefined）。 */
export interface LoadedWebSnapshot {
  readonly name: string;
  readonly origin: string;
  readonly manifest: WebSnapshotManifest;
  readonly files: ReadonlyMap<string, Uint8Array | undefined>;
}

/** 快照自身的完整性：id 与目录一致，引用的文件存在且 sha256 未漂移。 */
export function checkSnapshotIntegrity(snapshot: LoadedWebSnapshot): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  const { manifest, origin } = snapshot;
  if (manifest.snapshotId !== snapshot.name)
    issues.push({
      code: 'SNAPSHOT_ID_MISMATCH',
      severity: 'ERROR',
      origin,
      message: `snapshotId ${manifest.snapshotId} differs from directory ${snapshot.name}`,
    });
  const entries = [
    ...manifest.queries.map((query) => ({ file: query.resultFile, sha256: query.sha256 })),
    ...manifest.pages.map((page) => ({ file: page.bodyFile, sha256: page.sha256 })),
  ];
  for (const entry of entries) {
    const content = snapshot.files.get(entry.file);
    if (content === undefined)
      issues.push({
        code: 'SNAPSHOT_FILE_MISSING',
        severity: 'ERROR',
        origin,
        message: `${entry.file} is listed but missing`,
      });
    else if (createHash('sha256').update(content).digest('hex') !== entry.sha256)
      issues.push({
        code: 'SNAPSHOT_HASH_MISMATCH',
        severity: 'ERROR',
        origin,
        message: `${entry.file} content does not match its sha256`,
      });
  }
  return issues;
}

/** WEB 证据必须能在快照里复验：URL 被录制过，quote 出现在页面正文里。 */
export function checkWebEvidence(
  task: EvalTask,
  origin: string,
  snapshot: LoadedWebSnapshot,
): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  const evidence = [...task.evidence.required, ...task.evidence.optional];
  for (const item of evidence) {
    if (item.kind !== 'WEB') continue;
    const page = snapshot.manifest.pages.find((candidate) => candidate.url === item.url);
    const body = page === undefined ? undefined : snapshot.files.get(page.bodyFile);
    if (page === undefined) {
      issues.push({
        code: 'WEB_EVIDENCE_URL_NOT_RECORDED',
        severity: 'ERROR',
        origin,
        taskId: task.id,
        message: `${item.url} is not in snapshot ${snapshot.name}`,
      });
    } else if (body !== undefined) {
      const raw = new TextDecoder().decode(body);
      const text = page.contentType.includes('html') ? htmlToText(raw) : collapse(raw);
      if (!text.includes(collapse(item.quote)))
        issues.push({
          code: 'WEB_EVIDENCE_QUOTE_NOT_FOUND',
          severity: 'ERROR',
          origin,
          taskId: task.id,
          message: `quote not found in ${item.url}`,
        });
    }
  }
  return issues;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** 足够做“关键句是否出现”的粗略文本提取；不是完整的 HTML 解析器。 */
export function htmlToText(html: string): string {
  const withoutCode = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withoutTags = withoutCode.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? match;
  });
  return collapse(decoded);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
