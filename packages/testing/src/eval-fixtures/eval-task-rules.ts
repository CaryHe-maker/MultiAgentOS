import { matchesGlob } from './glob-match.js';
import {
  FORBIDDEN_EFFECTS,
  type EvalCategory,
  type EvalSplit,
  type EvalTask,
  type Evidence,
} from './eval-task-schema.js';

export type FixtureIssueSeverity = 'ERROR' | 'WARNING';

/** 校验问题。`code` 稳定，供脚本和测试判断；`message` 只给人看。 */
export interface FixtureIssue {
  readonly code: string;
  readonly severity: FixtureIssueSeverity;
  readonly origin: string;
  readonly taskId?: string;
  readonly message: string;
}

export interface LoadedEvalTask {
  readonly task: EvalTask;
  readonly split: EvalSplit;
  /** 相对题目根目录的路径，例如 `tasks/dev/F1-001.yaml`。 */
  readonly origin: string;
}

const SPLIT_BALANCED_CATEGORIES: readonly EvalCategory[] = ['F1', 'F2', 'F3', 'F4', 'F5'];

/** 这些目录与文件永远不会进入 ContextPack（ContextEngine.md §7），放进证据等于出了一道答不出的题。 */
const CONTEXT_EXCLUDED_GLOBS = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.multiagent/',
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  '*.min.js',
  '*.min.css',
  '*.map',
] as const;
const SECRET_NAME = /(^|[._-])(secrets?|credentials?)([._-]|$)/i;

/** 太常见的文件名主干：出现在问题里不算泄题。 */
const GENERIC_STEMS = new Set([
  '__init__',
  '__main__',
  'index',
  'main',
  'app',
  'apps',
  'util',
  'utils',
  'helpers',
  'types',
  'constants',
  'config',
  'settings',
  'models',
  'views',
  'urls',
  'admin',
  'forms',
  'common',
  'service',
  'module',
  'test',
  'tests',
]);
const MIN_STEM_LENGTH = 4;

type IssueDraft = Omit<FixtureIssue, 'origin' | 'taskId'>;

/** 单题规则。只看题目本身，不读文件系统、不联网。 */
export function checkTaskRules(loaded: LoadedEvalTask): FixtureIssue[] {
  const { task } = loaded;
  const drafts: IssueDraft[] = [
    ...checkIdentity(task),
    ...checkSource(task),
    ...checkOutcome(task),
    ...checkEvidence(task),
    ...checkAnswerPoints(task),
    ...checkQuestionLeak(task),
    ...checkForbidden(task),
    ...checkProvenance(task),
    ...checkProbes(task),
  ];
  return drafts.map((draft) => ({ ...draft, origin: loaded.origin, taskId: task.id }));
}

/** 题集规则：跨题的唯一性与分集平衡。 */
export function checkTaskSetRules(tasks: readonly LoadedEvalTask[]): FixtureIssue[] {
  const issues: FixtureIssue[] = [];
  const firstOrigin = new Map<string, string>();
  for (const { task, origin } of tasks) {
    const previous = firstOrigin.get(task.id);
    if (previous === undefined) firstOrigin.set(task.id, origin);
    else
      issues.push({
        code: 'DUPLICATE_ID',
        severity: 'ERROR',
        origin,
        taskId: task.id,
        message: `id ${task.id} already used by ${previous}`,
      });
  }
  // 只有题集里已经有 F 类题时才检查分集平衡（例如只放网页题的示例目录不需要）。
  if (!tasks.some(({ task }) => SPLIT_BALANCED_CATEGORIES.includes(task.category))) return issues;
  for (const category of SPLIT_BALANCED_CATEGORIES) {
    for (const split of ['dev', 'holdout'] as const) {
      const count = tasks.filter((t) => t.task.category === category && t.split === split).length;
      if (count === 0)
        issues.push({
          code: 'CATEGORY_SPLIT_UNBALANCED',
          severity: 'WARNING',
          origin: 'tasks/',
          message: `${category} has no task in the ${split} split`,
        });
    }
  }
  return issues;
}

function error(code: string, message: string): IssueDraft {
  return { code, severity: 'ERROR', message };
}

function warning(code: string, message: string): IssueDraft {
  return { code, severity: 'WARNING', message };
}

function checkIdentity(task: EvalTask): IssueDraft[] {
  const prefix = task.id.slice(0, task.id.lastIndexOf('-'));
  return prefix === task.category
    ? []
    : [error('ID_CATEGORY_MISMATCH', `id prefix ${prefix} differs from category ${task.category}`)];
}

function checkSource(task: EvalTask): IssueDraft[] {
  const hasRepository = task.repository !== undefined;
  const hasSnapshot = task.webSnapshot !== undefined;
  const expected =
    task.category === 'WEB'
      ? { repository: false, snapshot: true }
      : task.category === 'MIXED'
        ? { repository: true, snapshot: true }
        : { repository: true, snapshot: false };
  const issues: IssueDraft[] = [];
  if (hasRepository !== expected.repository || hasSnapshot !== expected.snapshot)
    issues.push(
      error(
        'SOURCE_MISMATCH',
        `${task.category} needs repository=${expected.repository} webSnapshot=${expected.snapshot}`,
      ),
    );
  if (task.category === 'WEB' || task.category === 'MIXED')
    issues.push(
      warning('NOT_RUNNABLE_IN_M1', `${task.category} tasks need network, a non-goal of M1`),
    );
  return issues;
}

