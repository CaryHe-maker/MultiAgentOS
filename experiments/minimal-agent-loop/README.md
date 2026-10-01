# Minimal Agent Loop Experiment

这个目录实现一条独立于正式 M1 模块的最小双 Agent 闭环，用于验证 MultiAgentOS 的 Agent、Unit、Workflow、Kernel、ContextEngine 与 Executor 边界。

实验支持两条路径：

1. `PlannerAgent` 判断 `hi`、问候或无需工具的简单问题并直接回答；
2. `PlannerAgent` 把 C 仓库审查任务 handoff 给 `CRepositoryReviewAgent`，后者通过受控仓库概览和文件读取完成静态审查。

实验只允许读取本地仓库，不修改文件，不执行命令、编译、测试、Git 或网络工具。模型调用使用 DeepSeek Chat Completions API。

## 内置 C 审查仓库

`fixtures/c-review` 提供一个精确 200 行的多文件 C 测试仓库：

```text
fixtures/c-review/
├── include/parser.h   20 lines
└── src/
    ├── main.c         40 lines
    ├── parser.c       93 lines
    └── util.c         47 lines
```

代码中故意包含多个可以通过静态阅读发现的内存安全、边界、错误处理和资源生命周期问题。仓库中不保存预期答案，避免 Agent 通过读取答案文件完成审查。

## 核心所有权

### Workflow

Workflow 是业务状态的唯一权威，维护：

- `WorkflowState`；
- `AgentRunState`；
- `UnitRunState`；
- 当前 active Agent；
- Planner handoff；
- 仓库概览与文件 Observation；
- Unit 结果对业务流程的含义。

Workflow 创建不可变 `UnitIntent`，但不直接调用 ContextEngine、模型、文件系统或其他 Executor。

### Kernel

Kernel 是物理执行状态的唯一权威，维护每次执行的 `UnitAttempt`：

```text
CREATED
-> ADMISSION_CHECKING
-> ADMITTED
-> RUNNING
-> SUCCEEDED | FAILED | REJECTED
```

Kernel 校验 Agent→Unit 成员关系和输入类型，然后路由到 ContextEngine、ModelExecutor 或 FileReadExecutor。Workflow 不复制这些中间状态，只等待带有 `unitIntentId` 和 `unitAttemptId` 的终态 `UnitCompletion`。

当前实验中一次 `UnitRun` 只有一次 `UnitAttempt`。协议保留 `attemptNumber`，以后可以在 Kernel 中增加 Lease、Permit、fencing、Executor 选择和安全的执行级重试，而不改变 Workflow 的 Agent 编排模型。

## 双层状态机

### Agent/Workflow 层

```text
PlannerAgent READY
-> RUNNING
-> WAITING_UNIT
-> APPLYING_RESULT
-> FINAL answer
   or HANDOFF

CRepositoryReviewAgent WAITING_ACTIVATION
-> READY
-> RUNNING
-> WAITING_UNIT <-> APPLYING_RESULT
-> RESULT_SUBMITTED
```

ReviewAgent 在运行开始时已经存在，但处于 `WAITING_ACTIVATION`。Planner 只能提出结构化 `HANDOFF`；Workflow 校验目标属于 Planner 的 `allowedHandoffRefs` 后，才原子地完成 Planner 并激活 ReviewAgent。

### Unit 执行层

```text
Workflow UnitRun: WAITING_EXECUTION
        |
        | UnitIntent
        v
Kernel UnitAttempt:
CREATED -> ADMISSION_CHECKING -> ADMITTED -> RUNNING -> terminal
        |
        | UnitCompletion
        v
Workflow UnitRun: EVALUATING_RESULT -> SUCCEEDED | FAILED
```

Workflow 与 Kernel 不维护两份相同的 Unit 状态。`UnitRun` 表达逻辑动作是否满足业务流程，`UnitAttempt` 表达一次物理执行发生了什么。

## Agent

### PlannerAgent

职责：

- 根据用户目标和可用 Agent Catalog 选择直接回答或专业 Agent；
- 简单问题返回 `FINAL`；
- C 仓库审查返回指向 `CRepositoryReviewAgent` 的 `HANDOFF`；
- 不执行专业 Agent 的工作；
- 不得选择 `allowedHandoffRefs` 以外的 Agent。

允许的共享 Unit：

```text
ContextBuildUnit
ModelCallUnit
ReturnResultUnit
```

### CRepositoryReviewAgent

职责：

- 接受 Planner 的 `CODE_REVIEW` handoff；
- 先取得事实性的仓库概览；
- 根据 ContextPack 请求必要的文件范围；
- 至少取得一条 FileRead Observation 后才能提交 FINAL；
- 只报告由已读文件和行范围支持的问题；
- 返回只读静态审查报告。

允许的共享 Unit：

```text
RepositoryViewUnit
ContextBuildUnit
ModelCallUnit
FileReadUnit
ReturnResultUnit
```

Unit 是平台级通用定义，不为 Planner 或 ReviewAgent 创建专属 Unit。Agent 的差异来自固定的 Prompt、允许 Unit 集合、允许 handoff 集合和输出协议。

## ContextEngine 与文件访问

ContextEngine 只组织已经存在的信息，不访问代码仓库，也不调用模型。它把以下内容组装成不可变 `ContextPack`：

