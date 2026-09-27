import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '@multiagentos/contracts';
import { parse } from 'yaml';
import {
  checkTaskRules,
  checkTaskSetRules,
  type FixtureIssue,
  type LoadedEvalTask,
} from './eval-task-rules.js';
import {
  EVAL_SPLITS,
  EvalTaskSchema,
  WebSnapshotManifestSchema,
  type EvalSplit,
  type EvalTask,
  type WebSnapshotManifest,
} from './eval-task-schema.js';
import {
  checkSnapshotIntegrity,
  checkWebEvidence,
  type LoadedWebSnapshot,
} from './web-snapshot-rules.js';

/**
 * 仓库内的题目根目录。src 与 dist 都位于 `packages/testing/<src|dist>/eval-fixtures/`，
 * 所以同一个相对 URL 在两种运行方式下都指向 `packages/testing/fixtures/eval`。
 */
export const DEFAULT_EVAL_FIXTURES_DIRECTORY = fileURLToPath(
  new URL('../../fixtures/eval', import.meta.url),
);

export interface EvalFixtureSet {
  readonly tasks: readonly LoadedEvalTask[];
  readonly snapshots: ReadonlyMap<string, LoadedWebSnapshot>;
  readonly issues: readonly FixtureIssue[];
}

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);
const IGNORED_FILES = new Set(['README.md', '.gitkeep', '.DS_Store']);

/**
 * 读取 `<root>/tasks/<split>/*.yaml` 与 WEB/MIXED 题引用的 `<root>/web-snapshots/<name>/`，
 * 做 Schema 校验和全部离线规则。不联网、不读被测仓库；那部分见 check-repository-evidence。
 */
export async function loadEvalFixtures(rootDirectory: string): Promise<EvalFixtureSet> {
  const issues: FixtureIssue[] = [];
  const tasks: LoadedEvalTask[] = [];
  const tasksDirectory = join(rootDirectory, 'tasks');
  if (!(await isDirectory(tasksDirectory))) {
    issues.push({
      code: 'TASKS_DIRECTORY_MISSING',
      severity: 'ERROR',
      origin: 'tasks/',
      message: `${tasksDirectory} does not exist`,
    });
    return { tasks, snapshots: new Map(), issues };
  }

  for (const entry of await sortedEntries(tasksDirectory)) {
    const origin = `tasks/${entry.name}`;
    if (!entry.isDirectory()) {
      if (!IGNORED_FILES.has(entry.name)) issues.push(unexpectedFile(origin));
      continue;
    }
    if (!isSplit(entry.name)) {
      issues.push({
        code: 'UNKNOWN_SPLIT',
        severity: 'ERROR',
        origin: `${origin}/`,
        message: `split must be one of ${EVAL_SPLITS.join(', ')}`,
      });
      continue;
    }
    const split = entry.name;
    for (const file of await sortedEntries(join(tasksDirectory, split))) {
      const fileOrigin = `${origin}/${file.name}`;
      if (!file.isFile() || !YAML_EXTENSIONS.has(extname(file.name))) {
        if (!IGNORED_FILES.has(file.name)) issues.push(unexpectedFile(fileOrigin));
        continue;
      }
      const task = await readDocument<EvalTask>(
        join(tasksDirectory, split, file.name),
        fileOrigin,
        EvalTaskSchema,
        issues,
      );
      if (task === undefined) continue;
      if (basename(file.name, extname(file.name)) !== task.id)
        issues.push({
          code: 'FILE_NAME_MISMATCH',
          severity: 'ERROR',
          origin: fileOrigin,
          taskId: task.id,
          message: `file name must be ${task.id}.yaml`,
        });
      tasks.push({ task: deepFreeze(task), split, origin: fileOrigin });
    }
  }
  tasks.sort(bySplitThenOrigin);

  for (const loaded of tasks) issues.push(...checkTaskRules(loaded));
  issues.push(...checkTaskSetRules(tasks));

  const snapshots = new Map<string, LoadedWebSnapshot>();
  for (const loaded of tasks) {
    const name = loaded.task.webSnapshot;
    if (name === undefined) continue;
    if (!snapshots.has(name)) {
      const snapshot = await loadWebSnapshot(rootDirectory, name, issues);
      if (snapshot === undefined) {
        issues.push({
          code: 'SNAPSHOT_MISSING',
          severity: 'ERROR',
          origin: loaded.origin,
          taskId: loaded.task.id,
          message: `web-snapshots/${name}/manifest.yaml is missing or invalid`,
        });
        continue;
      }
      snapshots.set(name, snapshot);
      issues.push(...checkSnapshotIntegrity(snapshot));
    }
    const snapshot = snapshots.get(name);
    if (snapshot !== undefined)
      issues.push(...checkWebEvidence(loaded.task, loaded.origin, snapshot));
  }
  return { tasks, snapshots, issues };
}

async function loadWebSnapshot(
  rootDirectory: string,
  name: string,
  issues: FixtureIssue[],
): Promise<LoadedWebSnapshot | undefined> {
  const directory = join(rootDirectory, 'web-snapshots', name);
  const manifestPath = join(directory, 'manifest.yaml');
  const origin = `web-snapshots/${name}/manifest.yaml`;
  if (!(await isFile(manifestPath))) return undefined;
  const manifest = await readDocument<WebSnapshotManifest>(
    manifestPath,
    origin,
    WebSnapshotManifestSchema,
    issues,
  );
  if (manifest === undefined) return undefined;
  const files = new Map<string, Uint8Array | undefined>();
  const referenced = [
    ...manifest.queries.map((query) => query.resultFile),
    ...manifest.pages.map((page) => page.bodyFile),
  ];
  for (const file of referenced) {
    const path = join(directory, file);
    files.set(file, (await isFile(path)) ? new Uint8Array(await readFile(path)) : undefined);
  }
  return { name, origin, manifest: deepFreeze(manifest), files };
}

async function readDocument<T>(
  path: string,
  origin: string,
  schema: typeof EvalTaskSchema | typeof WebSnapshotManifestSchema,
  issues: FixtureIssue[],
): Promise<T | undefined> {
  let value: unknown;
  try {
    // YAML 1.2 core：`on/off/yes/no` 不会被当成布尔值；重复键直接报错。
    value = parse(await readFile(path, 'utf8'), { uniqueKeys: true, logLevel: 'error' });
  } catch (cause: unknown) {
    issues.push({
      code: 'YAML_INVALID',
      severity: 'ERROR',
      origin,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return undefined;
  }
  const result = validate<T>(schema, value);
  if (!result.ok) {
    issues.push({
      code: 'SCHEMA_INVALID',
      severity: 'ERROR',
      origin,
      message: result.issues.join('; '),
    });
    return undefined;
  }
  return result.value;
}

function unexpectedFile(origin: string): FixtureIssue {
  return { code: 'UNEXPECTED_FILE', severity: 'WARNING', origin, message: 'not a task file' };
}

function isSplit(name: string): name is EvalSplit {
  return (EVAL_SPLITS as readonly string[]).includes(name);
}

function bySplitThenOrigin(left: LoadedEvalTask, right: LoadedEvalTask): number {
  const splitOrder = EVAL_SPLITS.indexOf(left.split) - EVAL_SPLITS.indexOf(right.split);
  return splitOrder !== 0 ? splitOrder : left.origin.localeCompare(right.origin);
}

async function sortedEntries(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/** 发布值不可变（Style §2.2）：加载后整棵对象冻结，防止评测代码意外改题。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
