# MultiAgentOS M1 AgentToolPool

## 1. 定位与范围

AgentToolPool 是静态库 `@multiagentos/agent-tool-pool`（`packages/libraries/agent-tool-pool`），提供 Agent、Unit、Tool、
Model、Prompt 五类定义的目录。长期规划见 [AgentToolPool 架构](../../Architecture/Library/AgentToolPool.md)。

本文规定 M1 目录的机制、校验规则与全部定义实例。定义的字段以 [M1Interface](../M1Interface.md) 第 9 节为准，
对应 Schema 见 [SharedContracts](SharedContracts.md) 3.5。

M1 实现：定义 Schema、从仓库文件加载并校验、精确查找、运行开始时固定版本、fake 与 contract test。
M1 不实现：独立服务、热更新、运行时发布、权限管理和版本范围查询。

## 2. 关键决策

| 决策 | 理由 |
|---|---|
| 定义类型为 `AGENT`、`UNIT`、`TOOL`、`MODEL`、`PROMPT`，不做 `EXECUTOR` 和 `CONTRACT` | Executor 由 Unit 的 `executionKind` 指向，Supervisor 按它找到实现；Contract 由 `ContractRef` 指向 Protocol Registry 中的 Schema |
| Agent 只引用 Unit 和控制工具，Unit 才引用面向模型的工具 | Kernel 可以只凭固定集合核对 Agent → Unit 的成员关系 |
| 工具分两类：`purpose = UNIT` 映射到一个 Unit；`purpose = CONTROL` 表达 FINISH 或 HANDOFF | 模型的全部动作都经工具调用表达，Workflow 按工具的 purpose 解释动作 |
| 工具参数用 `parametersContract` 指向已注册 Schema；UNIT 工具的参数就是所属 Unit 的输入 | 参数结构只有一份来源，模型参数可以原样成为 Unit 输入 |
| HANDOFF 的交接内容由 `handoff-to-code-viewer` 工具的参数 Schema（`workflow.HandoffBrief`）定义 | 交接内容由定义确定，Workflow 只校验并传递 |
| 失败处理写在 Unit 定义的 `failurePolicy` 中，未列出的原因码按 `FATAL` 处理 | 哪些错误交还模型、哪些终止运行由可信定义决定，并受 digest 覆盖 |
| Round 上限写在 Agent 定义的 `limits` 中，执行截止时间与输出上限不写在定义中 | Round 由 Workflow 判断；执行限制由 Kernel 配置统一管理（见 [Kernel/Monitor](../Kernel/Monitor.md) 4） |
| digest 覆盖引用目标的 digest（Merkle），包括 `actions` 中的工具与交接目标 | 一个 Agent 的 digest 确定其全部闭包，以及交接目标的确切版本 |
| `v0.x` 是草稿，直接修改；`v1.0.0` 起封存且不可修改 | M1 阶段提示词与工具会频繁调整；可复现性由运行记录中的 digest 与 git 历史保证 |
| 已发布版本只能引用已发布版本 | 否则已发布定义的内容会随草稿变化 |
| Agent 必须显式声明 `modelSettings.thinking` | DeepSeek 默认开启思考模式，会增加计费输出与延迟 |
| 状态（DEPRECATED、QUARANTINED、REVOKED）放在单独的 `status.yaml` | 状态是已发布定义唯一允许变化的部分，不参与 digest |
| 价格使用整数“微美元 / 百万 token” | digest 不依赖浮点格式 |
| 查找结果和固定集合全部深冻结，类型为 `DeepReadonly` | 满足发布值不可变的要求（[SharedContracts](SharedContracts.md) 第 2 节、M1Interface 1.3） |
| YAML 使用 1.2 core schema | `no`、`on`、日期等保持字符串，值的类型和 digest 不因写法改变 |

## 3. 定义文件

