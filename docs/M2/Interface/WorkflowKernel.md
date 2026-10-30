# Workflow 与 Kernel 的接口

> 状态：草稿（阶段 1 的部分）。约定见 [Interface](README.md)。语义以 [M2Design](../M2Design.md) 为准，本文只定义字段。
> 标"阶段 N"的条目在该阶段的文档门中补全；major 1 冻结之前可以原地增加字段。

## 1. 范围

本文定义 `WorkflowGatewayPort`（Workflow 调用 Kernel）与发往 `inbox.workflow` 的事件（Kernel 通知 Workflow）。
Workflow 只持有 `WorkflowGatewayPort`；Gateway 以 `Envelope.producer = 'workflow'` 判定身份（M1Interface 第 2.1 节第 4 条）。

| 方向 | 内容 | 阶段 |
|---|---|---|
| Workflow → Kernel | AgentRun 登记与结束、Unit 提交、运行结束报告、人类请求、读取项目文件、Session 命令的回复 | 1 |
| Workflow → Kernel | 委派保留与返还 | 4 |
| Kernel → Workflow，Session 级 | 打开、新建、关闭、删除 Session，Session 列表查询 | 1 |
| Kernel → Workflow，运行级 | 运行开始、Unit 结果、人类答复、Turn 结束、运行结束 | 1 |
| Kernel → Workflow，运行级 | 工作区回退与差异 | 2 |
| Kernel → Workflow，运行级 | 暂停、继续、中止、人类请求取消 | 5 |

## 2. Workflow → Kernel

### 2.1 端口

```ts
interface WorkflowGatewayPort {
  registerAgentRun(request: RegisterAgentRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  submitUnit(request: SubmitUnitRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  endAgentRun(request: EndAgentRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  closeRun(request: CloseRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  requestHuman(request: RequestHumanRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  readProjectFile(request: ReadProjectFileRequest, context: BoundaryContext): Promise<ProjectFileContent | SyscallRejected>;
  reportSessionCommand(request: ReportSessionCommandRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  reportSessionList(request: ReportSessionListRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  // 阶段 4：reserveDelegation、releaseDelegation
}
```

`SyscallAck` 与 `SyscallRejected` 沿用 M1Interface 第 4.3 节的 major 0；`SyscallRejected.reasonCode` 增加本文第 5 节的原因码。

### 2.2 运行内的请求

所有运行内请求都带 `sessionId` 与 `workflowRunId`，且必须与 `BoundaryContext` 中的一致。

```ts
interface RegisterAgentRunRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  agentRunId: string;              // 前缀 agr，Workflow 生成（ULID），写入日志后重放不变
  nodeId: string;                  // 该 AgentRun 对应的 AGENT 节点
  agentRef: PinnedDefinitionRef;   // kind = 'AGENT'
  effort: ThinkingEffort;          // 必须在 Agent 定义允许的范围内
  workspaceViewId: 'main';         // M2Design 第 6.5 节
  display: { label: string };      // ≤80，只用于界面
  // 阶段 2：requestedCapabilities、writeRoots
  // 阶段 4：parentAgentRunId、delegationId、budget
}

type ThinkingEffort = 'none' | 'low' | 'high' | 'max';

interface SubmitUnitRequest {
  requestId: string;               // 由提交路径派生（Interface 第 3 节）
  sessionId: string;
  workflowRunId: string;
  agentRunId: string;
  unitRunId: string;
  path: string;                    // 提交路径 `<UnitRun 路径>#<提交次数>`，≤512
  unitRef: PinnedDefinitionRef;    // kind = 'UNIT'
  input: UnitInput;                // 按 unitRef 对应 Unit 的 inputContract 校验
  display: { toolName: string; argsSummary: string };  // toolName ≤64，argsSummary ≤80；只用于界面
}

interface EndAgentRunRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  agentRunId: string;
}

type CloseRunRequest =
  | { requestId: string; sessionId: string; workflowRunId: string; outcome: 'COMPLETED'; resultRef?: ArtifactRef }
  | { requestId: string; sessionId: string; workflowRunId: string; outcome: 'FAILED'; failure: RunFailure }   // failure.source = 'WORKFLOW'
  | { requestId: string; sessionId: string; workflowRunId: string; outcome: 'BUDGET' | 'CANCELLED' | 'TIMEOUT'; resultRef?: ArtifactRef };
