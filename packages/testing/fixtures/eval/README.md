# 评测题库（eval fixtures）

本目录存放 M1 固定任务集（M1Plan §6）的题目数据。这里只放题目，不放 agent 代码；
加载与校验代码在 `packages/testing/src/eval-fixtures/`。

## 1. 目录结构

```text
fixtures/eval/
  tasks/
    dev/        开发集：平时随便跑、随便调
    holdout/    保留集：只在里程碑验收时跑，平时不要为它调提示词
  web-snapshots/<snapshotId>/    网页题的录制快照（M1 暂无正式网页题）
  examples/     格式示例（自身也是一个题库根目录，受测试保护，不属于正式题库）
```

- 题目属于哪个集合由**所在目录**决定，题目文件里不写。
- 文件名必须等于题目 `id`，例如 `tasks/dev/F2-001.yaml`。
- 同一 `id` 只能出现一次（跨 dev/holdout 也不行）。

## 2. 题目格式 `eval.EvalTask.v0`

Schema 定义见 `src/eval-fixtures/eval-task-schema.ts`，不允许出现未定义的字段。

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 固定为 `v0` |
| `id` | 是 | `<类别>-<三位序号>`，前缀必须与 `category` 一致 |
| `category` | 是 | `F1`–`F5`、`TRAP`（答案不在仓库里）、`WEB`、`MIXED` |
| `title` | 是 | 给人看的短标题，不发给 agent |
| `repository` | 视类别 | `{ url, commit }`；`commit` 为完整 40 位 SHA，请加引号 |
| `webSnapshot` | 视类别 | `web-snapshots/` 下的快照目录名 |
| `question` | 是 | 发给 agent 的问题；**不得出现答案文件名** |
| `expectedOutcome` | 是 | `TRAP` 题为 `UNDETERMINED`，其余为 `ANSWERED` |
| `answerPoints` | 是 | 标准答案拆成要点 `{ id: P1, text, isRequired }`，评委逐条判断 |
| `evidence.required` | 是 | 答对必须看过的证据；非 TRAP 题至少 1 条 |
| `evidence.optional` | 是 | 加分或辅助证据，可为空数组 |
| `forbiddenPaths` | 是 | gitignore 风格的 glob，agent 不应读取 |
| `forbiddenEffects` | 是 | 仓库题必须包含 `FILE_WRITE, COMMAND, TEST, NETWORK` |
| `budget` | 是 | `maxSteps` 必填，其余可选；**目前仅作参考**，见 §6 |
| `retrievalProbes` | 否 | 检索评测探针：直接调 ContextPort 的 SEARCH，不花 token |
| `provenance` | 是 | `author`、`method`（`MANUAL`/`GIT_HISTORY`/`MODEL_DRAFT`）、`sourceCommit`、`reviewedBy` |

类别与来源的对应关系：

| 类别 | `repository` | `webSnapshot` | M1 是否运行 |
|---|---|---|---|
| F1–F5、TRAP | 必须有 | 不得有 | 是 |
| WEB | 不得有 | 必须有 | 否（M1Plan §3：网络为非目标） |
| MIXED | 必须有 | 必须有 | 否 |

证据的两种形式：

```yaml
- { kind: CODE, path: src/app/fee.ts, lines: [40, 72], anchor: 'if (amount === 0)' }
- { kind: WEB, url: https://example.com/, quote: 页面里能原样找到的一句话 }
```

- `path` 是仓库相对路径；`lines` 从 1 开始、首尾都包含，口径与 FILE_READ 的 `startLine/endLine` 一致，
  评测时直接拿 Kernel 审计记录中的读取范围去比对。
- `anchor` 是这几行里的一句原文（可选，比较时忽略空白差异）。`--repos` 会确认它确实落在 `lines` 范围内，
  防止行号偏移。必需的代码证据没有锚点时给出警告。

## 3. 校验

```bash
pnpm run eval:fixtures            # 离线检查（与 pnpm run check 中的测试相同）
pnpm run eval:fixtures --repos    # 另外克隆被测仓库，在固定 commit 下核对证据（需要网络）
pnpm run eval:fixtures --root packages/testing/fixtures/eval/examples
```

`--repos` 的克隆缓存在 `.multiagent/eval-cache/`（已被 git 忽略），只做 blob-less 克隆，按需读取单个文件。
它需要网络，所以不属于质量门；改动题目后请手动跑一次。