```text
packages/libraries/agent-tool-pool/definitions/
  agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
  models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

- 路径必须与文件内的 `kind`、`id`、`version` 一致。符号链接、BOM、重复 YAML 键和超过 1 MiB 的文件都会被拒绝。
- 修改草稿（`v0.x`）：直接编辑文件，运行 `pnpm run check`。草稿文件不能写 `digest`，digest 在启动时计算。
- 发布（`v1.0.0` 起）：在新版本路径创建文件，不写 `digest`，运行 `pnpm run catalog:seal`。已封存的文件不能再改，只能发布新版本。
- `status.yaml` 的格式为 `catalog.DefinitionStatusFile.v0`：`entries[]` 每项含 `kind`、`id`、`version`、
  `status`（`ACTIVE`、`DEPRECATED`、`QUARANTINED`、`REVOKED`）与 `reason`。未列出的版本为 ACTIVE；
  QUARANTINED、REVOKED 的版本不能查找，也不能出现在被固定的闭包中。

## 4. M1 定义实例

M1 目录恰好包含以下 16 个定义文件和 `status.yaml`（`entries: []`）。所有草稿的 `schemaVersion` 为 `v0`。

| kind | id | version | 状态 |
|---|---|---|---|
| AGENT | `planner` | `v0.1.0` | 草稿 |
| AGENT | `code-viewer` | `v0.1.0` | 草稿 |
| UNIT | `repository-orient` | `v0.1.0` | 草稿 |
| UNIT | `repository-search` | `v0.1.0` | 草稿 |
| UNIT | `file-read` | `v0.1.0` | 草稿 |
| UNIT | `context-assemble` | `v0.1.0` | 草稿 |
| UNIT | `model-call` | `v0.1.0` | 草稿 |
| UNIT | `report-publish` | `v0.1.0` | 草稿 |
| TOOL | `search-repository` | `v0.1.0` | 草稿 |
| TOOL | `read-file` | `v0.1.0` | 草稿 |
| TOOL | `finish-analysis` | `v0.1.0` | 草稿 |
| TOOL | `handoff-to-code-viewer` | `v0.1.0` | 草稿 |
| MODEL | `deepseek-flash` | `v1.0.0` | 已封存 |
| MODEL | `deepseek-v4-pro` | `v1.0.0` | 已封存 |
| PROMPT | `planner-system` | `v0.1.0` | 草稿 |
| PROMPT | `code-viewer-system` | `v0.1.0` | 草稿 |

运行的入口 Agent 由 Workflow 配置 `entryAgentRef = { id: planner, version: v0.1.0 }` 指定（见 [Workflow](../Module/Workflow.md) 12）。

### 4.1 Agent

```yaml
# agents/planner/v0.1.0.yaml
schemaVersion: v0
kind: AGENT
id: planner
version: v0.1.0
description: Plans the repository analysis and hands it to the code viewer; never reads the repository.
role: analysis planner
modelRef: { id: deepseek-flash, version: v1.0.0 }
modelSettings: { thinking: DISABLED }
promptRef: { id: planner-system, version: v0.1.0 }
unitRefs:
  - { id: context-assemble, version: v0.1.0 }
  - { id: model-call, version: v0.1.0 }
  - { id: report-publish, version: v0.1.0 }
startUnitRefs: []
actions:
  finish: { toolRef: { id: finish-analysis, version: v0.1.0 } }
  handoff:
    toolRef: { id: handoff-to-code-viewer, version: v0.1.0 }
    targetAgentRef: { id: code-viewer, version: v0.1.0 }
limits: { maxRounds: 3, maxToolCallsPerRound: 0 }
```

```yaml
# agents/code-viewer/v0.1.0.yaml
schemaVersion: v0
kind: AGENT
id: code-viewer
version: v0.1.0
description: Reads the repository through orient, search and read units and writes the analysis report.
role: read-only code analyst
modelRef: { id: deepseek-flash, version: v1.0.0 }
modelSettings: { thinking: DISABLED }
promptRef: { id: code-viewer-system, version: v0.1.0 }
unitRefs:
  - { id: repository-orient, version: v0.1.0 }
  - { id: repository-search, version: v0.1.0 }
  - { id: file-read, version: v0.1.0 }
  - { id: context-assemble, version: v0.1.0 }
  - { id: model-call, version: v0.1.0 }
  - { id: report-publish, version: v0.1.0 }
startUnitRefs:
  - { id: repository-orient, version: v0.1.0 }
actions:
  finish: { toolRef: { id: finish-analysis, version: v0.1.0 } }
