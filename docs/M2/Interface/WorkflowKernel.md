# Workflow 与 Kernel 的接口

> 状态：已评审（阶段 1、2 的部分）。约定见 [Interface](README.md)。
> 标"阶段 N"的条目在该阶段的文档门中补全；major 1 冻结之前可以原地增加字段。

## 1. 范围

本文定义 `WorkflowGatewayPort`（Workflow 调用 Kernel）与发往 `inbox.workflow` 的事件（Kernel 通知 Workflow）。
Workflow 只持有 `WorkflowGatewayPort`；Gateway 以 `Envelope.producer = 'workflow'` 判定身份（M1Interface 第 2.1 节第 4 条）。

| 方向 | 内容 | 阶段 |
|---|---|---|
| Workflow → Kernel | AgentRun 登记与结束、Unit 提交、运行结束报告、人类请求、读取项目文件、Session 命令的回复 | 1 |
| Workflow → Kernel | 委派保留与返还 | 4 |
| Kernel → Workflow，Session 级 | 打开、新建、关闭 Session（Fork 为 2） | 1 |
| Kernel → Workflow，系统级 | Session 列表查询、删除未打开的 Session | 1 |
| Kernel → Workflow，运行级 | 运行开始、Unit 结果、人类答复、Turn 结束、运行结束 | 1 |
| Kernel → Workflow，运行级 | 工作区回退与差异 | 2 |
| Kernel → Workflow，运行级 | 暂停、继续、中止、人类请求取消 | 5 |
| Workflow → Kernel | 待办进度（`updateActivity`，只用于界面） | 2 |
| Kernel → Workflow，运行级 | 运行中插话（`HumanAnswered(kind: steer)`） | 5 |
| 双向，运行级 | 上下文压缩：材料查询与回答、修剪结果与压缩结果及其确认 | 8 |

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
  updateActivity(request: UpdateActivityRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;   // 阶段 2，第 2.5 节
  reserveDelegation(request: ReserveDelegationRequest, context: BoundaryContext): Promise<DelegationReserved | SyscallRejected>;   // 阶段 4
  releaseDelegation(request: ReleaseDelegationRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;   // 阶段 4
  // 阶段 8：reportCompactionSource、ackCompaction（第 2.4 节）
}
```

`SyscallAck` 与 `SyscallRejected` 的字段与 M1Interface 第 4.3 节相同，以 major 1 发布；`SyscallRejected.reasonCode` 增加本文第 5 节的原因码。

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
  effort: ThinkingEffort;          // 必须在 Agent 定义允许的范围内；AgentRun 的思考强度只在这里给出，Unit 输入中没有
  workspaceViewId: 'main';         // M2Design 第 6.5 节
  display: { label: string };      // ≤80，只用于界面
  requestedCapabilities: string[]; // 阶段 2：不超出能力上限，否则 CAPABILITY_NOT_SUBSET（Kernel/Core 第 5a.1 节）
  writeRoots: string[];            // 阶段 2：相对仓库根目录；main 为 ['.']；没有 workspace.write 时为空
  // 阶段 4：SubAgent 带 parentAgentRunId、delegationId、taskName（三项同有同无，Kernel/Core 第 5d 节）
  parentAgentRunId?: string;
  delegationId?: string;           // 前缀 dlg，Core 生成
  taskName?: string;
}

// 阶段 4
interface ReserveDelegationRequest {
  requestId: string; sessionId: string; workflowRunId: string;
  parentAgentRunId: string;
  tasks: { name: string; agentRef: PinnedDefinitionRef; writeRoots: string[]; tokens?: number }[];   // 1–12 项
}
interface DelegationReserved {            // outcome: 'ACCEPTED'
  requestId: string; delegationId: string;
  shares: { name: string; tokens: number; clamped?: 'MIN' | 'MAX' }[];
}
// 额度不足：SyscallRejected { issuer: 'CORE', reasonCode: 'BUDGET_INSUFFICIENT', delegable: number }
interface ReleaseDelegationRequest { requestId: string; sessionId: string; workflowRunId: string; delegationId: string }

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
  path: 'AGENTS.md' | `${string}/AGENTS.md` | `.multiagentos/workflows/${string}.yaml`;   // 白名单，Schema 以正则约束；子目录的 AGENTS.md 在阶段 2 开放
}

type ProjectFileContent =
  | { requestId: string; outcome: 'ACCEPTED'; path: 'AGENTS.md'; exists: false }
  | { requestId: string; outcome: 'ACCEPTED'; path: 'AGENTS.md'; exists: true; ref: ArtifactRef; sha256: string; trusted: boolean }
  | { requestId: string; outcome: 'ACCEPTED'; path: string; exists: false }                                       // 模板文件
  | { requestId: string; outcome: 'ACCEPTED'; path: string; exists: true; ref: ArtifactRef; sha256: string; text: string };  // 模板文件
```

- `AGENTS.md` 不返回正文，Workflow 只把引用交给 `context-assemble`；`trusted` 的判定与询问见 M2Design 第 9.5 节。
  询问进行中时本请求挂起，直到用户回答；询问不超时，运行收敛时本请求以 `RUN_BLOCKED` 结束。
- 文件超过 64 KiB 时照常存为产物；截断只发生在上下文组装中。

- **用户正文只以引用传递**（M2Design 第 7.5 节）：Kernel 发给 Workflow 的事件不带用户输入的正文，Workflow 也没有读取正文的通道；需要目标文字的 Unit 输入写 `objectiveRef` 或 `goalRef`，由 Execution 解析。没有例外。

### 2.3 Session 命令的回复

Kernel 以 Session 级事件（第 3.2 节）或系统级事件（第 3.3 节）向 Workflow 下达 Session 命令与列表查询，Workflow 完成后以本节的请求回复。
命令按 `commandId`、查询按 `queryId` 一一对应；同一个 Session 同一时刻至多一条未回复的命令。
这两个请求不属于任何运行，`BoundaryContext` 中没有 `workflowRunId`；`DELETE` 与列表查询针对的不是打开的 Session，由 Core 按 `commandId`、`queryId` 核对。

```ts
interface ReportSessionCommandRequest {
  requestId: string;
  sessionId: string;                // 命令所针对的 Session
  commandId: string;                // 前缀 scm，来自事件
  result:
    | { command: 'OPEN'; outcome: 'READY'; lastTurnId?: string }
    | { command: 'CREATE'; outcome: 'READY' }
    | { command: 'FORK'; outcome: 'READY'; inheritedArtifacts: ArtifactRef[]; fromTurnCount: number }   // 复制的日志中出现的全部产物引用；原 Session 的 Turn 数，用于 SessionOpened.fork
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

- `OPEN` 之后 Kernel 开启的运行以 `RunStart(initialInput: false)` 开始：没有初始输入，由 Workflow 请求开放输入。
  日志中最后一个人类请求没有答复时（M2Design 第 10.3 节第 6 步），Workflow 在新的运行中重新发起这个请求；Kernel 不保留、不转发上一个运行的请求。
- `FAILED` 时 Kernel 不开启运行，把失败原因以 Session 级事件（`DELETE` 为系统级事件）告知 UserInteraction。

### 2.4 压缩的材料与确认（阶段 8）

压缩过程见 M2Design 第 9.6 节；Workflow 只按固定规则回答，不决定是否压缩。

```ts
interface ReportCompactionSourceRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  compactionId: string;              // 来自 CompactionSourceQuery
  entries: ContextHistoryEntry[];    // 该对象当前的投影条目，与 context-assemble 输入中的历史条目同一结构（带 seq、turnId、类别）；
                                     // 模型轮条目另带 measured: { inputTokens, outputTokens, headDigest }（来自 MODEL_TURN.usage 与该轮 CONTEXT_ASSEMBLED）
}