| 代码 | 级别 | 含义 |
|---|---|---|
| `SCHEMA_INVALID` / `YAML_INVALID` | 错误 | 格式不合法 |
| `FILE_NAME_MISMATCH` / `DUPLICATE_ID` / `UNKNOWN_SPLIT` | 错误 | 文件名、id 或目录不对 |
| `ID_CATEGORY_MISMATCH` / `SOURCE_MISMATCH` / `OUTCOME_MISMATCH` | 错误 | 类别与 id、来源、预期结果不一致 |
| `MISSING_REQUIRED_EVIDENCE` / `EVIDENCE_KIND_MISMATCH` / `LINE_RANGE_INVALID` | 错误 | 证据缺失或自相矛盾 |
| `QUESTION_LEAKS_FILE_NAME` | 错误 | 问题里出现了证据文件的完整文件名 |
| `QUESTION_MENTIONS_FILE_STEM` | 警告 | 问题里出现了有辨识度的文件主干名（如 `upload-guard`） |
| `FORBIDDEN_COVERS_EVIDENCE` | 错误 | 禁止路径盖住了证据 |
| `EVIDENCE_EXCLUDED_BY_CONTEXT` | 错误 | 证据是 ContextEngine 永远不展示的文件（`.env*`、lock、`node_modules/` 等） |
| `FORBIDDEN_EFFECTS_INCOMPLETE` | 错误 | 没有禁止全部 M1 副作用 |
| `PROVENANCE_INCOMPLETE` | 错误 | `GIT_HISTORY` 题没写 `sourceCommit` |
| `UNREVIEWED_DRAFT` | 警告 | 模型出的初稿还没人核对（填上 `reviewedBy` 即消失） |
| `CATEGORY_SPLIT_UNBALANCED` | 警告 | 某个 F 类在 dev 或 holdout 中缺题 |
| `NOT_RUNNABLE_IN_M1` | 警告 | 网页题/混合题 |
| `SNAPSHOT_*` / `WEB_EVIDENCE_*` | 错误 | 快照缺失、哈希漂移、URL 未录制、关键句不在页面里 |
| `EVIDENCE_WITHOUT_ANCHOR` | 警告 | 必需的代码证据没有 `anchor` |
| `COMMIT_NOT_FOUND` / `PATH_NOT_FOUND` / `LINE_OUT_OF_RANGE` | 错误 | `--repos`：固定 commit 下证据不存在或行号越界 |
| `ANCHOR_NOT_IN_RANGE` | 错误 | `--repos`：锚点原文不在指定行范围内（提示实际所在行） |
| `BINARY_FILE` / `FILE_TOO_LARGE` | 错误 | `--repos`：证据是二进制或超过 256 KiB（ContextEngine 不会展示） |
| `REPOSITORY_UNAVAILABLE` / `SOURCE_COMMIT_NOT_FOUND` | 错误 | `--repos`：仓库克隆失败或来源提交不存在 |

## 4. 判卷口径（评测程序实现时遵循）

评测只读 Kernel 审计记录和运行状态（RuntimeProjection、UnitResult、Artifact），不读任何模块的内部数据。

| 层 | 怎么判 | 花不花钱 |
|---|---|---|
| 出处真实 | 报告引用的路径在固定 commit 下存在、行号在范围内 | 不花 |
| 证据命中 | FILE_READ 审计记录的读取范围与 `evidence.required` 行范围有重叠即算命中 | 不花 |
| 要点正确 | LLM 评委逐条判断 `answerPoints`，评委模型与提示词固定 | 少量 |
| TRAP 题 | 结果必须是“无法确定”，并列出查过的位置；编造文件或配置名直接判错 | 少量 |
| 检索评测 | `retrievalProbes`：前 k 条是否包含 `expectPaths`，计算 Recall@k 与 MRR | 不花 |

## 5. 网页快照（录制/回放）

只定格式，M1 不接真实搜索。结构见 `examples/web-snapshots/WEB-001/`：

```text
web-snapshots/<snapshotId>/
  manifest.yaml          eval.WebSnapshotManifest.v0：录制时间、工具、查询与页面清单及各自 sha256
  search/<sha16>.json    一次搜索的原始结果；文件名取查询字符串 sha256 的前 16 位
  pages/<sha16>.html     一个页面的原始响应体；文件名取 URL sha256 的前 16 位
```

- live 模式：真实搜索与抓取，同时写入上述文件；replay 模式：只读快照，不联网。
- 快照文件按字节校验 sha256，因此已加入 `.prettierignore`，并在 `.gitattributes` 中关闭换行转换。
- `search/*.json` 的内部结构等到写录制器时再冻结。

## 6. 尚未就绪的依赖

以下能力由其他模块提供，就绪前相关评测只能部分运行：

- 每题预算：Kernel/Workflow 支持按运行传入预算之前，`budget` 只作参考，实际生效的是 M1 固定预算。
- 证据命中：需要 Kernel 审计记录中包含 FILE_READ 的路径与行范围。
- 成本与缓存命中率：需要 `usage.cachedInputTokens`。
- 工作区不变检查：需要 M1Process B-07。

## 7. 出题流程

1. 在固定 commit 下读代码出题；问题用业务语言描述，不写答案文件名。
2. 模型出的初稿写 `method: MODEL_DRAFT`，人工逐题核对答案要点和行号后填写 `reviewedBy`。
3. 运行 `pnpm run eval:fixtures --repos`，确保没有错误。
4. 新题先放 dev；每个 F 类在 dev 和 holdout 中各保留至少一道。