limits: { maxRounds: 20, maxToolCallsPerRound: 8 }
```

`maxRounds` 与 `maxToolCallsPerRound` 为建议初值，需要用固定任务集校准。

### 4.2 Unit

```yaml
# units/repository-orient/v0.1.0.yaml
schemaVersion: v0
kind: UNIT
id: repository-orient
version: v0.1.0
description: Snapshot the repository and build an ORIENT ContextPack.
executionKind: REPOSITORY_ORIENT
protectedCapabilities: [repo.read]
inputContract: { kind: contract, id: context.RepositoryOrientInput, version: v0 }
outputContract: { kind: contract, id: context.RepositoryOrientOutput, version: v0 }
toolRefs: []
effect: READ_ONLY
isIdempotent: true
failurePolicy:
  USER_DECLINED: FINAL_CALL
```

```yaml
# units/repository-search/v0.1.0.yaml
schemaVersion: v0
kind: UNIT
id: repository-search
version: v0.1.0
description: Search the repository snapshot and build a SEARCH ContextPack.
executionKind: REPOSITORY_SEARCH
protectedCapabilities: [repo.read]
inputContract: { kind: contract, id: context.RepositorySearchInput, version: v0 }
outputContract: { kind: contract, id: context.RepositorySearchOutput, version: v0 }
toolRefs:
  - { id: search-repository, version: v0.1.0 }
effect: READ_ONLY
isIdempotent: true
failurePolicy:
  USER_DECLINED: FINAL_CALL
  OUT_OF_SCOPE: RETURN_TO_MODEL
  INVALID_QUERY: RETURN_TO_MODEL
  LIMIT_EXCEEDED: RETURN_TO_MODEL
  UNIT_TIMEOUT: RETURN_TO_MODEL
```

```yaml
# units/file-read/v0.1.0.yaml
schemaVersion: v0
kind: UNIT
id: file-read
version: v0.1.0
description: Read a line range of one repository file.
executionKind: FILE_READ
protectedCapabilities: [repo.read]
inputContract: { kind: contract, id: executor.FileReadInput, version: v0 }
outputContract: { kind: contract, id: executor.FileReadOutput, version: v0 }
toolRefs:
  - { id: read-file, version: v0.1.0 }
effect: READ_ONLY
isIdempotent: true
failurePolicy:
  USER_DECLINED: FINAL_CALL
  OUT_OF_SCOPE: RETURN_TO_MODEL
  NOT_FOUND: RETURN_TO_MODEL
  UNSUPPORTED_FILE: RETURN_TO_MODEL
  INVALID_RANGE: RETURN_TO_MODEL
  LIMIT_EXCEEDED: RETURN_TO_MODEL
  UNIT_TIMEOUT: RETURN_TO_MODEL
```

```yaml
# units/context-assemble/v0.1.0.yaml
schemaVersion: v0
kind: UNIT
id: context-assemble
version: v0.1.0
description: Assemble the model input from instructions, tools, objective and the AgentRun history.
executionKind: CONTEXT_ASSEMBLE
protectedCapabilities: []
inputContract: { kind: contract, id: context.ContextAssembleInput, version: v0 }
outputContract: { kind: contract, id: context.ContextAssembleOutput, version: v0 }
toolRefs: []
effect: READ_ONLY
isIdempotent: true
failurePolicy: {}
```

```yaml
# units/model-call/v0.1.0.yaml
# The model receives data but changes no state, so the effect is READ_ONLY.
# Repeating a call can give a different answer, so it is not idempotent.
schemaVersion: v0
kind: UNIT
id: model-call
version: v0.1.0
description: One call to the pinned model with an assembled ContextPack.
executionKind: MODEL
protectedCapabilities: []
inputContract: { kind: contract, id: executor.ModelCallInput, version: v0 }
outputContract: { kind: contract, id: executor.ModelCallOutput, version: v0 }
toolRefs: []
effect: READ_ONLY
isIdempotent: false
failurePolicy:
  BUDGET_WRAP_UP: FINAL_CALL
  BUDGET_EXHAUSTED: DEGRADED_REPORT
  PROVIDER_ERROR: RETURN_TO_MODEL
  UNIT_TIMEOUT: RETURN_TO_MODEL