- 固定版本的 Agent Prompt；
- 用户目标；
- 可用 Agent Catalog；
- Planner handoff；
- RepositoryRef 和仓库概览；
- FileRead Observation；
- 剩余模型与文件读取预算。

仓库访问全部经过 Kernel：

```text
Workflow -> UnitIntent -> Kernel -> FileReadExecutor
```

`FileReadExecutor.view()` 生成事实性的 `.c/.h` 文件清单、大小和行数；`FileReadExecutor.read()` 读取带行号的受限源码范围。Executor 不判断文件重要性、不分析代码，也不构建 Prompt。

每次模型调用前都必须先完成一次 ContextBuild：

```text
FILE_READ -> CONTEXT_BUILD -> MODEL_CALL
```

Workflow 不允许绕过 ContextEngine，把新的文件结果直接发送给模型。

## 完整调用路径

### 简单问题

```text
UserRequest("hi")
-> Kernel
-> Workflow starts PlannerAgent
-> ContextBuildUnit
-> Kernel -> ContextEngine
-> ModelCallUnit
-> Kernel -> ModelExecutor
-> Planner FINAL
-> ReturnResultUnit
-> UserResponse
```

这条路径不会激活 ReviewAgent，也不会访问文件系统。

### C 仓库审查

```text
UserRequest(prompt, repository)
-> Planner ContextBuild
-> Planner ModelCall
-> Planner HANDOFF(CRepositoryReviewAgent)
-> Workflow validates and activates ReviewAgent
-> RepositoryViewUnit
-> Kernel -> FileReadExecutor.view
-> Review ContextBuild
-> Review ModelCall
-> FileReadUnit
-> Kernel -> FileReadExecutor.read
-> Review ContextBuild
-> Review ModelCall
-> ...
-> Review FINAL
-> Workflow validates citations against observations
-> ReturnResultUnit
-> UserResponse
```

## 文件访问边界

- 模型只能提供相对 `path` 和可选 `startLine/endLine`；
- RepositoryRef 由 Workflow 从运行输入绑定，模型不能指定仓库根目录或 revision；
- 拒绝绝对路径、空路径和 `..`；
- 拒绝 symlink/junction 和非普通文件；
- `realpath` 后必须仍位于仓库根目录；
- 单次读取最多 120 行、64 KiB；
- 仓库概览最多 200 个匹配文件；
- 返回内容包含 path、revision、实际行范围、总行数和 `truncated`。

## 使用

设置 API Key：

```powershell
$env:DEEPSEEK_API_KEY = '你的 DeepSeek API Key'
```

简单问题：

```ts
import { runPrompt } from '@multiagentos/minimal-agent-loop-experiment';

const answer = await runPrompt('hi');
console.log(answer);
```

C 仓库审查：

```ts
import { createExperimentRuntime } from '@multiagentos/minimal-agent-loop-experiment';

const runtime = createExperimentRuntime();
const result = await runtime.kernel.run({
  prompt: '检查这个 C 仓库中可能导致崩溃、内存错误或错误结果的问题。',
  repository: {
    rootPath: './experiments/minimal-agent-loop/fixtures/c-review',
    revision: 'fixture-c-review-v1',
  },
});

if (result.ok) console.log(result.value.answer);
else console.error(result.error.code, result.error.message);
```

## 配置

- `DEEPSEEK_API_KEY`：必填；
- `MINIMAL_AGENT_LOOP_DEBUG_MODEL=1`：把每次模型调用的原始响应和 assistant content 输出到标准错误；默认关闭；
- API 地址：`https://api.deepseek.com/chat/completions`；
- 模型：`deepseek-flash`，显式关闭思考模式（`thinking: disabled`）；
- 动作协议：原生工具调用（`tools` / `tool_calls`，`tool_choice: auto`）。工具定义在 AgentToolPool 中按 Agent 配置：Planner 只有 `handoff`，ReviewAgent 有 `file_read` 和 `submit_review`；不调用工具的纯文本回复视为 FINAL。ReviewAgent 一次回复中的多个 `file_read` 按顺序排队执行，全部完成后才构建下一次上下文；
- 默认超时：120 秒；
- 最大 Workflow Unit 步数：64；
- Planner 最大模型调用：2；
- ReviewAgent 最大模型调用：12；
- ReviewAgent 最大文件读取：16。

`createExperimentRuntime` 和 `runPrompt` 允许注入 `fetch`、`apiKey`、`timeoutMs`、`debugModelResponses` 和 `modelResponseLogger`，用于测试、诊断或进程内配置。调试输出可能包含模型生成的代码分析结果，不应在包含敏感仓库内容的共享终端或日志系统中长期启用。

## 当前边界与后续升级

当前实现是进程内、同步、单线依赖：

```text
PlannerAgent -> CRepositoryReviewAgent
```

当前不实现持久化、Lease、Permit、fencing、自动 retry、并行 Agent、TaskGraph 或人工审核。长期升级时：

- Workflow 继续拥有 WorkflowRun、AgentRun 和 UnitRun；
- Kernel 继续拥有 UnitAttempt、准入、Lease、Permit 和执行级重试；
- 审核授权应独立为可限定重用范围的 ApprovalGrant；
- 每个物理 Attempt 使用独立 Lease 和 fencing token；
- Planner 的单个 handoff 可以扩展为多个 Agent 节点和依赖关系，而无需改变 Unit 执行协议。
