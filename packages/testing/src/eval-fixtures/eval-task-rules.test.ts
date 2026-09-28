import { describe, expect, it } from 'vitest';
import {
  checkTaskRules,
  checkTaskSetRules,
  isReviewed,
  type LoadedEvalTask,
} from './eval-task-rules.js';
import type { EvalTask } from './eval-task-schema.js';

const COMMIT = 'a'.repeat(40);

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    schemaVersion: 'v0',
    id: 'F2-001',
    category: 'F2',
    title: '上传大小限制',
    repository: { url: 'https://github.com/example/app', commit: COMMIT },
    question: '用户上传的文件超过大小限制时，系统在哪里拦截？返回什么错误？',
    expectedOutcome: 'ANSWERED',
    answerPoints: [{ id: 'P1', text: '在上传中间件检查 Content-Length', isRequired: true }],
    evidence: {
      required: [
        {
          kind: 'CODE',
          path: 'src/middleware/upload-guard.ts',
          lines: [40, 72],
          anchor: 'if (length > limit)',
        },
      ],
      optional: [],
    },
    forbiddenPaths: ['.env*', 'secrets/'],
    forbiddenEffects: ['FILE_WRITE', 'COMMAND', 'TEST', 'NETWORK'],
    budget: { maxSteps: 20 },
    provenance: { author: 'meti', method: 'MANUAL' },
    ...overrides,
  };
}

function loaded(value: EvalTask, split: 'dev' | 'holdout' = 'dev'): LoadedEvalTask {
  return { task: value, split, origin: `tasks/${split}/${value.id}.yaml` };
}

const codes = (value: EvalTask) => checkTaskRules(loaded(value)).map((issue) => issue.code);

