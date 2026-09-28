import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FixtureIssue, LoadedEvalTask } from './eval-task-rules.js';
import type { RepositoryRef } from './eval-task-schema.js';

const run = promisify(execFile);

/** 与 ContextEngine 的 maxFileBytes 一致：更大的文件永远进不了 ContextPack。 */
export const MAX_EVIDENCE_FILE_BYTES = 262_144;
const BINARY_SNIFF_BYTES = 8_000;

/** 在固定 commit 下读仓库。接口化是为了测试可以换成本地仓库，评测逻辑不关心 git 细节。 */
export interface RepositoryReader {
  hasCommit(repository: RepositoryRef): Promise<boolean>;
  /** 文件不存在时返回 undefined；仓库不可用时抛出。 */
  readFile(repository: RepositoryRef, path: string): Promise<Uint8Array | undefined>;
}

/**
 * 需要读被测仓库的检查（会联网克隆），因此不进 `pnpm run check`，由 `pnpm run eval:fixtures --repos` 运行。
 * 同一仓库只克隆一次；一个仓库不可用不影响其他仓库的检查。
 */
export async function checkRepositoryEvidence(
  tasks: readonly LoadedEvalTask[],
  reader: RepositoryReader,
): Promise<FixtureIssue[]> {
  const issues: FixtureIssue[] = [];
  for (const { task, origin } of tasks) {
    const repository = task.repository;
    if (repository === undefined) continue;
    const report = (code: string, message: string) =>
      issues.push({ code, severity: 'ERROR', origin, taskId: task.id, message });
    try {
      if (!(await reader.hasCommit(repository))) {
        report('COMMIT_NOT_FOUND', `${repository.url} has no commit ${repository.commit}`);
        continue;
      }
      const evidence = [...task.evidence.required, ...task.evidence.optional];
      for (const item of evidence) {
        if (item.kind !== 'CODE') continue;
        const content = await reader.readFile(repository, item.path);
        if (content === undefined) {
          report('PATH_NOT_FOUND', `${item.path} does not exist at ${repository.commit}`);
          continue;
        }
        if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          report('BINARY_FILE', `${item.path} looks binary`);
          continue;
        }
        if (content.byteLength > MAX_EVIDENCE_FILE_BYTES) {
          report('FILE_TOO_LARGE', `${item.path} is ${content.byteLength} bytes`);
          continue;
        }
        const lineCount = countLines(content);
        if (item.lines[1] > lineCount) {
          report('LINE_OUT_OF_RANGE', `${item.path} has ${lineCount} lines, not ${item.lines[1]}`);
          continue;
        }
        if (item.anchor !== undefined) {
          const lines = new TextDecoder().decode(content).split('\n');
          const range = collapse(lines.slice(item.lines[0] - 1, item.lines[1]).join('\n'));
          const anchor = collapse(item.anchor);
          if (!range.includes(anchor)) {
            const actual = lines.findIndex((line) => collapse(line).includes(anchor));
            const where = actual === -1 ? 'not found in the file' : `found at line ${actual + 1}`;
            report(
              'ANCHOR_NOT_IN_RANGE',
              `${item.path} lines ${item.lines.join('-')}: anchor ${where}`,
            );
          }
        }
      }
      const probePaths = new Set((task.retrievalProbes ?? []).flatMap((p) => p.expectPaths));
      for (const path of probePaths)
        if ((await reader.readFile(repository, path)) === undefined)
          report('PATH_NOT_FOUND', `probe path ${path} does not exist at ${repository.commit}`);
      const sourceCommit = task.provenance.sourceCommit;
      if (
        sourceCommit !== undefined &&
        !(await reader.hasCommit({ ...repository, commit: sourceCommit }))
      )
        report('SOURCE_COMMIT_NOT_FOUND', `${repository.url} has no commit ${sourceCommit}`);
    } catch (cause: unknown) {
      report(
        'REPOSITORY_UNAVAILABLE',
        `${repository.url}: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`,
      );
    }
  }
  return issues;
}

/** 行号口径：最后一行有没有换行符都算一行，与编辑器显示一致。 */
export function countLines(content: Uint8Array): number {
  if (content.byteLength === 0) return 0;
  let count = 0;
  for (const byte of content) if (byte === 0x0a) count += 1;
  return content[content.byteLength - 1] === 0x0a ? count : count + 1;
}

export interface GitCliRepositoryReaderOptions {
  /** 克隆缓存目录，默认放在已被 git 忽略的 `.multiagent/eval-cache`。 */
  readonly cacheDirectory: string;
  /** 测试用：把题目里的 URL 映射到本地仓库路径。 */
  readonly remoteOverrides?: ReadonlyMap<string, string>;
  readonly timeoutMs?: number;
}

/**
 * 用系统 git 实现的 RepositoryReader。只做 blob-less 克隆（不下载文件内容），
 * 读文件时用 `git cat-file` 按需取单个 blob，不 checkout 工作区。所有调用使用参数数组。
 */
export class GitCliRepositoryReader implements RepositoryReader {
  private readonly clones = new Map<string, Promise<string>>();
  private readonly timeoutMs: number;

  public constructor(private readonly options: GitCliRepositoryReaderOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async hasCommit(repository: RepositoryRef): Promise<boolean> {
    const directory = await this.clone(repository.url);
    if (await this.succeeds(directory, ['cat-file', '-e', `${repository.commit}^{commit}`]))
      return true;
    // 固定 commit 可能不在默认分支上（例如 PR 合并前的提交），单独拉取一次。
    await this.succeeds(directory, [
      'fetch',
      '--quiet',
      '--filter=blob:none',
      'origin',
      repository.commit,
    ]);
    return await this.succeeds(directory, ['cat-file', '-e', `${repository.commit}^{commit}`]);
  }

  public async readFile(repository: RepositoryRef, path: string): Promise<Uint8Array | undefined> {
    const directory = await this.clone(repository.url);
    const object = `${repository.commit}:${path}`;
    if (!(await this.succeeds(directory, ['cat-file', '-e', object]))) return undefined;
    const type = await this.git(directory, ['cat-file', '-t', object]);
    if (type.toString('utf8').trim() !== 'blob') return undefined;
    return new Uint8Array(await this.git(directory, ['cat-file', 'blob', object]));
  }

  private clone(url: string): Promise<string> {
    let pending = this.clones.get(url);
    if (pending === undefined) {
      pending = this.createClone(url);
      this.clones.set(url, pending);
    }
    return pending;
  }

  private async createClone(url: string): Promise<string> {
    const slug = url
      .replace(/^https:\/\//, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 80);
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 8);
    const directory = join(this.options.cacheDirectory, `${slug}-${hash}`);
    if (await exists(join(directory, '.git'))) return directory;
    await mkdir(this.options.cacheDirectory, { recursive: true });
    const remote = this.options.remoteOverrides?.get(url) ?? url;
    await this.git(this.options.cacheDirectory, [
      'clone',
      '--quiet',
      '--no-checkout',
      '--filter=blob:none',
      '--',
      remote,
      directory,
    ]);
    return directory;
  }

  private async succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
    try {
      await this.git(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<Buffer> {
    const { stdout } = await run('git', [...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: this.timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