```

```yaml
# units/report-publish/v0.1.0.yaml
schemaVersion: v0
kind: UNIT
id: report-publish
version: v0.1.0
description: Publish the verified AnalysisReport as an artifact; executed by Kernel Execution itself.
executionKind: REPORT_PUBLISH
protectedCapabilities: []
inputContract: { kind: contract, id: kernel.unit.ReportPublishInput, version: v0 }
outputContract: { kind: contract, id: kernel.unit.ReportPublishOutput, version: v0 }
toolRefs: []
effect: READ_ONLY
isIdempotent: true
failurePolicy: {}
```

未在 `failurePolicy` 中列出的原因码按 `FATAL` 处理。例如 model-call 的 `PROVIDER_UNREACHABLE`、`PROVIDER_AUTH`、
`PROVIDER_RATE_LIMITED`（技术重试已用尽）、`FINAL_CALL_USED`、`INVALID_ARTIFACT_REF`，
以及 context-assemble、report-publish 的任何失败，都使 Workflow 以 `closeRun(FAILED)` 结束运行。
final-call 的 model-call 例外：无论原因码，Workflow 都生成降级报告（[Workflow](../Module/Workflow.md) 7.2）。
处理值的含义见 [Workflow](../Module/Workflow.md) 第 7 节。

### 4.3 Tool

```yaml
# tools/search-repository/v0.1.0.yaml
schemaVersion: v0
kind: TOOL
id: search-repository
version: v0.1.0
description: Model-facing repository search, served by the repository-search unit.
purpose: UNIT
modelName: search_repository
modelDescription: Search the repository by text, path or symbol and return matching line ranges.
parametersContract: { kind: contract, id: context.RepositorySearchInput, version: v0 }
riskClass: READ_ONLY
sideEffect: NONE
isIdempotent: true
contentStatus: PLACEHOLDER
```

```yaml
# tools/read-file/v0.1.0.yaml
schemaVersion: v0
kind: TOOL
id: read-file
version: v0.1.0
description: Model-facing file read, served by the file-read unit.
purpose: UNIT
modelName: read_file
modelDescription: Read up to 400 lines from one file in the repository.
parametersContract: { kind: contract, id: executor.FileReadInput, version: v0 }
riskClass: READ_ONLY
sideEffect: NONE
isIdempotent: true
contentStatus: PLACEHOLDER
```

```yaml
# tools/finish-analysis/v0.1.0.yaml
schemaVersion: v0
kind: TOOL
id: finish-analysis
version: v0.1.0
description: Control tool that ends the AgentRun with a report draft.
purpose: CONTROL
modelName: finish_analysis
modelDescription: Finish the analysis and submit the report. Cite the path and line range of content you have read for every conclusion.
parametersContract: { kind: contract, id: workflow.AnalysisReportDraft, version: v0 }
riskClass: READ_ONLY
sideEffect: NONE
isIdempotent: true
contentStatus: PLACEHOLDER
```

```yaml
# tools/handoff-to-code-viewer/v0.1.0.yaml
schemaVersion: v0
kind: TOOL
id: handoff-to-code-viewer
version: v0.1.0
description: Control tool that hands the analysis task from the planner to the code viewer.
purpose: CONTROL
modelName: handoff_to_code_viewer
modelDescription: Hand the analysis task to the code viewer, which can search and read the repository.
parametersContract: { kind: contract, id: workflow.HandoffBrief, version: v0 }
riskClass: READ_ONLY
sideEffect: NONE
isIdempotent: true
contentStatus: PLACEHOLDER
```

### 4.4 Prompt

```yaml
# prompts/planner-system/v0.1.0.yaml
schemaVersion: v0
kind: PROMPT
id: planner-system
version: v0.1.0
description: System prompt of the planner.
role: system
template: |
  PLACEHOLDER PLANNER PROMPT.
  Decide whether the question needs the repository. If it does, call handoff_to_code_viewer
  with a precise task. If it does not, call finish_analysis.
variables: []
contentStatus: PLACEHOLDER
```

```yaml
# prompts/code-viewer-system/v0.1.0.yaml
schemaVersion: v0
kind: PROMPT
id: code-viewer-system
version: v0.1.0
description: System prompt of the code viewer.
role: system
template: |
  PLACEHOLDER CODE VIEWER PROMPT.
  Answer only from content you have read with read_file, and cite path and line range for every
  conclusion. Call finish_analysis when you are done.