interface AckCompactionRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  compactionId: string;
  stage: 'PRUNE' | 'SUMMARY';        // 确认的是 ToolResultsPruned 还是 ContextCompacted
  outcome: 'RECORDED' | 'FAILED';    // RECORDED：已追加 TOOL_RESULTS_PRUNED 或 CONTEXT_COMPACTED；FAILED：日志追加失败（随后按内部错误处理）
}
```

- Workflow 在追加 `TOOL_RESULTS_PRUNED` 或 `CONTEXT_COMPACTED` 成功之后才发出对应的 `ackCompaction(RECORDED)`；Kernel 收到之前，修剪或摘要不生效。
  同一次压缩至多两次确认（先 `PRUNE`，后 `SUMMARY`），每次至多一个未确认的结果。
- 回答查询与确认都不改变节点状态，也不计入任何 AgentRun 的 Round。

### 2.5 待办进度（阶段 2）

```ts
interface UpdateActivityRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  agentRunId: string;                 // 必须是 ACTIVE 的 AgentRun
  todos: { total: number; done: number; current?: string };   // total ≤30；current ≤80 个字符，为进行中的一项
}
```

- 与 `display` 相同，只用于界面：Kernel 不做任何判断，把 `todos` 原样放进该 AgentRun 之后的 ActivityEvent（M2Design 第 3.5 节）；不写审计，不计入额度与工具次数。
- Workflow 在追加 `TODOS_UPDATED` 之后才发出本请求。

## 3. Kernel → Workflow

### 3.1 运行级事件

信封为 `RunInboxEvent<KernelToWorkflowEvent>`（Interface 第 4 节），Schema `kernel.unit.WorkflowInboxEvent.v1`。

```ts
type KernelToWorkflowEvent =
  | RunStart | UnitReport | HumanAnswered | TurnClosed | RunClosed;
  | WorkspaceReverted | WorkspaceDiverged;   // 阶段 2：字段见 InteractionKernel 第 3 节；WorkspaceDiverged 为 { type, files: string[] }
  // 阶段 5：RunPaused、RunResumed、RunInterrupted、HumanCancelled；HumanAnswered 增加 kind = 'steer'
  // 阶段 8：CompactionSourceQuery、ToolResultsPruned、ContextCompacted（第 3.4 节）