```

- `CloseRunRequest.resultRef`：运行发布的结果。`analyze` 为 AnalysisReport；其他 Orchestration 运行为 `output: true` 节点的结果或确定性运行报告
  （M2Design 第 7.3 节"必有报告"）；Turn-chat 的运行没有结果，回复经 `message-publish` 逐条发布。
- `outcome = 'BUDGET'` 时，Orchestration 必须带 `resultRef`（必有报告）；Turn-chat 不带。
- `RunFailure` 沿用 M1Interface 第 5.4 节。

```ts
interface RequestHumanRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  humanRequestId: string;          // 前缀 hrq，body 为对应 HUMAN 节点 ID 的 body
  nodeId: string;
  kind: 'prompt';                  // 阶段 5 增加 'ask'、'confirm'、'review'
  // 阶段 5：attachedAgentRunId、question、fields、reviewRef、source
}
```

- `kind = 'prompt'` 是开放输入：Kernel 检查没有 ACTIVE 的 AgentRun 与在途 UnitAttempt，不满足时以 `AGENT_RUN_ACTIVE` 拒绝；
  受理时结束当前 Turn（M2Design 第 2.3 节），运行进入 AWAITING_INPUT。
- Workflow 在追加 `HUMAN_REQUESTED` 之后才发出本请求（M2Design 第 10.3 节写入规则第 1 条）。

```ts
interface ReadProjectFileRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  path: 'AGENTS.md' | `.multiagentos/workflows/${string}.yaml`;   // 白名单，Schema 以正则约束
}

type ProjectFileContent =
  | { requestId: string; outcome: 'ACCEPTED'; path: 'AGENTS.md'; exists: false }
  | { requestId: string; outcome: 'ACCEPTED'; path: 'AGENTS.md'; exists: true; ref: ArtifactRef; sha256: string; trusted: boolean }
  | { requestId: string; outcome: 'ACCEPTED'; path: string; exists: false }                                       // 模板文件
  | { requestId: string; outcome: 'ACCEPTED'; path: string; exists: true; ref: ArtifactRef; sha256: string; text: string };  // 模板文件
```

- `AGENTS.md` 不返回正文，Workflow 只把引用交给 `context-assemble`；`trusted` 的判定与询问见 M2Design 第 9.5 节。
  询问进行中时本请求挂起，直到用户回答或超时（超时得到 `trusted: false`）。
- 文件超过 64 KiB 时照常存为产物；截断只发生在上下文组装中。

### 2.3 Session 命令的回复

Kernel 以 Session 级事件（第 3.2 节）向 Workflow 下达 Session 命令，Workflow 完成后以本节的请求回复。
命令按 `commandId` 一一对应；同一个 Session 同一时刻至多一条未回复的命令。

```ts
interface ReportSessionCommandRequest {
  requestId: string;
  sessionId: string;
  commandId: string;                // 前缀 scm，来自事件
  result:
    | { command: 'OPEN'; outcome: 'READY'; pendingHumanRequestId?: string; lastTurnId?: string }
    | { command: 'CREATE'; outcome: 'READY' }
    | { command: 'FORK'; outcome: 'READY'; inheritedArtifacts: ArtifactRef[] }   // 复制的日志中出现的全部产物引用
    | { command: 'CLOSE' | 'DELETE'; outcome: 'DONE' }
    | { command: 'OPEN' | 'CREATE' | 'FORK' | 'CLOSE' | 'DELETE'; outcome: 'FAILED'; failure: SessionCommandFailure };
}

interface SessionCommandFailure {
  code: 'SESSION_LOCKED' | 'SESSION_LOG_CORRUPT' | 'SESSION_FORMAT_UNSUPPORTED' | 'SESSION_STORAGE_FAILED';
  detail?: string;                  // ≤200，不得包含会话内容
}

interface ReportSessionListRequest {
  requestId: string;
  queryId: string;                  // 前缀 slq，来自 SessionListQuery
  sessions: SessionListEntry[];     // ≤1000，按最后活动时间倒序
}