variables: []
contentStatus: PLACEHOLDER
```

Prompt 正文是每次 model-call 的缓存前缀，不得包含时间戳、计数器或其他随运行变化的值。

### 4.5 Model

`deepseek-flash` 与 `deepseek-v4-pro` 两个文件保持现状（已封存），字段见 M1Interface 9.2。
两个 Agent 都使用 `deepseek-flash`；评测时可以发布新的 Agent 版本改用 `deepseek-v4-pro`。

## 5. 加载校验

`DefinitionCatalog.load(source)` 一次收集全部问题再失败（`CatalogLoadError.issues`），任何问题都阻止启动。

| 对象 | 规则 |
|---|---|
| 文件 | 路径与 `kind`、`id`、`version` 一致；无符号链接、BOM、重复键；不超过 1 MiB |
| Schema | 草稿符合去掉 `digest` 的 Schema，且不写 `digest`；已发布版本必须已封存，digest 与内容一致 |
| 引用 | 所有 `DefinitionRef` 可解析且 kind 正确（`modelRef` → MODEL，`promptRef` → PROMPT，`unitRefs` → UNIT，`toolRef`、`toolRefs` → TOOL，`targetAgentRef` → AGENT）；已发布版本只引用已发布版本 |
| ContractRef | 已在 Protocol Registry 中注册 |
| Agent | `startUnitRefs` ⊆ `unitRefs`，且 M1 中只能是 executionKind 为 `REPOSITORY_ORIENT` 的 Unit；`unitRefs` 中 executionKind 为 `CONTEXT_ASSEMBLE`、`MODEL`、`REPORT_PUBLISH` 的 Unit 各恰好一个 |
| Agent | `actions.finish.toolRef` 指向 `purpose = CONTROL` 且 `parametersContract = workflow.AnalysisReportDraft` 的工具 |
| Agent | `actions.handoff` 存在时：工具为 `purpose = CONTROL` 且 `parametersContract = workflow.HandoffBrief`；`targetAgentRef` 不是自身，目标 Agent 不再声明 `handoff` |
| Agent | `maxToolCallsPerRound > 0` 时至少一个 Unit 带工具；闭包内全部工具（Unit 工具与控制工具）的 `modelName` 不重复 |
| Agent | `modelSettings.thinking` 为 ENABLED 时模型必须支持思考，且 `thinkingEffort` 必填并属于 `effortLevels`；DISABLED 时不写 `thinkingEffort` |
| Unit | `inputContract`、`outputContract` 与 executionKind 的对应关系符合 M1Interface 6.1；`FILE_WRITE`、`COMMAND`、`TEST` 不检查对应关系 |
| Unit | executionKind 为 `REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` 时必须声明 `repo.read`；其他 kind 不得声明受保护能力 |
| Unit | `toolRefs` 至多一个，指向 `purpose = UNIT` 的工具，且该工具的 `parametersContract` 等于 Unit 的 `inputContract` |
| Unit | `effect = READ_ONLY` 时其工具的 `sideEffect` 必须为 NONE |
| Unit | `failurePolicy` 的键只能是出现在 UnitReport 中的原因码（M1Interface 3.4），值属于 `FailureHandling`；`FINAL_CALL` 只能用于 `USER_DECLINED`、`BUDGET_WRAP_UP`，`DEGRADED_REPORT` 只能用于 `BUDGET_EXHAUSTED` |
| Tool | `purpose = UNIT` 的工具恰好被一个 Unit 引用；`purpose = CONTROL` 的工具不得被 Unit 引用 |
| Prompt | `variables` 与模板中的 `{{slot}}` 一致（M1 的 Prompt 均为空） |
| status.yaml | 符合 `catalog.DefinitionStatusFile.v0`；列出的版本存在 |

组合根在目录加载后另做跨配置校验：从 `entryAgentRef` 出发可达的全部 Agent 的模型 `provider` 等于
`KernelConfig.provider`；额度配置能够容纳各 Agent 的 Prompt 与工具说明（见 [Kernel/Monitor](../Kernel/Monitor.md) 4）。

## 6. 查找与运行固定

- `getDefinition({ kind, id, version })` 只做精确匹配，返回类型随 kind 变化。
- `pinAgent({ id, version })` 返回 `PinnedDefinitionSet`：Agent、Model、Prompt、全部 Unit、
  全部工具（Unit 工具与 `actions` 中的控制工具），存在交接时还有 `handoffTargetRef`（目标 Agent 的完整引用，含 digest），
  以及排序后的 `refs`。闭包中任一成员为 QUARANTINED 或 REVOKED 时整个 Agent 不能固定。交接目标的内容不在集合中，由使用方另行固定。

| 使用方 | 时机 | 做法 |
|---|---|---|
| Workflow | 收到 RunStart 后 | 固定 `entryAgentRef`（planner）；存在 `handoffTargetRef` 时再固定目标（code-viewer），digest 必须与 `handoffTargetRef` 相同，否则 `closeRun(FAILED, PIN_FAILED)`。此后只读这两个集合，不再查找 |
| Core | 处理 `registerAgentRun` 时 | 以 `agentRef` 的 `id`、`version` 调用 `pinAgent`，digest 与 `agentRef.digest` 不同返回 `DEFINITION_MISMATCH`，目录报错返回 `DEFINITION_UNAVAILABLE`；集合保存在该 AgentRun 的登记中 |
| Execution | 建立 UnitAttempt 时 | 从 Core 传入的定义取得 Prompt 正文、工具说明（经 Protocol Registry 把 `parametersContract` 转为 JSON Schema）与模型目标 |

Workflow 读取 `limits`、`startUnitRefs`、`actions`、工具的 `purpose` 与各 Unit 的 `failurePolicy`；Kernel 不解释这些业务字段，
只按集合核对 Unit 成员关系、受保护能力与输入 Schema。

`CatalogPort` 的错误码见 `CATALOG_ERROR_CODES`；调用方只能按 code 分支，不能解析 message。

## 7. 模型数据

`deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）按 2026-09-28 的
[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)填写。非高峰价格（美元 / 百万 token）如下；
高峰价格为非高峰的 200%，高峰时段为 UTC 周一至周五 01:00–04:00 和 06:00–10:00。

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---:|---:|---:|
| deepseek-flash | 0.003 | 0.15 | 0.60 |
| deepseek-v4-pro | 0.022 | 0.66 | 1.98 |

