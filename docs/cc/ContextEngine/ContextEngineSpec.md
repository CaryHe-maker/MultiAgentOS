# ContextEngine 模块规格（M1）

> 读者：开发者与 AI 编码助手。本文是实现 ContextEngine 的直接依据，要求精确、可测试。  
> 配套：`ContextEngineGuide.md`（面向 meti 的理解版，解释每个设计为什么这样做）  
> 作者：Claude（Cowork），应 meti 的请求撰写；负责人 meti  
> 依据：`feat/M1` 提交 `392a3b5` 的 `TargetM1.md`、`M1RequirementsSpecification.md`、`packages/contracts`、`packages/kernel`、`packages/context-engine`，以及 `docs/cc/M1ChangeProposal.md` 第 3–5 节  
> 状态：v0 草案。其中标注【合约变更】的内容需要三人评审后才能改 `packages/contracts`

---

## 1 职责与边界

### 1.1 一句话定义

ContextEngine 决定**模型在每一轮能看到什么**：它为 Agent 提供仓库概览和代码搜索结果，并把任务、历史观察和状态组装成一份不超出 token 预算、可追溯来源的模型输入。

### 1.2 M1 负责

| 编号 | 能力 | 对应需求 |
|---|---|---|
| R1 | 仓库快照：文件树、ignore 规则、repository revision | FR-CTX-001 |
| R2 | 检索：路径、文本（rg）、符号名称 | FR-CTX-002 |
| R3 | 分块、去重、排序、按 token 预算裁剪 | FR-CTX-003 |
| R4 | 不可变 ContextPack，带 revision、来源、token 统计与 provenance | FR-CTX-004 |
| R5 | 模型输入组装：稳定前缀、历史观察的截断与压缩、状态栏 | 提案 §3.3 |
| R6 | 评测：检索评测与端到端评测框架 | 提案 §4 |

### 1.3 M1 不负责

- 修改 workspace、执行命令、运行测试（FR-CTX-006）。
- 读取单个文件的指定行：这是 Kernel `FILE_READ` 的职责。ContextEngine 只在检索时读取文件内容。
- 判断任务成功、决定下一步动作：属于 Workflow。
- 系统提示词与工具定义的内容：属于 AgentToolPool。ContextEngine 只负责它们在模型输入中的**位置与顺序**。
- 把模型输入渲染成具体供应商的消息格式：属于 Kernel 的模型适配器。
- 向量检索、tree-sitter、SCIP、reranker、跨会话记忆：M2 及以后。

### 1.4 调用关系（不变）

```text
Workflow ──CONTEXT UnitIntent──> Kernel ──ContextPort.buildContext()──> ContextEngine
Workflow <──UnitResult(outputRef=ContextPack Artifact)── Kernel <──────── ContextPack
```

ContextEngine 只接受 Kernel 调用（FR-CTX-005），不得导入其他模块的内部实现。它依赖的端口只有两个：`ArtifactStorePort`（读取观察结果）和工作区只读文件访问。

---

## 2 三种操作

Context Unit 按 `operation` 分为三种。【合约变更】

| 操作 | 何时调用 | 输入要点 | 输出 |
|---|---|---|---|
| `ORIENT` | 每次运行开始时调用一次 | objective | 仓库概览 Pack |
| `SEARCH` | 模型发出 SEARCH / QUERY 动作时 | query、搜索模式 | 检索结果 Pack |
| `ASSEMBLE` | 每次调用模型之前 | 指令与工具定义的引用、步骤历史、状态事实 | 有序的模型输入 Pack |

一次典型运行的调用序列：

```text
ORIENT → ASSEMBLE → MODEL → (SEARCH → ASSEMBLE → MODEL)* / (FILE_READ → ASSEMBLE → MODEL)* → FINAL
```

### 2.1 ORIENT：仓库概览

**目的：** 让模型在第一轮就知道仓库长什么样，减少盲目搜索。

**内容，按顺序生成，总量不超过 `orientBudget`（默认 2,500 token）：**

