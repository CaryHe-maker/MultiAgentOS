import { Type, type Static } from 'typebox';

/*
 * TS 提示：TypeBox 的 `Type.Object({...})` 在运行时是一份 JSON Schema，
 * `Static<typeof X>` 在编译期从同一份定义推导出 TS 类型——相当于 Python 里的 pydantic model：
 * 一处定义，同时得到校验器和类型。
 */

/** 题目类别。F1–F5 对应 M1Plan §6；WEB/MIXED 只定格式，M1 内不运行（M1Plan §3 网络为非目标）。 */
export const EVAL_CATEGORIES = ['F1', 'F2', 'F3', 'F4', 'F5', 'TRAP', 'WEB', 'MIXED'] as const;
// 逐个写 Literal：对数组 `.map(Type.Literal)` 会让 TS 把字面量拓宽成 string，推导出 never。
export const EvalCategorySchema = Type.Union([
  Type.Literal('F1'),
  Type.Literal('F2'),
  Type.Literal('F3'),
  Type.Literal('F4'),
  Type.Literal('F5'),
  Type.Literal('TRAP'),
  Type.Literal('WEB'),
  Type.Literal('MIXED'),
]);
export type EvalCategory = Static<typeof EvalCategorySchema>;

/** M1 必须禁止的副作用；WEB/MIXED 题将来可以放开 NETWORK。 */
export const FORBIDDEN_EFFECTS = ['FILE_WRITE', 'COMMAND', 'TEST', 'NETWORK'] as const;
export const ForbiddenEffectSchema = Type.Union([
  Type.Literal('FILE_WRITE'),
  Type.Literal('COMMAND'),
  Type.Literal('TEST'),
  Type.Literal('NETWORK'),
]);
export type ForbiddenEffect = Static<typeof ForbiddenEffectSchema>;

/**
 * 仓库内相对路径：POSIX 分隔符，不以 `/` 开头，不含 `.`/`..` 段、反斜杠或连续斜杠。
 * 与 FILE_READ 审计记录中的 path 同一口径。
 */
export const RelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: '^(?!/)(?!.*//)(?!.*\\\\)(?!(?:.*/)?\\.{1,2}(?:/|$)).+$',
});

export const RepositoryRefSchema = Type.Object(
  {
    url: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 512 }),
    /** 完整 40 位 SHA；短 SHA 可能随仓库增长变得有歧义。 */
    commit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
  },
  { additionalProperties: false },
);
export type RepositoryRef = Static<typeof RepositoryRefSchema>;

/** 代码证据：行号从 1 开始，首尾都包含（与 FILE_READ 的 startLine/endLine 一致）。 */
export const CodeEvidenceSchema = Type.Object(
  {
    kind: Type.Literal('CODE'),
    path: RelativePathSchema,
    lines: Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]),
    /**
     * 行范围里的一句原文，用来确认行号指的确实是那段代码（行号偏几行时校验会失败）。
     * 比较时忽略空白差异。
     */
    anchor: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);
export type CodeEvidence = Static<typeof CodeEvidenceSchema>;

/** 网页证据：URL 必须出现在快照清单里，quote 必须能在快照页面正文中原样找到。 */
export const WebEvidenceSchema = Type.Object(
  {
    kind: Type.Literal('WEB'),
    url: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 1024 }),
    quote: Type.String({ minLength: 1, maxLength: 500 }),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);
export type WebEvidence = Static<typeof WebEvidenceSchema>;

export const EvidenceSchema = Type.Union([CodeEvidenceSchema, WebEvidenceSchema]);
export type Evidence = Static<typeof EvidenceSchema>;