function checkOutcome(task: EvalTask): IssueDraft[] {
  const expected = task.category === 'TRAP' ? 'UNDETERMINED' : 'ANSWERED';
  return task.expectedOutcome === expected
    ? []
    : [error('OUTCOME_MISMATCH', `${task.category} tasks must expect ${expected}`)];
}

function allEvidence(task: EvalTask): Evidence[] {
  return [...task.evidence.required, ...task.evidence.optional];
}

function codePaths(task: EvalTask): string[] {
  return allEvidence(task).flatMap((item) => (item.kind === 'CODE' ? [item.path] : []));
}

function checkEvidence(task: EvalTask): IssueDraft[] {
  const issues: IssueDraft[] = [];
  if (task.category !== 'TRAP' && task.evidence.required.length === 0)
    issues.push(error('MISSING_REQUIRED_EVIDENCE', 'answerable tasks need required evidence'));
  for (const item of task.evidence.required)
    if (item.kind === 'CODE' && item.anchor === undefined)
      issues.push(
        warning('EVIDENCE_WITHOUT_ANCHOR', `${item.path} has no anchor to confirm its lines`),
      );
  for (const item of allEvidence(task)) {
    if (item.kind === 'CODE') {
      if (task.repository === undefined)
        issues.push(
          error('EVIDENCE_KIND_MISMATCH', `CODE evidence ${item.path} needs a repository`),
        );
      if (item.lines[0] > item.lines[1])
        issues.push(error('LINE_RANGE_INVALID', `${item.path} lines ${item.lines.join('-')}`));
      if (isExcludedByContext(item.path))
        issues.push(
          error('EVIDENCE_EXCLUDED_BY_CONTEXT', `${item.path} is never shown by ContextEngine`),
        );
    } else if (task.webSnapshot === undefined) {
      issues.push(error('EVIDENCE_KIND_MISMATCH', `WEB evidence ${item.url} needs a webSnapshot`));
    }
  }
  return issues;
}

export function isExcludedByContext(path: string): boolean {
  const baseName = path.slice(path.lastIndexOf('/') + 1);
  return (
    SECRET_NAME.test(baseName) || CONTEXT_EXCLUDED_GLOBS.some((glob) => matchesGlob(path, glob))
  );
}

function checkAnswerPoints(task: EvalTask): IssueDraft[] {
  const issues: IssueDraft[] = [];
  const seen = new Set<string>();
  for (const point of task.answerPoints) {
    if (seen.has(point.id)) issues.push(error('ANSWER_POINT_DUPLICATE', `duplicate ${point.id}`));
    seen.add(point.id);
  }
  if (!task.answerPoints.some((point) => point.isRequired))
    issues.push(error('NO_REQUIRED_ANSWER_POINT', 'at least one answer point must be required'));
  return issues;
}

/** M1Plan §6：问题不得泄漏答案文件名。完整文件名算错误，有辨识度的主干名算警告。 */
function checkQuestionLeak(task: EvalTask): IssueDraft[] {
  const question = task.question.toLowerCase();
  const probePaths = (task.retrievalProbes ?? []).flatMap((probe) => probe.expectPaths);
  const issues: IssueDraft[] = [];
  for (const path of new Set([...codePaths(task), ...probePaths])) {
    const baseName = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const dot = baseName.lastIndexOf('.');
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    if (question.includes(baseName))
      issues.push(error('QUESTION_LEAKS_FILE_NAME', `question contains ${baseName}`));
    else if (stem.length >= MIN_STEM_LENGTH && !GENERIC_STEMS.has(stem) && question.includes(stem))
      issues.push(warning('QUESTION_MENTIONS_FILE_STEM', `question contains file stem ${stem}`));
  }
  return issues;
}

function checkForbidden(task: EvalTask): IssueDraft[] {
  const issues: IssueDraft[] = [];
  for (const path of codePaths(task)) {
    const glob = task.forbiddenPaths.find((pattern) => matchesGlob(path, pattern));
    if (glob !== undefined)
      issues.push(error('FORBIDDEN_COVERS_EVIDENCE', `${path} matches forbidden ${glob}`));
  }
  const needsNetwork = task.category === 'WEB' || task.category === 'MIXED';
  const required = FORBIDDEN_EFFECTS.filter((effect) => !(needsNetwork && effect === 'NETWORK'));
  const missing = required.filter((effect) => !task.forbiddenEffects.includes(effect));
  if (missing.length > 0)
    issues.push(error('FORBIDDEN_EFFECTS_INCOMPLETE', `missing ${missing.join(', ')}`));
  return issues;
}

function checkProvenance(task: EvalTask): IssueDraft[] {
  const { method, reviewedBy, sourceCommit } = task.provenance;
  const issues: IssueDraft[] = [];
  if (method === 'GIT_HISTORY' && sourceCommit === undefined)
    issues.push(error('PROVENANCE_INCOMPLETE', 'GIT_HISTORY tasks must record sourceCommit'));
  // 模型出的初稿必须有人逐题核对；核对后填写 reviewedBy，警告即消失。
  if (method === 'MODEL_DRAFT' && reviewedBy === undefined)
    issues.push(warning('UNREVIEWED_DRAFT', 'model-drafted task has no reviewedBy yet'));
  return issues;
}

function checkProbes(task: EvalTask): IssueDraft[] {
  const evidencePaths = new Set(codePaths(task));
  return (task.retrievalProbes ?? []).flatMap((probe) =>
    probe.expectPaths
      .filter((path) => !evidencePaths.has(path))
      .map((path) => warning('PROBE_PATH_NOT_EVIDENCE', `probe expects ${path}, not in evidence`)),
  );
}
