# 定义格式

> 状态：已评审（阶段 1 的部分）；阶段 2 的部分为草稿（待评审）。约定见 [Interface](README.md)。
> 定义的加载、校验与目录机制见 [Library/AgentToolPool](../Library/AgentToolPool.md)；本文只定义字段。

## 1. 范围与版本

M1 的定义格式见 M1Interface 第 9 节（`DefinitionHeader.schemaVersion = 'v0'`）。M2 中：

- 全部定义种类都发布 `schemaVersion = 'v1'`，新增种类 Template；
- Unit 在阶段 1 就升到 `v1`，因为 `ExecutionKind` 要增加取值（第 5 节），在冻结的 `v0` 中增加枚举值属于破坏性变更；
  阶段 2 增加能力与资源键、阶段 4 增加并发类别，都在 `v1` 草稿期内原地增加；
- Tool、Prompt 的字段不变；
- `planner`、`code-viewer` 及其 Unit 全部改写为 `v1` 定义，与 main 使用同一种格式；Prompt 与 Tool 的内容可以按需调整。M1 的定义文件随 major 0 一起删除。

`DefinitionRef`、`PinnedDefinitionRef`、`ContractRef` 沿用 M1Interface 第 9.1 节；`PinnedDefinitionRef.kind` 在 major 1 中增加 `'TEMPLATE'`。

## 2. Agent（`v1`）

```ts
interface AgentDefinition extends DefinitionHeader<'AGENT'> {   // schemaVersion = 'v1'
  role: string;                                  // ≤200
  modelRef: DefinitionRef;
  thinking: {
    defaultEffort: ThinkingEffort;               // M2Design 第 3.9 节
    allowedEfforts: ThinkingEffort[];            // 包含 defaultEffort
  };
  promptRef: DefinitionRef;
  unitRefs: DefinitionRef[];                     // 封闭集合；阶段 2 起与能力白名单一起决定能力上限
  startUnitRefs: DefinitionRef[];                // ⊆ unitRefs；main 为空：运行开启时不碰仓库
  actions: {
    end: {                                       // 至少一项；没有声明的工具不能结束这个 Agent
      toolRef: DefinitionRef;
      then: 'PUBLISH_REPLY' | 'PUBLISH_REPORT' | 'HANDOFF';   // 阶段 4 增加 'FINISH_SUBAGENT'
      allowedInFinal: boolean;                   // 收尾调用中是否可用
    }[];
    onDegraded: 'PUBLISH_NOTICE' | 'PUBLISH_REPORT';   // 没有合法结束时发布什么
    todos?: { toolRef: DefinitionRef };          // 阶段 2：update_todos（M2Design 第 3.5 节）
    // 阶段 4：spawn（run_subagents）；阶段 5：askUser（ask_user）
  };
  limits: {
    maxRounds: number;                           // 1..100
    maxToolCallsPerRound: number;                // 0..32
    maxToolUnits: number;                        // 1..1000，Kernel 计量（M2Design 第 7.3 节）
    maxWallClockMs?: number;                     // 省略时以 Turn 超时为上限（main）
  };
  budget: AgentBudgetProfile;
  capabilities: string[];                        // 阶段 2：能力白名单，能力上限的来源（M2Design 第 5.1 节）
  // 阶段 4：spawnable、defaultShare、resultContract
}

type ThinkingEffort = 'none' | 'low' | 'high' | 'max';

interface AgentBudgetProfile {                   // M2Design 第 7.3 节"每个 Agent 的额度参数"
  perCallInputLimit: number;
  maxOutputTokens: number;
  finalInputBudget: number;
  finalMaxOutputTokens: number;
}
```

- 收尾保留 `F`、余量 `wrapUpMargin`、最小份额 `minShare` 由这四个参数派生，不在定义中重复书写；启动检查见 [Kernel/Monitor](../Kernel/Monitor.md)。
- `role`、`promptRef`、`unitRefs`、`startUnitRefs` 的含义与 M1 相同；`modelSettings` 由 `thinking` 取代。

## 3. Model（`v1`）

```ts
interface ModelDefinition extends Omit<M1ModelDefinition, 'schemaVersion' | 'features'> {   // schemaVersion = 'v1'；M1ModelDefinition 见归档的 M1Interface
  features: {
    hasJsonOutput: boolean;
    hasToolCalls: boolean;
    hasVision: boolean;
    thinking: ThinkingFeature;
  };
}

interface ThinkingFeature {
  isSupported: boolean;
  effortMapping: { effort: ThinkingEffort; request: ThinkingRequest }[];   // 覆盖全部四档
  replayReasoning: 'REQUIRED' | 'OPTIONAL' | 'UNSUPPORTED';               // 带工具的多轮请求是否必须回传 reasoning_content
  missingReasoningFill: 'EMPTY_STRING' | 'OMIT';                          // 历史轮缺少思考内容时的补法
  reasoningCountsAsOutput: boolean;                                        // 思考 token 是否计入输出用量
}

type ThinkingRequest =
  | { thinking: 'DISABLED' }
  | { thinking: 'ENABLED'; providerEffort?: string };
```

`ThinkingFeature` 各字段的取值来自阶段 0 的实测（[M2TechStack](../M2TechStack.md) 第 3.2 节）。`deepseek-flash` 与 `deepseek-v4-pro` 的取值相同：