1. **项目记忆**：仓库根目录的 `AGENTS.md`，没有则尝试 `CLAUDE.md`；截断到 800 token。都不存在就跳过。
2. **目录树摘要**：深度不超过 3 层，每个目录最多列 20 项，超出部分显示为 `…(+N)`；附每个目录的文件数。
3. **项目清单文件**：`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml` 等，只保留 name、scripts、主要依赖。
4. **README 摘要**：前 60 行。
5. **符号大纲**：对与 objective 词项相关度最高的至多 10 个源文件，列出顶层定义（函数、类、导出常量）的名称与行号，用正则提取（见 §5.3）。
6. **测试布局**：测试目录与测试文件的命名模式，例如 `test/**/*.test.ts`。

**规则：** ORIENT 在整个运行中只生成一次，之后作为稳定前缀的一部分原样复用，保证模型输入前缀不变（§4.2）。

### 2.2 SEARCH：代码检索

**输入：** `query`（字符串）、`mode`：`AUTO`（默认）、`TEXT`、`PATH`、`SYMBOL`，以及 `maxItems`（默认 8）。

**流程：**

```text
1 查询规范化   从 query 提取：标识符（驼峰、下划线拆分前后都保留）、带引号的短语、路径片段
2 多路召回     PATH：文件路径匹配；TEXT：rg 固定字符串；SYMBOL：定义模式正则（§5.3）
3 命中成块     每个命中取上下文窗口，重叠窗口合并（§5.2）
4 打分排序     确定性打分（§5.4）
5 去重         与本次 AgentRun 已给出过的块比较（§5.5）
6 预算裁剪     在 tokenBudget 内按分数装入，并限制单文件占比
7 发布         不可变 Pack + 诊断信息
```

**AUTO 模式：** 查询像路径（含 `/` 或文件扩展名）时优先 PATH；像标识符时同时走 SYMBOL 与 TEXT；其余走 TEXT。三路结果合并后统一打分。

**零结果处理：** 返回空 items 与 `diagnostics.suggestions`：拆分后的子词、大小写变体、近似路径。**不得**为了“有结果”而放宽到不相关内容。

### 2.3 ASSEMBLE：模型输入组装

**输入：**

- `instructionsRef`：系统提示词（来自 AgentToolPool DefinitionVersion，由 Workflow 解析后以 Artifact 传入）；
- `toolSchemasRef`：工具定义；
- `orientPackRef`：ORIENT 的输出；
- `steps`：按时间顺序的步骤记录，每步包含动作摘要与观察结果的 ArtifactRef（§3.1 `StepRecord`）；
- `status`：由 Workflow 提供的状态事实（§5.7）。

**输出：** 一个按固定分段排列的 Pack：

| 段 | 内容 | 是否稳定 | 渲染角色提示 |
|---|---|---|---|
| `PREFIX` | 指令、工具定义、任务说明、ORIENT 概览 | 整个运行不变 | system / user |
| `HISTORY` | 各步骤的动作与观察，按 §4.3 规则截断或压缩 | 只追加；压缩时成批改写 | assistant / tool |
| `STATUS` | 状态栏 | 每轮都变 | user（位于末尾） |

**硬性要求：**

1. `PREFIX` 的字节内容在整个运行中必须完全一致（写入 `prefixSha256` 以便测试）。
2. 外部内容（代码、搜索结果、文件内容）只能出现在 `HISTORY` 的观察中，不得进入 `PREFIX` 的指令部分。
3. 总 token 估算不得超过 `tokenBudget`；无法满足最低内容（PREFIX + 最近一步观察 + STATUS）时返回错误 `CONTEXT_BUDGET_INSUFFICIENT`。

---

## 3 数据结构【合约变更】

以下用 TypeScript 类型描述。实现时在 `packages/contracts` 中用 TypeBox 定义并运行时校验，保持 `additionalProperties: false`。

### 3.1 ContextRequest（改为按 operation 区分的判别联合）