interface SessionListEntry {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  titleRef?: ArtifactRef;           // 第一条 prompt 的正文；Kernel 读取前 80 个字符作为标题
  fork?: { fromSessionId: string; fromTurnCount: number };
  status: 'ACTIVE' | 'DELETED';
}
```

- `OPEN` 的 `pendingHumanRequestId`：日志中最后一个 `HUMAN_REQUESTED` 没有答复时给出（M2Design 第 10.3 节第 6 步），
  Kernel 开启运行后重新转发这个请求。
- `FAILED` 时 Kernel 不开启运行，把失败原因以 Session 级事件告知 UserInteraction。

## 3. Kernel → Workflow

### 3.1 运行级事件

信封为 `RunInboxEvent<KernelToWorkflowEvent>`（Interface 第 4 节），Schema `kernel.unit.WorkflowInboxEvent.v1`。

```ts
type KernelToWorkflowEvent =
  | RunStart | UnitReport | HumanAnswered | TurnClosed | RunClosed;
  // 阶段 2：WorkspaceReverted、WorkspaceDiverged
  // 阶段 5：RunPaused、RunResumed、RunInterrupted、HumanCancelled

interface RunStart {
  type: 'RunStart';
  templateRef: DefinitionRef;        // chat、analyze 或使用者模板
  mode: 'CHAT' | 'ORCHESTRATION';
  preset: 'standard' | 'readonly';
}

interface UnitReport {
  type: 'UnitReport';
  requestId: string;
  agentRunId: string;
  unitRunId: string;
  unitRef: PinnedDefinitionRef;
  executionKind: ExecutionKind;
  unitAttemptId?: string;            // 已建立尝试时必填
  status: 'OK' | 'REJECTED' | 'FAILED';   // 阶段 5 增加 'INTERRUPTED'
  reasonCode?: ReasonCode;           // REJECTED、FAILED 时必填
  output?: UnitOutput;               // OK 时必填
  outputRef?: ArtifactRef;           // OK 时按 Unit 的产物类型必填
  budget: BudgetView;
  // 阶段 2：changedFiles；阶段 4：quota
}

interface BudgetView {               // M2Design 第 7.3 节：三级账本各自的状态
  agentRun: BudgetState;
  turn: BudgetState;
  run: BudgetState;
}

interface HumanAnswered {
  type: 'HumanAnswered';
  kind: 'prompt';                    // 阶段 5 增加其余种类
  origin: 'initial' | 'requested';
  humanRequestId?: string;           // origin = 'requested' 时必填
  inputId: string;                   // 前缀 inp，UserInteraction 分配；用于去重
  contentRef: ArtifactRef;           // 用户输入的正文，由 Execution 写入
  turnId: string;                    // 开放输入的答复开启 Turn（M2Design 第 2.3 节）
  template?: DefinitionRef;          // Turn-chat 中以 /run 发起时，本 Turn 的主体模板
}

interface TurnClosed {
  type: 'TurnClosed';
  turnId: string;
  reason: 'COMPLETED' | 'ABORTED' | 'TIMEOUT' | 'BUDGET' | 'RUN_CLOSED';
  usage: TurnUsage;
  // 阶段 2：startSnapshot、endSnapshot、changedFileCount
}

interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  unknownTokens: number;             // 未知消耗，按预留额计入
  modelRequests: number;
  toolUnits: number;
}

interface RunClosed extends RunEnd {
  type: 'RunClosed';                 // 发给 Workflow 的该运行最后一个事件
}
```

`RunEnd` 在 major 1 中的变化：

```ts
interface RunEnd {
  closeReason: CloseReason;
  failure?: RunFailure;              // FAILED、VIOLATION 时必填
  resultRef?: ArtifactRef;           // 运行发布了结果时给出
  unknownEffects: UnknownEffect[];   // 沿用 M1Interface 第 5.4 节
  runSummaryRef?: ArtifactRef;
  finalizationError?: 'RUN_SUMMARY_WRITE_FAILED';
}

type CloseReason =
  | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'BUDGET' | 'TIMEOUT' | 'VIOLATION'
  | 'ENDED_BY_USER'                  // /exit、切换 Session、新建或 Fork 时收敛当前运行
  | 'SHUTDOWN';