- DeepSeek 在中国法定节假日按非高峰计费，M1 没有节假日日历，因此按规则算出的节假日成本是上限。
- 两个模型都支持思考模式，默认开启，档位为 low、high、max。M1 Agent 设置为 `thinking: DISABLED`；评测时如果开启，必须记录档位。
- `deepseek-flash` 是服务端别名。DeepSeek 更换背后的模型时，应发布新的 ModelDefinition 版本，并更新 `providerModelLabel`。

## 8. 测试

| 位置 | 覆盖内容 |
|---|---|
| `contracts/src/catalog/definition-schemas.test.ts` | 合法值、额外字段、版本/ID/digest 格式、整数价格、草稿 Schema、`failurePolicy` 键与值 |
| `contracts/src/platform-common/canonical-json.test.ts` | 规范化 JSON，含属性测试 |
| `agent-tool-pool/src/domain/*.test.ts` | digest（含 `actions`）、草稿与发布规则、第 5 节各规则的反例（`definition-rules.test.ts`）、查找错误、状态阻断、固定集合的组成 |
| `agent-tool-pool/src/adapters/file/*.test.ts` | 目录布局、YAML/JSON、封存写回保留注释、并发修改保护 |
| `agent-tool-pool/src/definitions-directory.test.ts` | 仓库内定义恰好是第 4 节的文件且全部有效；已发布版本都已封存；DeepSeek 价格 |
| `testing/src/harnesses/catalog-port-contract.test.ts` | 同一套 contract 分别运行真实实现和 `FakeCatalogPort`，并检查两者一致 |

## 9. 遗留事项

| 事项 | Owner |
|---|---|
| 两个 Prompt 正文与四个 Tool 的 `modelDescription` 为占位（`contentStatus: PLACEHOLDER`），在固定任务集评测前定稿 | Cary 与 meti |
| 尚未提供按时间计算高峰价格和成本的函数 | meti（评测） |