describe('checkTaskRules', () => {
  it('accepts a well-formed repository task', () => {
    expect(checkTaskRules(loaded(task()))).toEqual([]);
  });

  it('rejects an id whose prefix disagrees with the category', () => {
    expect(codes(task({ id: 'F3-001' }))).toContain('ID_CATEGORY_MISMATCH');
  });

  it('requires repository tasks to name a repository and no web snapshot', () => {
    const { repository: _omit, ...withoutRepository } = task();
    void _omit;
    expect(codes(withoutRepository)).toContain('SOURCE_MISMATCH');
    expect(codes(task({ webSnapshot: 'W-001' }))).toContain('SOURCE_MISMATCH');
  });

  it('requires WEB tasks to use a snapshot and no repository', () => {
    const { repository: _omit, ...base } = task();
    void _omit;
    const web: EvalTask = {
      ...base,
      id: 'WEB-001',
      category: 'WEB',
      webSnapshot: 'WEB-001',
      evidence: {
        required: [{ kind: 'WEB', url: 'https://example.com/', quote: 'Example Domain' }],
        optional: [],
      },
    };
    expect(codes(web)).toEqual(['NOT_RUNNABLE_IN_M1']);
    expect(codes({ ...web, webSnapshot: undefined } as unknown as EvalTask)).toContain(
      'SOURCE_MISMATCH',
    );
  });

  it('rejects evidence whose kind has no matching source', () => {
    const value = task({
      evidence: {
        required: [{ kind: 'WEB', url: 'https://example.com/', quote: 'x' }],
        optional: [],
      },
    });
    expect(codes(value)).toContain('EVIDENCE_KIND_MISMATCH');
  });

  it('ties TRAP to UNDETERMINED and everything else to ANSWERED', () => {
    expect(codes(task({ expectedOutcome: 'UNDETERMINED' }))).toContain('OUTCOME_MISMATCH');
    const trap = task({
      id: 'TRAP-001',
      category: 'TRAP',
      expectedOutcome: 'UNDETERMINED',
      evidence: { required: [], optional: [] },
    });
    expect(codes(trap)).toEqual([]);
    expect(codes({ ...trap, expectedOutcome: 'ANSWERED' })).toContain('OUTCOME_MISMATCH');
  });

  it('requires at least one required evidence item for answerable tasks', () => {
    expect(codes(task({ evidence: { required: [], optional: [] } }))).toContain(
      'MISSING_REQUIRED_EVIDENCE',
    );
  });

  it('rejects reversed line ranges', () => {
    const value = task({
      evidence: { required: [{ kind: 'CODE', path: 'src/a.ts', lines: [9, 3] }], optional: [] },
    });
    expect(codes(value)).toContain('LINE_RANGE_INVALID');
  });

  it('rejects duplicate answer point ids and sets without a required point', () => {
    const points = [
      { id: 'P1', text: 'a', isRequired: false },
      { id: 'P1', text: 'b', isRequired: false },
    ];
    const result = codes(task({ answerPoints: points }));
    expect(result).toContain('ANSWER_POINT_DUPLICATE');
    expect(result).toContain('NO_REQUIRED_ANSWER_POINT');
  });

  it('rejects a question that leaks an evidence file name', () => {
    const value = task({ question: '请解释 upload-guard.ts 里第 40 行的逻辑' });
    expect(codes(value)).toContain('QUESTION_LEAKS_FILE_NAME');
  });

  it('warns when the question mentions a distinctive file stem', () => {
    const issues = checkTaskRules(loaded(task({ question: 'upload-guard 在超限时返回什么？' })));
    expect(issues).toEqual([
      expect.objectContaining({ code: 'QUESTION_MENTIONS_FILE_STEM', severity: 'WARNING' }),
    ]);
  });

  it('ignores generic stems such as index or __init__', () => {
    const value = task({
      question: '入口 index 做了什么初始化？',
      evidence: {
        required: [{ kind: 'CODE', path: 'src/index.ts', lines: [1, 5], anchor: 'init()' }],
        optional: [],
      },
    });
    expect(codes(value)).toEqual([]);
  });

  it('rejects forbidden paths that cover evidence', () => {
    expect(codes(task({ forbiddenPaths: ['src/middleware/'] }))).toContain(
      'FORBIDDEN_COVERS_EVIDENCE',
    );
  });

  it('rejects evidence that ContextEngine would never show to the agent', () => {
    for (const path of [
      'node_modules/x/index.js',
      'config/.env.local',
      'pnpm-lock.yaml',
      'a.min.js',
    ]) {
      const value = task({
        evidence: { required: [{ kind: 'CODE', path, lines: [1, 1] }], optional: [] },
      });
      expect(codes(value), path).toContain('EVIDENCE_EXCLUDED_BY_CONTEXT');
    }
  });

  it('requires every M1 side effect to be forbidden for repository tasks', () => {
    expect(codes(task({ forbiddenEffects: ['FILE_WRITE'] }))).toContain(
      'FORBIDDEN_EFFECTS_INCOMPLETE',
    );
  });

  it('requires GIT_HISTORY provenance to name its source commit', () => {
    expect(codes(task({ provenance: { author: 'meti', method: 'GIT_HISTORY' } }))).toContain(
      'PROVENANCE_INCOMPLETE',
    );
  });

  it('warns when required code evidence has no anchor', () => {
    const value = task({
      evidence: { required: [{ kind: 'CODE', path: 'src/a.ts', lines: [1, 3] }], optional: [] },
    });
    expect(checkTaskRules(loaded(value))).toEqual([
      expect.objectContaining({ code: 'EVIDENCE_WITHOUT_ANCHOR', severity: 'WARNING' }),
    ]);
  });

  it('warns until a model-drafted task has been reviewed', () => {
    const draft = task({ provenance: { author: 'claude', method: 'MODEL_DRAFT' } });
    expect(checkTaskRules(loaded(draft))).toEqual([
      expect.objectContaining({ code: 'UNREVIEWED_DRAFT', severity: 'WARNING' }),
    ]);
    const reviewed = task({
      provenance: { author: 'claude', method: 'MODEL_DRAFT', reviewedBy: 'meti' },
    });
    expect(checkTaskRules(loaded(reviewed))).toEqual([]);
  });

  it('warns when a retrieval probe expects a path that is not evidence', () => {
    const value = task({
      retrievalProbes: [{ query: 'upload limit', mode: 'AUTO', k: 5, expectPaths: ['src/x.ts'] }],
    });
    expect(checkTaskRules(loaded(value))).toEqual([
      expect.objectContaining({ code: 'PROBE_PATH_NOT_EVIDENCE', severity: 'WARNING' }),
    ]);
  });
});

describe('checkTaskSetRules', () => {
  it('rejects duplicate ids across splits', () => {
    const issues = checkTaskSetRules([loaded(task()), loaded(task(), 'holdout')]);
    expect(issues.map((issue) => issue.code)).toContain('DUPLICATE_ID');
  });

  it('warns when a repository category is missing from one split', () => {
    const issues = checkTaskSetRules([loaded(task())]);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'CATEGORY_SPLIT_UNBALANCED', severity: 'WARNING' }),
    );
  });
});

describe('isReviewed', () => {
  it('counts human-written tasks and reviewed model drafts only', () => {
    expect(isReviewed(task())).toBe(true);
    expect(isReviewed(task({ provenance: { author: 'claude', method: 'MODEL_DRAFT' } }))).toBe(
      false,
    );
    const reviewed = { author: 'claude', method: 'MODEL_DRAFT', reviewedBy: 'meti' } as const;
    expect(isReviewed(task({ provenance: reviewed }))).toBe(true);
  });
});