/** 标准答案拆成要点，评委逐条判断“答到/没答到”。 */
export const AnswerPointSchema = Type.Object(
  {
    id: Type.String({ pattern: '^P[0-9]{1,2}$' }),
    text: Type.String({ minLength: 1, maxLength: 500 }),
    isRequired: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type AnswerPoint = Static<typeof AnswerPointSchema>;

/**
 * 每道题的预算。目前只作参考：Kernel/Workflow 支持按运行传入预算之前，
 * 实际生效的仍是 M1 固定预算。
 */
export const EvalBudgetSchema = Type.Object(
  {
    maxSteps: Type.Integer({ minimum: 1, maximum: 200 }),
    maxModelCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export type EvalBudget = Static<typeof EvalBudgetSchema>;

/** 检索评测探针：直接调 ContextPort 的 SEARCH，不经过模型、不花 token。 */
export const RetrievalProbeSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 300 }),
    mode: Type.Union([
      Type.Literal('AUTO'),
      Type.Literal('TEXT'),
      Type.Literal('PATH'),
      Type.Literal('SYMBOL'),
    ]),
    k: Type.Integer({ minimum: 1, maximum: 20 }),
    expectPaths: Type.Array(RelativePathSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type RetrievalProbe = Static<typeof RetrievalProbeSchema>;

/** 出题来源，便于复核：人工、git 历史反推、模型初稿（必须有人复核）。 */
export const TaskProvenanceSchema = Type.Object(
  {
    author: Type.String({ minLength: 1, maxLength: 80 }),
    method: Type.Union([
      Type.Literal('MANUAL'),
      Type.Literal('GIT_HISTORY'),
      Type.Literal('MODEL_DRAFT'),
    ]),
    /** GIT_HISTORY 题反推所依据的提交。 */
    sourceCommit: Type.Optional(Type.String({ pattern: '^[0-9a-f]{40}$' })),
    reviewedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  },
  { additionalProperties: false },
);
export type TaskProvenance = Static<typeof TaskProvenanceSchema>;

export const EVAL_TASK_SCHEMA_ID = 'eval.EvalTask.v0';

export const EvalTaskSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    id: Type.String({ pattern: '^(F[1-5]|TRAP|WEB|MIXED)-[0-9]{3}$' }),
    category: EvalCategorySchema,
    title: Type.String({ minLength: 1, maxLength: 80 }),
    repository: Type.Optional(RepositoryRefSchema),
    /** 快照目录名（fixtures/eval/web-snapshots/<name>），WEB/MIXED 题使用。 */
    webSnapshot: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' })),
    question: Type.String({ minLength: 5, maxLength: 2000 }),
    expectedOutcome: Type.Union([Type.Literal('ANSWERED'), Type.Literal('UNDETERMINED')]),
    answerPoints: Type.Array(AnswerPointSchema, { minItems: 1, maxItems: 12 }),
    evidence: Type.Object(
      {
        required: Type.Array(EvidenceSchema, { maxItems: 20 }),
        optional: Type.Array(EvidenceSchema, { maxItems: 20 }),
      },
      { additionalProperties: false },
    ),
    forbiddenPaths: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    forbiddenEffects: Type.Array(ForbiddenEffectSchema, { minItems: 1, uniqueItems: true }),
    budget: EvalBudgetSchema,
    retrievalProbes: Type.Optional(Type.Array(RetrievalProbeSchema, { maxItems: 10 })),
    provenance: TaskProvenanceSchema,
  },
  { additionalProperties: false, $id: EVAL_TASK_SCHEMA_ID },
);
export type EvalTask = Static<typeof EvalTaskSchema>;

/** 开发集平时随便跑；保留集只在里程碑验收时跑。由所在目录决定，不写在题目里。 */
export const EVAL_SPLITS = ['dev', 'holdout'] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

export const WEB_SNAPSHOT_MANIFEST_SCHEMA_ID = 'eval.WebSnapshotManifest.v0';

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' });
const SnapshotFileSchema = (directory: string) =>
  Type.String({ pattern: `^${directory}/[0-9a-f]{16,64}\\.[a-z]{2,5}$` });

/**
 * 网页快照清单（录制/回放）。live 模式录制时写入；replay 模式只读它和它引用的文件。
 * 查询和 URL 用 sha256 的前缀命名文件，避免特殊字符进入文件名。
 */
export const WebSnapshotManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal('v0'),
    snapshotId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }),
    recordedAt: Type.String({ format: 'date-time' }),
    recorder: Type.Object(
      {
        tool: Type.String({ minLength: 1, maxLength: 80 }),
        version: Type.String({ minLength: 1, maxLength: 40 }),
      },
      { additionalProperties: false },
    ),
    queries: Type.Array(
      Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500 }),
          engine: Type.String({ minLength: 1, maxLength: 80 }),
          resultFile: SnapshotFileSchema('search'),
          sha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
    ),
    pages: Type.Array(
      Type.Object(
        {
          url: Type.String({ pattern: '^https://[^\\s]+$', maxLength: 1024 }),
          fetchedAt: Type.String({ format: 'date-time' }),
          httpStatus: Type.Integer({ minimum: 100, maximum: 599 }),
          contentType: Type.String({ minLength: 1, maxLength: 120 }),
          bodyFile: SnapshotFileSchema('pages'),
          sha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, $id: WEB_SNAPSHOT_MANIFEST_SCHEMA_ID },
);
export type WebSnapshotManifest = Static<typeof WebSnapshotManifestSchema>;