```ts
interface ContextRequestBase {
  requestId: string;              // 新增，前缀 'crq_'
  workflowRunId: string;
  missionScopeId: string;
  graphRevision: number;
  taskRunId: string;
  agentRunId: string;
  workspace: WorkspaceRef;
  tokenBudget: number;
}

interface OrientRequest extends ContextRequestBase {
  operation: 'ORIENT';
  objective: string;
}

interface SearchRequest extends ContextRequestBase {
  operation: 'SEARCH';
  query: string;
  mode: 'AUTO' | 'TEXT' | 'PATH' | 'SYMBOL';
  maxItems?: number;              // 默认 8，上限 20
}

interface AssembleRequest extends ContextRequestBase {
  operation: 'ASSEMBLE';
  objective: string;
  instructionsRef: ArtifactRef;
  toolSchemasRef: ArtifactRef;
  orientPackRef: ArtifactRef;
  steps: StepRecord[];
  status: StatusFacts;
}

interface StepRecord {
  stepIndex: number;              // 从 0 开始
  action: {
    kind: 'SEARCH' | 'READ' | 'QUERY' | 'ASK_USER' | 'CANNOT_DETERMINE' | 'FINAL' | 'INVALID';
    summary: string;              // Workflow 生成的一行动作描述，例如 "SEARCH 'applyDiscount' (AUTO)"
    rawRef?: ArtifactRef;         // 模型原始输出
  };
  observationRef?: ArtifactRef;   // 观察结果（搜索 Pack、文件内容、错误信息）
  observationKind?: 'CONTEXT_PACK' | 'FILE_CONTENT' | 'ERROR' | 'NOTE';
}

type ContextRequest = OrientRequest | SearchRequest | AssembleRequest;
```

**与现有合约的差异：** 删除 `query?` 与 `previousObservationRefs`，分别由 `SearchRequest.query` 和 `AssembleRequest.steps` 取代。合约仍处于 `v0/experimental`，允许此变更，但必须同步更新正反 schema 测试与 Kernel 中的调用。

### 3.2 ContextPack（扩展）

```ts
interface ContextPack {
  contextPackId: string;
  requestId: string;              // 新增
  operation: 'ORIENT' | 'SEARCH' | 'ASSEMBLE';    // 新增
  workspace: WorkspaceRef;
  repositoryRevision: string;
  snapshotId: string;             // 新增，见 §5.1
  items: ContextItem[];
  tokenCount: number;             // 所有 item 的 tokenCount 之和
  tokenBudget: number;            // 新增
  truncated: boolean;             // 新增：是否有候选因预算被丢弃
  droppedCount: number;           // 新增
  prefixSha256?: string;          // 新增：仅 ASSEMBLE，PREFIX 段内容的哈希
  provenance: Provenance[];
  diagnosticsRef?: ArtifactRef;   // 新增：候选、分数、丢弃原因
  createdAt: string;
}

interface ContextItem {
  itemId: string;                 // 新增，Pack 内唯一
  kind: 'INSTRUCTIONS' | 'TOOLS' | 'TASK' | 'MEMORY' | 'TREE' | 'MANIFEST' | 'OUTLINE'
      | 'SEARCH_HIT' | 'ACTION' | 'OBSERVATION' | 'DIGEST' | 'STATUS';   // 新增
  segment: 'PREFIX' | 'HISTORY' | 'STATUS' | 'BODY';                    // 新增；ORIENT 与 SEARCH 用 BODY
  role: 'system' | 'user' | 'assistant' | 'tool';                       // 新增，渲染提示
  path?: string;                  // 由必填改为可选：非代码项没有路径
  startLine?: number;
  endLine?: number;
  content: string;
  contentSha256: string;          // 新增
  tokenCount: number;             // 新增
  score?: number;                 // 新增，仅 SEARCH_HIT
  reason: string;
}

interface Provenance {
  itemId: string;                 // 新增：对应 item
  source: string;                 // 路径或 ArtifactRef.artifactId
  revision: string;
  retrieval: 'TREE' | 'PATH' | 'TEXT' | 'SYMBOL' | 'MEMORY' | 'MANIFEST' | 'OBSERVATION' | 'ARTIFACT';
}
```