interface RunStart {
  type: 'RunStart';
  mode: 'CHAT' | 'ORCHESTRATION';
  templateRef?: DefinitionRef;       // ORCHESTRATION 时必填（analyze 或使用者模板）；CHAT 是代码中的生长规则，不得有
  preset: 'standard' | 'readonly';
  initialInput: boolean;             // true：Kernel 随后以 HumanAnswered(origin: 'initial') 交来第一条输入（startSession、startRun）；
                                     // false：没有初始输入，由 Workflow 请求开放输入（openSession，包括额度结束后的继续）
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
  outputRef?: ArtifactRef;           // OK 时按 Unit 的产物类型必填；工具 Unit 为预览（M2Design 第 8.2 节），长期保留
  fullRef?: ArtifactRef;             // 只在预览截断了内容时给出：完整输出，7 天后过期；不进入投影，只作为 read_output 的输入（M2Design 第 8.2 节）
  reasoningRef?: ArtifactRef;        // 只用于 model-call：模型返回了思考内容时给出（ExecutorSet 第 7 节）
  quota?: 'TOOL_UNITS' | 'WALL_CLOCK';   // 只在 reasonCode = 'QUOTA_EXHAUSTED' 时给出：触顶的上限（Kernel/Monitor 第 3 节）；Workflow 据此设置 wrapUpReason
  budget: BudgetView;
  changedFiles?: string[];           // 阶段 2：写入工具改动的文件
}

interface BudgetView {               // M2Design 第 7.3 节：三级账本各自的状态
  agentRun: BudgetState;
  turn: BudgetState;
  run: BudgetState;                  // 按"本 Turn 现在结束时运行级账本的余额"判定（Kernel/Monitor 第 3.1 节）
}