```

M1 的 `RUN_TIMEOUT` 在 major 1 中删除：超时先由 Kernel 按中止处理，结束由 Workflow 以 `TIMEOUT` 报告（M2Design 第 2.3 节）。

### 3.2 Session 级事件

信封为 `SessionInboxEvent<KernelToWorkflowSessionEvent>`，Schema `kernel.session.WorkflowSessionEvent.v1`。

```ts
type KernelToWorkflowSessionEvent =
  | SessionCommand | SessionListQuery;

type SessionCommand =
  | { type: 'SessionCommand'; commandId: string; command: 'OPEN'; repositoryRoot: string }
  | { type: 'SessionCommand'; commandId: string; command: 'CREATE'; repositoryRoot: string }
  | { type: 'SessionCommand'; commandId: string; command: 'FORK'; repositoryRoot: string; fromSessionId: string }
  | { type: 'SessionCommand'; commandId: string; command: 'CLOSE' }
  | { type: 'SessionCommand'; commandId: string; command: 'DELETE' };

interface SessionListQuery {
  type: 'SessionListQuery';
  queryId: string;
  repositoryRoot: string;            // 只列出这个仓库的 Session（M2Design 第 2.3 节 Session 第 0 条）
}
```

- `SessionCommand` 对应 M2Design 第 7.5 节的 `SessionOpen` 等：`OPEN` 时 Workflow 取得 `session.lock`、修复日志、重建投影；
  `CREATE` 时新建日志；`FORK` 时复制 `fromSessionId` 的整个日志；`CLOSE` 时释放锁；`DELETE` 时删除日志并在 Session 列表中标为已删除。
- `repositoryRoot` 来自 Kernel 的 Session 引用，Workflow 写入 `SESSION_STARTED`，不用于任何授权判断。
- Session 的事件序列从 `OPEN`、`CREATE` 或 `FORK` 开始，以 `CLOSE` 或 `DELETE` 结束。

## 4. Schema 强制的约束

| 对象 | 约束 |
|---|---|
| 运行内请求 | `sessionId`、`workflowRunId` 必须与 `BoundaryContext` 中的一致 |
| `SubmitUnitRequest` | `requestId` 的 body 等于 `path` 的 SHA-256 前 32 位；`path` 以 `unitRunId` 对应的 UnitRun 路径开头 |
| `ReadProjectFileRequest.path` | 只能是 `AGENTS.md` 或匹配 `^\.multiagentos/workflows/[a-z0-9][a-z0-9-]{0,63}\.yaml$` |
| `CloseRunRequest` | `outcome = 'FAILED'` 时必须有 `failure` 且不得有 `resultRef` |
| `ReportSessionCommandRequest.result` | `command` 与事件中的命令一致；`FAILED` 时必须有 `failure` |
| `HumanAnswered` | `origin = 'requested'` 时必须有 `humanRequestId`；`origin = 'initial'` 时不得有 |
| `RunEnd` | `runSummaryRef` 与 `finalizationError` 恰好出现一个（同 M1） |

## 5. 原因码

| 原因码 | 出现位置 | 含义 |
|---|---|---|
| `AGENT_RUN_ACTIVE` | `SyscallRejected`（`requestHuman`） | 开放输入只能在静止时请求 |
| `NO_OPEN_TURN` | `SyscallRejected`（`registerAgentRun`、`submitUnit`） | 没有开启中的 Turn，或尝试属于已结束的 Turn |
| `SESSION_COMMAND_UNKNOWN` | `SyscallRejected`（`reportSessionCommand`） | `commandId` 不存在或已回复 |
| `SESSION_QUERY_UNKNOWN` | `SyscallRejected`（`reportSessionList`） | `queryId` 不存在或已回复 |
| `PROJECT_FILE_FORBIDDEN` | `SyscallRejected`（`readProjectFile`） | 路径不在白名单内（Schema 已拒绝时由 Gateway 返回 `INVALID_REQUEST`） |

M1 的 `AGENT_RUN_ACTIVE` 原本用于"已有 ACTIVE 的 AgentRun 时再次登记"，M2 允许多个 ACTIVE 的 AgentRun，该用法删除，只保留上表的含义。
其余阶段的原因码在对应阶段补充。