### 3.3 ContextPort 返回类型

现有签名 `buildContext(): Promise<ContextPack>` 只能用抛异常表示失败，Kernel 目前把所有异常统一映射为 `CONTEXT_EXECUTION_FAILED`，丢失了错误类别。建议改为：

```ts
interface ContextPort {
  buildContext(request: ContextRequest, context: BoundaryContext): Promise<PortResult<ContextPack>>;
}
```

Kernel 据此把 `ModuleError` 原样写入 `UnitResult.error`。

### 3.4 错误码

| code | category | retryable | 触发条件 |
|---|---|---|---|
| `CONTEXT_REQUEST_INVALID` | VALIDATION | 否 | schema 校验失败 |
| `WORKSPACE_ESCAPE` | POLICY | 否 | 路径解析后越出 workspace |
| `WORKSPACE_UNAVAILABLE` | RESOURCE | 否 | 根目录不存在或不可读 |
| `CONTEXT_BUDGET_INSUFFICIENT` | RESOURCE | 否 | 预算装不下必需内容 |
| `SEARCH_TIMEOUT` | TIMEOUT | 是 | rg 超过 `searchTimeoutMs` |
| `SEARCH_BACKEND_UNAVAILABLE` | DEPENDENCY | 否 | 找不到 rg，且已按 §6.3 降级失败 |
| `ARTIFACT_UNREADABLE` | INTEGRITY | 否 | 观察结果的 Artifact 读取失败或哈希不符 |
| `CONTEXT_INTERNAL` | INTERNAL | 否 | 其他未预期错误 |

---

## 4 预算与模型输入策略

### 4.1 预算划分

`ASSEMBLE` 的 `tokenBudget` 由 Workflow 给出，等于模型上下文上限减去预留的输出空间。默认划分如下，均可配置：

| 段 | 上限 | 说明 |
|---|---|---|
| PREFIX | 不设上限，但会检查 | 指令 + 工具 + 任务 + ORIENT。若超过预算的 35%，记录警告诊断 |
| HISTORY | 剩余部分 | 按 §4.3 管理 |
| STATUS | 400 token | 超出则截断 |

M1 的主力模型上下文为 1M，但**不应该把预算设得很大**：输入越长，费用和延迟越高，模型注意力也越分散。建议 M1 默认 `tokenBudget = 64,000`，通过评测再调整。

### 4.2 稳定前缀

- PREFIX 各项按固定顺序排列：`INSTRUCTIONS → TOOLS → TASK → MEMORY → TREE → MANIFEST → OUTLINE`。
- 所有序列化使用确定性的键顺序和换行符（`\n`），禁止在 PREFIX 中出现时间戳、随机 ID、计数器。
- 每次 ASSEMBLE 输出 `prefixSha256`。**合约测试：同一运行的所有 ASSEMBLE 输出，prefixSha256 必须相同。**

### 4.3 历史观察的截断与压缩

**单条观察截断：** 单条观察超过 `observationMaxTokens`（默认 3,000）时，保留开头 60% 与结尾 40%，中间替换为一行：

```text
…[已截断 N 行。完整内容：artifact art_xxx。需要时用 READ 指定行范围读取]…
```

**窗口：** 最近 `recentStepsFull`（默认 6）步保留完整内容（受单条截断限制）。

**压缩触发：** HISTORY 估算超过其可用预算的 85% 时触发。

**压缩方式（M1 不调用 LLM，完全确定性）：** 从最旧的未压缩步骤开始，**一次压缩一批**（默认 8 步或直到降到 60% 以下），每步替换为一行 `DIGEST`：

| 动作 | DIGEST 格式示例 |
|---|---|
| SEARCH | `#3 SEARCH "applyDiscount" → 7 条命中，涉及 src/cart.ts、src/price.ts、test/cart.test.ts` |
| READ | `#5 READ src/cart.ts L40–120（已读）` |
| ERROR | `#6 READ src/x.ts 失败：FILE_NOT_FOUND` |
| INVALID | `#7 模型输出无法解析，已要求重试` |