interface HumanAnswered {
  type: 'HumanAnswered';
  kind: 'prompt';                    // 阶段 5 增加其余种类，以及运行中插话的 'steer'（带 targetAgentRunId?，没有时为本 Turn 的 main；不带 turnId，不开启 Turn）
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
  startSnapshot?: string;            // 阶段 2：快照失败时没有
  endSnapshot?: string;
  changedFileCount?: number;
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
type KernelToWorkflowSessionEvent = SessionCommand;

type SessionCommand =
  | { type: 'SessionCommand'; commandId: string; command: 'OPEN'; repositoryRoot: string }
  | { type: 'SessionCommand'; commandId: string; command: 'CREATE'; repositoryRoot: string }
  | { type: 'SessionCommand'; commandId: string; command: 'FORK'; repositoryRoot: string; fromSessionId: string }   // 阶段 2
  | { type: 'SessionCommand'; commandId: string; command: 'CLOSE' };
```

- `SessionCommand` 对应 M2Design 第 7.5 节的 `SessionOpen` 等：`OPEN` 时 Workflow 取得 `session.lock`、修复日志、重建投影；
  `CREATE` 时新建日志；`FORK` 时复制 `fromSessionId` 的整个日志；`CLOSE` 时释放锁。
- `repositoryRoot` 来自 Kernel 的 Session 引用，Workflow 写入 `SESSION_STARTED`，不用于任何授权判断。
- Session 的事件序列从 `OPEN`、`CREATE` 或 `FORK` 开始，以 `CLOSE` 结束。

### 3.3 系统级事件

信封为 `SystemInboxEvent<KernelToWorkflowSystemEvent>`（Interface 第 4 节），Schema `kernel.session.WorkflowSystemEvent.v1`。
系统级事件由 Session 管理发出，不属于任何 Session：启动时还没有打开的 Session，删除的也只能是未打开的 Session（M2Design 第 2.3 节 Session 第 3 条）。

```ts
type KernelToWorkflowSystemEvent = SessionListQuery | SessionDelete;

interface SessionListQuery {
  type: 'SessionListQuery';
  queryId: string;
  repositoryRoot: string;            // 只列出这个仓库的 Session（M2Design 第 2.3 节 Session 第 0 条）
}

interface SessionDelete {
  type: 'SessionDelete';
  commandId: string;
  sessionId: string;                 // 未打开的 Session
}
```

- `SessionDelete`：Workflow 删除该 Session 目录中 `workflow` 命名空间的文件，并在 Session 列表中追加 `status: DELETED`，
  以 `reportSessionCommand({ command: 'DELETE', ... })` 回复。

### 3.4 压缩事件（阶段 8）

运行级事件，属于 `KernelToWorkflowEvent`。

```ts
type CompactionTarget = { kind: 'MAIN' } | { kind: 'AGENT_RUN'; agentRunId: string };

interface CompactionSourceQuery {
  type: 'CompactionSourceQuery';
  compactionId: string;              // 前缀 cmp，Core 生成
  target: CompactionTarget;          // MAIN：Turn-chat 中 main 的投影（整个 Session）；AGENT_RUN：模板中 AGENT 节点或 SubAgent 的投影
}

interface ToolResultsPruned {        // 第 4.5 步的修剪结果；Workflow 追加 TOOL_RESULTS_PRUNED 后 ackCompaction(stage: 'PRUNE')
  type: 'ToolResultsPruned';
  compactionId: string;
  target: CompactionTarget;
  items: { requestId: string; toolCallId: string; prunedRef: ArtifactRef; readableRef: ArtifactRef; omittedBytes: number }[];   // ≥1
}

interface ContextCompacted {
  type: 'ContextCompacted';
  compactionId: string;
  target: CompactionTarget;
  fromSeq: number;                   // 被摘要取代的日志范围（含两端）
  toSeq: number;
  summaryRef: ArtifactRef;           // 长期保留
  summaryInput: { mode: 'PREFIX' | 'TEXT'; omittedEntries: number };   // 摘要请求的方式；TEXT 为纯文本回退，omittedEntries 为去掉的条目数
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };   // 各次摘要请求的合计
}
```

- Workflow 收到 `ToolResultsPruned` 后追加 `TOOL_RESULTS_PRUNED`，收到 `ContextCompacted` 后追加 `CONTEXT_COMPACTED`（Interface/Persistence 第 2.2 节），再分别 `ackCompaction`；投影规则见 M2Design 第 9.6 节。
- 触发压缩的 `context-assemble` 在修剪或摘要生效后以 `REJECTED(CONTEXT_COMPACTED)` 返回，Workflow 用新的投影重新提交；这次拒绝不计入连续出错。
- `model-call` 以 `REJECTED(CONTEXT_OVERFLOW)` 返回时，Workflow 重新提交 `context-assemble`（同一轮，提交路径的次数加一）；第三次溢出后按收尾处理。

### 3.5 上下文投影的条目

`context-assemble`（`v1`）的输入是 `context.ContextAssembleInput.v1`，历史由 `ContextHistoryEntry` 组成（[Module/Workflow](../Module/Workflow.md) 第 8.3 节）。正文都在产物中，所以同一个日志前缀得到相同的输入。

```ts
type ContextHistoryEntry = EntryBase & (
  | { kind: 'HUMAN'; contentRef: ArtifactRef }
  | { kind: 'MODEL_TURN'; modelId: string; outputRef: ArtifactRef; reasoningRef?: ArtifactRef; replayable: boolean }
  | { kind: 'TOOL_RESULT'; toolCallId: string; toolName: string; status: 'OK' | 'REJECTED' | 'FAILED' | 'INTERRUPTED'; outputRef?: ArtifactRef; reasonCode?: ReasonCode }   // outputRef 只能是预览，不得是 fullRef
  | { kind: 'FEEDBACK'; text: string; toolCallId?: string }   // 没有执行的工具调用的回答，≤1000
  | { kind: 'HANDOFF'; outputRef: ArtifactRef; toolCallId: string }   // 前驱节点的交接，PINNED；正文在该次模型输出中
  | { kind: 'PROJECT_INSTRUCTIONS'; path: string; ref: ArtifactRef; trusted: boolean }   // AGENTS.md，PINNED，追加在读取它的位置（M2Design 第 9.5 节）
  | { kind: 'NOTE'; text: string }                 // 运行时上下文、中断与修复的说明，≤2000
);