| 字段 | 取值 |
|---|---|
| `isSupported` | `true` |
| `effortMapping` | `none` → `{ thinking: 'DISABLED' }`；`low`、`high`、`max` → `{ thinking: 'ENABLED', providerEffort: <同名> }` |
| `replayReasoning` | `'REQUIRED'` |
| `missingReasoningFill` | `'EMPTY_STRING'` |
| `reasoningCountsAsOutput` | `true` |

其余字段（provider、计价、上下文窗口等）与 M1Interface 第 9.2 节相同。

## 4. Template（`v1`，新增）

```ts
interface TemplateDefinition extends DefinitionHeader<'TEMPLATE'> {      // schemaVersion = 'v1'
  origin: 'BUILTIN' | 'REPOSITORY';               // REPOSITORY 在阶段 7 开放
  nodes: TemplateNode[];                           // ≥1
}

type TemplateNode =
  | {
      name: string;                                // 小写 kebab-case，≤64，模板内唯一
      kind: 'AGENT';
      agent: DefinitionRef;                        // 只能引用内置 Agent
      goal?: string;                               // ≤4000
      dependsOn?: TemplateDependency[];
      inputFrom?: 'HANDOFF';                       // analyze：以前驱的交接内容（HandoffBrief）为输入
      output?: boolean;                            // 该节点的结果作为运行结果发布
      // 阶段 7：writeScope、effort、budget、trigger、loop
      // 预留（M2Design 第 14.2 节第 9、10 条）：结构化结果、显式引用祖先节点的结果
    }
  | {
      name: string;
      kind: 'HUMAN';
      // 阶段 7：request（ask、confirm、review）、dependsOn；预留：询问的显式超时与缺省答复（第 14.2 节第 18 条）
    };
  // 预留：kind 以后可能增加取值，例如模板组合（M2Design 第 14.2 节第 17 条）

type TemplateDependency =
  | string                                         // 依赖边
  | { node: string; when: EdgeCondition };         // 条件边；阶段 1 只允许内置模板使用，阶段 7 对使用者模板开放

interface EdgeCondition {                         // 以后可能增加按前驱结束状态的谓词（失败边，M2Design 第 14.2 节第 8 条）
  field: string;                                   // 前驱结构化结果中的字段路径
  equals?: string | boolean;
  in?: (string | boolean)[];                       // equals 与 in 恰好出现一个
}
```

- 根节点 `HUMAN(prompt)`（`mas run` 的目标或 `/run` 的输入）不写在模板中，由 Workflow 在编译时加入，模板中没有前驱的节点都依赖它（M2Design 第 3.8 节）。
- `chat` 是内置的生长规则，写在代码中，不是模板文件（M2Design 第 3.8 节）；因此 `RunStart` 与 `WORKFLOW_RUN_STARTED` 在 `mode = 'CHAT'` 时没有 `templateRef`。
- `analyze` 引用 `v1` 的 planner 与 code-viewer；交接的目标由模板中的 `view` 节点决定（`inputFrom: HANDOFF` 且以条件边依赖 `plan`），`v1` Agent 定义中没有交接目标（[AgentToolPool](../Library/AgentToolPool.md) 第 4 节）。
- 阶段 1 的内置模板只有 `analyze`：

```yaml
schemaVersion: v1
kind: TEMPLATE
id: analyze
version: v1.0.0
description: M1 的只读分析：planner 交接给 code-viewer
origin: BUILTIN
nodes:
  - { name: plan, kind: AGENT, agent: { id: planner, version: v1.1.0 } }
  - { name: view, kind: AGENT, agent: { id: code-viewer, version: v1.1.0 },
      dependsOn: [{ node: plan, when: { field: action, equals: HANDOFF } }],
      inputFrom: HANDOFF, output: true }
```

`analyze` 没有特殊额度，按 Agent 定义中的额度参数运行。

## 5. Unit（`v1`）、Tool、Prompt

```ts
interface UnitDefinition extends Omit<M1UnitDefinition, 'schemaVersion' | 'executionKind'> {   // schemaVersion = 'v1'；M1UnitDefinition 见归档的 M1Interface
  executionKind: ExecutionKind;
  // 能力即 protectedCapabilities（阶段 2 增加 workspace.write）；资源键由 Core 从输入的 path 提取，不写在定义中；阶段 4：concurrencyClass
}

type ExecutionKind = M1ExecutionKind | 'REPOSITORY_LIST' | 'MESSAGE_PUBLISH' | 'OUTPUT_READ' | 'FILE_EDIT';   // 阶段 2；M1 的 FILE_WRITE 开放；阶段 3–6 增加各新工具的类别
```

- `REPOSITORY_LIST`：`list_files` 的 Unit `repository-list`；
- `MESSAGE_PUBLISH`：Kernel 内建 Unit `message-publish`，由 Execution 直接完成，不派发给 Supervisor（与 M1 的 `report-publish` 相同）；
- `OUTPUT_READ`（阶段 2）：`read_output` 的 Unit `output-read`，Executor 在进程内运行（ExecutorSet 第 5a 节）。

工具 Unit 的预览上限使用 Kernel 配置的 `previewMaxBytes` 与 `previewMaxLines`；上限不写在定义中。

其余字段与 M1Interface 第 9.2 节相同。全部 Unit、Tool、Prompt 实例使用 `v1`。