**成批压缩的原因：** 每次改写 HISTORY，都会使该位置之后的模型缓存失效。一次压缩一大批，比每轮压缩一点更省钱（§4.4）。

**不可压缩的内容：** 最近一步的观察，以及模型在 NOTE 类观察中记录的“发现”（M1 若未实现 NOTE 可忽略）。

### 4.4 缓存与计量

- ContextEngine 为每次 ASSEMBLE 输出 `prefixTokenCount` 与 `historyTokenCount`（写在诊断里）。
- Kernel 的模型适配器应从 API 返回的 usage 中读取缓存命中 token 数（DeepSeek 返回 `prompt_cache_hit_tokens`），写入 UnitResult 的用量信息，供评测统计缓存命中率。接入时需核对 AI SDK 的具体字段。
- 评测报告中的缓存命中率目标：M1 结束时 ≥ 60%（运行 10 步以上的任务）。

### 4.5 token 估算

M1 使用启发式估算，接口可替换：

```ts
interface TokenEstimator {
  estimate(text: string): number;
}
// M1 默认：ASCII 字符按 4 个字符 ≈ 1 token，CJK 字符按 1 个字符 ≈ 1 token，其余按 2 个字符 ≈ 1 token
```

**校准：** 每次 MODEL 调用后，比较估算值与 API 返回的实际 `prompt_tokens`，把比值写入运行日志。评测报告汇总平均偏差，偏差超过 15% 时调整系数。所有预算判断都乘以安全系数 0.9。

---

## 5 算法细节

### 5.1 快照与 revision

- `repositoryRevision`：沿用 `WorkspaceRef.repositoryRevision`（由 Kernel 在创建 workspace 时确定，通常是 git HEAD 的提交哈希）。
- `snapshotId`：ORIENT 时计算 `sha256(排序后的 [相对路径, 大小, 修改时间] 列表)`，写入本运行的检索台账（§5.5）。之后每个 Pack 都携带同一个 `snapshotId`。
- M1 仓库严格只读，因此一次运行中 snapshotId 不应变化。运行结束时可重新计算一次，若不一致，在诊断中报告 `SNAPSHOT_DRIFT`（由 Workflow 决定如何处理）。

### 5.2 分块

- **命中窗口：** 以命中行为中心，向上取 `contextBefore`（默认 12 行），向下取 `contextAfter`（默认 24 行）。
- **合并：** 同一文件中重叠或间隔少于 5 行的窗口合并为一块。
- **边界对齐（轻量）：** 窗口起点向上扩展到最近的顶层定义行（匹配 §5.3 的定义模式，最多多扩 20 行）；窗口终点在空行处截止。
- **上限：** 单块不超过 `chunkMaxLines`（默认 120 行）；超过则只保留命中行附近的部分。
- **输出格式：** 每行前加行号（`  42│ const x = …`），方便模型引用具体行。

### 5.3 符号定义模式（M1 正则）

以下为示意，`NAME` 位置替换为查询中的标识符：

```text
TS/JS
  ^\s*(export\s+)?(default\s+)?(async\s+)?function\s+NAME\b
  ^\s*(export\s+)?(abstract\s+)?class\s+NAME\b
  ^\s*(export\s+)?(const|let|var)\s+NAME\s*[=:]
  ^\s*(export\s+)?(interface|type|enum)\s+NAME\b
Python
  ^\s*(async\s+)?def\s+NAME\b
  ^\s*class\s+NAME\b
通用方法
  ^\s+(public|private|protected|static|async\s+)*NAME\s*\(
```

`NAME` 必须先做正则转义。SYMBOL 模式下，定义命中的得分高于普通引用命中。

### 5.4 打分（确定性、可解释）