interface EntryBase { seq: number; turnId?: string; category: 'PINNED' | 'NORMAL' }

interface ContextAssembleInput {
  final: boolean;                                  // 必须等于 status.final
  orientPackRef?: ArtifactRef;
  history: ContextHistoryEntry[];
  status: { round: number; maxRounds: number; budget: BudgetView; final: boolean; wrapUpReason?: WrapUpReason };
}

type WrapUpReason =                                // 下一次模型调用为什么是收尾调用（Module/Workflow 第 7 节）
  | 'BUDGET_WRAP_UP'                               // BudgetView 为 WRAP_UP
  | 'TOOL_UNIT_LIMIT' | 'WALL_CLOCK_LIMIT'         // QUOTA_EXHAUSTED 的 quota 为 TOOL_UNITS、WALL_CLOCK
  | 'REPEATED_INTENT' | 'CONSECUTIVE_ERRORS'       // Workflow 的业务熔断（M2Design 第 3.4 节）
  | 'CONTEXT_LIMIT' | 'NO_PROGRESS' | 'ROUND_LIMIT' | 'REGENERATION_LIMIT';
```

`GRAPH_EXTENDED` 的 `nodes`、`edges` 见 [Persistence](Persistence.md) 第 2.3 节。

## 4. Schema 强制的约束

| 对象 | 约束 |
|---|---|
| 运行内请求 | `sessionId`、`workflowRunId` 必须与 `BoundaryContext` 中的一致 |
| `SubmitUnitRequest` | `requestId` 的 body 等于 `path` 的 SHA-256 前 32 位；`path` 以 `unitRunId` 对应的 UnitRun 路径开头 |
| `ReadProjectFileRequest.path` | 只能是 `AGENTS.md`、匹配 `^\.multiagentos/workflows/[a-z0-9][a-z0-9-]{0,63}\.yaml$`，或（阶段 2）以 `/AGENTS.md` 结尾、不以 `/` 开头、不含 `..` 段与空段、≤512 字符的相对路径；是否在排除规则内由 Kernel 检查 |
| `CloseRunRequest` | `outcome = 'FAILED'` 时必须有 `failure` 且不得有 `resultRef` |
| `ReportSessionCommandRequest.result` | `command` 与事件中的命令一致；`FAILED` 时必须有 `failure` |
| `RunStart` | `mode = 'ORCHESTRATION'` 时必须有 `templateRef`；`mode = 'CHAT'` 时不得有 |
| `HumanAnswered` | `origin = 'requested'` 时必须有 `humanRequestId`；`origin = 'initial'` 时不得有 |
| `RunEnd` | `runSummaryRef` 与 `finalizationError` 恰好出现一个（同 M1） |
| `UnitReport` | `reasonCode = 'QUOTA_EXHAUSTED'` 时必须有 `quota`、不得有 `unitAttemptId`（在受理时拒绝，没有尝试）；其他情况不得有 `quota` |

## 5. 原因码

| 原因码 | 出现位置 | 含义 |
|---|---|---|
| `AGENT_RUN_ACTIVE` | `SyscallRejected`（`requestHuman`） | 开放输入只能在静止时请求 |
| `NO_OPEN_TURN` | `SyscallRejected`（`registerAgentRun`、`submitUnit`） | 没有开启中的 Turn，或尝试属于已结束的 Turn |
| `SESSION_COMMAND_UNKNOWN` | `SyscallRejected`（`reportSessionCommand`） | `commandId` 不存在或已回复 |
| `SESSION_QUERY_UNKNOWN` | `SyscallRejected`（`reportSessionList`） | `queryId` 不存在或已回复 |
| `USER_DECLINED` | `SyscallRejected`（`readProjectFile`） | 用户拒绝了 `repo.read`，项目文件读不到（Kernel/Core 第 5.2 节）；Unit 被拒时走 UnitReport |
| `PROJECT_FILE_FORBIDDEN` | `SyscallRejected`（`readProjectFile`） | 路径不在白名单内（Schema 已拒绝时由 Gateway 返回 `INVALID_REQUEST`） |

| `QUOTA_EXHAUSTED` | UnitReport（`REJECTED`） | 该 AgentRun 的工具次数或墙钟已触顶（`quota` 说明是哪一项）；后续的非收尾 Unit 都以它拒绝，Workflow 进入收尾（Kernel/Monitor 第 3 节） |
| `ARTIFACT_EXPIRED` | UnitReport（`REJECTED`） | 引用的正文已过保留期（M2Design 第 10.1 节，按登记时间判断）；只出现在 `read_output` 的 UnitReport 中（阶段 2），Workflow 把它作为工具结果交给模型，说明完整输出已过期删除；出现在其他 Unit 中时视为内部错误 |
| `CONTEXT_COMPACTED` | UnitReport（`context-assemble`，`REJECTED`） | 阶段 8：组装期间完成了压缩，须以新的投影重新提交 |
| `CONTEXT_OVERFLOW` | UnitReport（`model-call`，`REJECTED`） | 阶段 8：provider 报告上下文过长 |
| `COMPACTION_UNKNOWN` | `SyscallRejected`（`reportCompactionSource`、`ackCompaction`） | 阶段 8：`compactionId` 不存在或已回复 |

M1 的 `AGENT_RUN_ACTIVE` 原本用于"已有 ACTIVE 的 AgentRun 时再次登记"，M2 允许多个 ACTIVE 的 AgentRun，该用法删除，只保留上表的含义。
阶段 2 增加：

| 原因码 | 出现位置 | 含义 |
|---|---|---|
| `CAPABILITY_NOT_SUBSET` | `SyscallRejected`（`registerAgentRun`） | 请求的能力或可写根目录超出能力上限 |
| `CAPABILITY_NOT_GRANTED` | UnitReport（`REJECTED`） | 所需能力不在能力上限中，不询问 |
| `WRITE_OUT_OF_SCOPE` | UnitReport（`REJECTED`） | 写入路径不在可写根目录内，不询问 |
| `PROTECTED_PATH` | UnitReport（`REJECTED`） | `.git/`、`.multiagentos/` 或排除规则命中的路径，不询问 |
| `ADMISSION_CHECK_FAILED` | UnitReport（`REJECTED`） | 判定过程本身出错，一律拒绝 |
| `FILE_CHANGED` | UnitReport（`REJECTED`） | `baseSha` 或 `expectAbsent` 不成立：文件在读取之后被改动 |
| `EDIT_NO_MATCH`、`EDIT_NOT_UNIQUE` | UnitReport（`REJECTED`） | `oldString` 没有匹配，或匹配不唯一 |
| `UNDO_NOT_AVAILABLE`、`NOTHING_TO_UNDO`、`UNDO_UNKNOWN` | `SyscallRejected`（`undoTurns`、`confirmUndo`、`diffTurns`） | 不在 AWAITING_INPUT、没有可回退的 Turn、`undoId` 不存在 |

其余阶段的原因码在对应阶段补充。