```text
score = 10 × 定义命中（该块含查询标识符的定义）
      +  6 × 精确标识符命中次数（上限 3）
      +  5 × 路径命中（查询词出现在文件路径中）
      +  3 × 测试关联（与已命中实现文件同名的测试文件，或反之）
      +  2 × 词项覆盖率（块内出现的不同查询词数 / 查询词总数）
      −  8 × 已给出过（§5.5）
      −  2 × 文件类型惩罚（锁文件、生成文件、压缩文件、.map 文件）
```

- 权重放在配置中，评测时可以调整，**每次调整都要有对照数据**。
- 同分时按 `path` 字典序，再按 `startLine` 升序，保证结果稳定。
- 单文件占用不超过 SEARCH 预算的 40%；超过后该文件的剩余块降到最后。
- 每个 item 的 `reason` 必须写出得分构成，例如 `def-hit+exact×2+path`。

### 5.5 检索台账与去重

ContextEngine 为每个 `agentRunId` 维护一份**检索台账**（它自己拥有的数据）：

```ts
interface RetrievalLedger {
  agentRunId: string;
  snapshotId: string;
  seen: Map<string, { path: string; startLine: number; endLine: number; firstStep: number }>; // key = contentSha256
  searches: { requestId: string; query: string; mode: string; hitCount: number }[];
}
```

- M1 保存在内存中，同时写入 `.multiagent/runs/<run-id>/context/ledger.json` 以便追溯。进程崩溃后不恢复（M1 不要求）。
- 去重规则：内容哈希相同，或与已给出块的行范围重叠超过 70%，即视为“已给出过”。已给出过的块不重复装入全文，改为一行提示：`（src/cart.ts L40–88 已在第 3 步给出）`。

### 5.6 忽略与安全过滤

1. 遵守 `.gitignore`（rg 默认行为）。
2. 固定排除：`.git`、`node_modules`、`dist`、`build`、`coverage`、`.multiagent`，以及 `*.lock`、`*.min.js`、`*.map`。
3. **敏感文件永不进入 Pack：** `.env*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12`、`credentials*`、`secrets*`。即使模型明确搜索也返回空，并在诊断中记录 `SENSITIVE_FILTERED`。
4. 超过 `maxFileBytes`（默认 256 KB）或含 `\0` 的文件跳过。
5. 所有路径先 `realpath` 再检查是否位于 workspace 根目录下，symlink 与 junction 越界即返回 `WORKSPACE_ESCAPE`。该检查逻辑应与 Kernel 的 `FILE_READ` 共用同一实现（建议抽到一个共享的 platform 工具包；在此之前两处实现必须通过同一套路径安全测试用例）。

### 5.7 状态栏

由 Workflow 提供事实，ContextEngine 只负责渲染，不得自行推断或修改数值：

```ts
interface StatusFacts {
  stepIndex: number;
  maxSteps: number;
  tokensUsed: number;
  tokenLimit: number;
  filesRead: string[];          // 已读文件，ContextEngine 渲染时最多列 15 个
  openQuestions: string[];      // 未确认项
  lastError?: string;
  phase?: string;               // 若采用提案 §5.1 的阶段划分
}
```

渲染示例（位于模型输入最末尾）：

```text
[运行状态] 第 7/24 步 · token 38k/120k · 阶段：定位代码
已读：src/cart.ts, src/price.ts, test/cart.test.ts
未确认：折扣上限是否在配置中定义
上一步错误：无
```

---

## 6 实现结构

### 6.1 目录

```text
packages/context-engine/src/
  index.ts                     导出 LocalContextEngine
  application/
    context-engine.ts          ContextPort 实现：校验 → 按 operation 分派 → 发布 Pack
    orient.ts  search.ts  assemble.ts
  domain/
    budget.ts                  TokenEstimator、预算划分与装箱
    chunking.ts                窗口、合并、边界对齐、行号格式化
    ranking.ts                 打分与排序
    ledger.ts                  检索台账与去重
    compaction.ts              截断与 DIGEST 压缩
    status-bar.ts              状态栏渲染
    symbols.ts                 符号定义正则
    config.ts                  ContextEngineConfig 与默认值
  adapters/
    ripgrep/rg.ts              rg 调用与 --json 解析
    workspace/reader.ts        路径安全、ignore、敏感文件过滤、文件读取
    workspace/snapshot.ts      快照与 snapshotId
  diagnostics.ts               诊断信息结构与写入
```

### 6.2 构造函数

```ts
new LocalContextEngine({
  artifacts: ArtifactStorePort,        // 读取观察结果、写入诊断
  search: SearchBackend,               // 默认 RipgrepBackend，测试时可替换为内存实现
  estimator: TokenEstimator,
  config: Partial<ContextEngineConfig>,
});
```

### 6.3 rg 调用约束

- 使用 `@vscode/ripgrep` 提供的二进制，保证 Windows 与 macOS 行为一致（团队有成员在 Windows 上开发）。
- 必须使用参数数组调用，禁止拼接 shell 字符串。
- 默认参数：`--json --fixed-strings --smart-case --max-count 50 --max-filesize 256K --max-columns 400`，并对每个排除项追加一对参数 `-g`、`!<glob>`（参数数组中不需要引号）。
- 超时 `searchTimeoutMs`（默认 3,000 ms），超时则终止进程并返回 `SEARCH_TIMEOUT`。
- 找不到 rg 时降级为内置的 JS 逐文件扫描，并在诊断中标记 `DEGRADED_SEARCH`。降级后检索仍须通过相同的测试。

### 6.4 配置默认值汇总

| 键 | 默认值 |
|---|---|
| `orientBudget` | 2,500 |
| `searchMaxItems` | 8 |
| `observationMaxTokens` | 3,000 |
| `recentStepsFull` | 6 |
| `compactTriggerRatio` / `compactTargetRatio` | 0.85 / 0.60 |
| `compactBatchSize` | 8 |
| `statusMaxTokens` | 400 |
| `contextBefore` / `contextAfter` / `chunkMaxLines` | 12 / 24 / 120 |
| `perFileShareMax` | 0.4 |
| `maxFileBytes` | 262,144 |
| `searchTimeoutMs` | 3,000 |
| `estimatorSafetyFactor` | 0.9 |

所有开关同时作为评测的对照开关（§7.3）：`orient.enabled`、`orient.outline`、`search.symbol`、`assemble.compaction`、`assemble.statusBar`。

---

## 7 评测

### 7.1 两级评测

| 级别 | 测什么 | 是否调用模型 | 何时运行 |
|---|---|---|---|
| **检索评测** | 给定查询，SEARCH 的前 k 条是否包含期望的文件与行范围 | 否，零成本 | 每次提交（放进 `pnpm run check`） |
| **端到端评测** | 完整运行 F1–F5，报告的结论与引用是否正确 | 是 | 每次合并前；每任务 3 次 |

**检索评测先行**：它不花 token、运行很快，适合频繁调排序权重和分块参数。

### 7.2 fixture 格式

```text
eval/fixtures/f2-discount-boundary/
  repo/                    初始仓库（git 历史内含）
  task.md                  给 Agent 的问题；不得出现答案文件名
  expected.json
```

```json
{
  "sources": [
    { "path": "src/pricing/discount.ts", "lines": [40, 72], "required": true },
    { "path": "test/pricing/discount.test.ts", "required": false }
  ],
  "claims": ["折扣在金额等于阈值时未生效", "比较运算符使用了 > 而不是 >="],
  "retrievalQueries": [
    { "query": "applyDiscount", "mode": "AUTO", "expectTopK": 3, "expectPaths": ["src/pricing/discount.ts"] }
  ],
  "ambiguous": false
}
```

### 7.3 指标

| 指标 | 定义 |
|---|---|
| Recall@k（检索） | 期望路径出现在前 k 条中的查询比例 |
| MRR（检索） | 第一个期望命中位置的倒数，取平均 |
| 来源召回率 | 报告引用覆盖了多少 `required` 来源（行范围重叠即算） |
| 来源准确率 | 报告引用中与期望来源相关的比例 |
| 结论命中数 | `claims` 中被报告正确表达的条数（M1 可人工判定或用关键词匹配，记录判定方式） |
| 成本与效率 | 步数、输入/输出 token、缓存命中率、美元成本、耗时 |
| 稳定性 | 3 次运行的成功率与波动 |

### 7.4 回归集与对照

- 任何失败过的任务移入 `eval/regression/`，永久保留。
- 每个 §6.4 的开关都要有“开/关”两组数据，结果写入 `eval/results/<date>-<commit>.json`。
- 报告中必须写明模型、配置、提交哈希，保证可复现。

---

## 8 测试要求

| 类型 | 用例（最少） |
|---|---|
| schema | 三种 operation 的正例与反例；多余字段被拒绝 |
| 安全 | 绝对路径、`..`、symlink 越界、junction 越界（Windows）、敏感文件、二进制文件、超大文件 |
| 检索 | 路径命中、固定字符串命中、符号定义优先于引用、零结果建议、单文件占比限制、同分稳定排序 |
| 分块 | 窗口合并、边界对齐、单块行数上限、行号格式 |
| 去重 | 相同内容第二次出现时被替换为提示行 |
| 预算 | 总 token 不超预算；必需内容装不下时返回 `CONTEXT_BUDGET_INSUFFICIENT` |
| 组装 | 同一运行多次 ASSEMBLE 的 `prefixSha256` 相同；外部内容不出现在 PREFIX；STATUS 位于末尾 |
| 压缩 | 触发阈值、成批压缩、最近一步不被压缩、DIGEST 格式 |
| 不可变 | 返回的 Pack 为冻结对象 |
| 合约 | 与 FakeContextPort 共用同一套 contract test |
| 降级 | 无 rg 时的 JS 扫描结果与 rg 一致（在 fixture 上） |

---

## 9 实施顺序（对应 M1 四周）

| 周 | 交付 | 完成标志 |
|---|---|---|
| 1 | 合约变更提案并评审；`workspace/reader` 与安全测试；rg 适配器；SEARCH 最小版（TEXT + PATH，整块返回）；F1–F5 fixture 与 `expected.json`；检索评测脚本 | 检索评测可运行并输出 Recall@k |
| 2 | 分块、打分、去重台账；SYMBOL 模式；ORIENT；ASSEMBLE 最小版（PREFIX + 全量 HISTORY + STATUS） | 真实模型能基于 ASSEMBLE 输出完成一次单轮分析 |
| 3 | 单条截断与成批压缩；token 估算校准；诊断信息；端到端评测（3 次运行） | F2、F5 端到端可跑，报告含缓存命中率 |
| 4 | 对照实验（各开关）；调权重；回归集；文档与 `docs/decisions/` 记录 | 形成一份带数据的 ContextEngine 评测报告 |

**降级顺序（工期不足时）：** 先砍 SYMBOL 边界对齐 → 再砍 ORIENT 的符号大纲 → 再砍成批压缩（改为只做单条截断）。**不得砍：** 路径安全、provenance、预算上限、稳定前缀、检索评测。

---

## 10 待决事项（每项写一份 `docs/decisions/` 记录）

| 编号 | 问题 | 建议 |
|---|---|---|
| D1 | 模型动作用原生 tool calling 还是 JSON 结构化输出 | 倾向原生 tool calling：服务商对这种格式做了专门训练，消息结构也更利于缓存；需与 Cary、田园确认 |
| D2 | ASSEMBLE 作为独立 Context Unit 的开销是否可接受 | M1 进程内调用，开销可忽略；保持单一调用线路更重要 |
| D3 | 路径安全逻辑放在哪个共享包 | 新建 platform 工具包，由 Kernel 与 ContextEngine 共用 |
| D4 | 检索台账是否需要持久化以支持恢复 | M1 不需要；M2 引入会话恢复时再定 |
| D5 | token 估算是否引入真实分词器 | 先用启发式加校准；偏差超过 15% 再引入 |
| D6 | 何时引入 tree-sitter 与向量检索 | 检索评测显示 Recall@3 低于 80% 且原因是“语义相关但字面不匹配”时再评估 |
