# UserInteraction 与 Kernel 的接口

> 状态：草稿（阶段 1 的部分）。约定见 [Interface](README.md)。语义以 [M2Design](../M2Design.md) 为准，本文只定义字段。
> 标"阶段 N"的条目在该阶段的文档门中补全。

## 1. 范围

本文定义 `InteractionGatewayPort`（UserInteraction 调用 Kernel）与发往 `inbox.user-interaction` 的事件。
UserInteraction 不保存任何 Session 信息（M2Design 第 2.4 节），界面上显示的 Session 列表、标题与 Fork 关系都来自本文的事件。

本进程的仓库根目录在启动时由组合根确定（M2Design 第 2.3 节 Session 第 0 条），写入 Kernel 的配置；
UserInteraction 的请求不携带仓库路径。

| 方向 | 内容 | 阶段 |
|---|---|---|
| UserInteraction → Kernel | 新建、Fork、打开、列出、删除 Session；以模板开启运行；回答授权与人类请求；读取产物；关闭 | 1（Fork 为 2） |
| UserInteraction → Kernel | 回退与差异 | 2 |
| UserInteraction → Kernel | 暂停、继续、中止、运行中插话 | 5 |
| UserInteraction → Kernel | `/compact` | 8 |
| Kernel → UserInteraction | 压缩完成的通知 | 8 |
| Kernel → UserInteraction | 授权询问与结果、人类请求与结果、发布的消息、运行状态、活动、运行结束；Session 级事件；系统级事件（Session 列表、删除结果） | 1 |

## 2. UserInteraction → Kernel

### 2.1 端口

```ts
interface InteractionGatewayPort {
  startSession(request: StartSessionRequest, context: BoundaryContext): Promise<SessionAccepted | SyscallRejected>;
  openSession(request: OpenSessionRequest, context: BoundaryContext): Promise<SessionAccepted | SyscallRejected>;
  startRun(request: StartRunRequest, context: BoundaryContext): Promise<SessionAccepted | SyscallRejected>;
  listSessions(request: ListSessionsRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  deleteSession(request: DeleteSessionRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  answerAuthorization(request: AnswerAuthorizationRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  answerHuman(request: AnswerHumanRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  readArtifact(request: ReadArtifactRequest, context: BoundaryContext): Promise<ArtifactContent | SyscallRejected>;
  shutdown(request: ShutdownRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  // 阶段 2：undoTurns、confirmUndo、diffTurns
  // 阶段 5：pauseRun、resumeRun、interruptRun、steerRun（运行中插话，只在 RUNNING 时受理，M2Design 第 4.5 节）
  // 阶段 8：compactContext（第 2.4 节）
}
```

M1 的 `createRun` 与 `cancelRun` 在 major 1 中删除：`createRun` 由 `startSession` 与 `startRun` 取代，`cancelRun` 由阶段 5 的 `interruptRun` 取代。

### 2.2 Session 请求

```ts
interface StartSessionRequest {      // 草稿中提交第一条提示词时发出（M2Design 第 2.3 节 Session 第 2 条）
  requestId: string;
  mode: 'NEW' | 'FORK';              // 'FORK' 在阶段 2 开放
  fromSessionId?: string;            // mode = 'FORK' 时必填，必须是当前打开的 Session
  prompt: UserInput;
}

interface OpenSessionRequest {
  requestId: string;
  sessionId: string;
}

interface StartRunRequest {          // mas run <模板> "<目标>"，总是新建 Session
  requestId: string;
  template: DefinitionRef;           // 阶段 1 只接受内置模板 analyze；阶段 7 开放使用者模板
  goal: UserInput;
}

interface UserInput {
  inputId: string;                   // 前缀 inp，UserInteraction 分配；重复提交按它去重
  text: string;                      // 1..100000 个字符；Kernel 交给 Execution 存为产物，不进入日志正文
}

interface SessionAccepted {
  requestId: string;
  outcome: 'ACCEPTED';
  sessionId: string;
}

interface ListSessionsRequest {
  requestId: string;                 // 结果以系统级事件 SessionList 返回，与本 requestId 对应
}

interface DeleteSessionRequest {
  requestId: string;
  sessionId: string;                 // 不能是当前打开的 Session；结果以系统级事件 SessionDeleted 返回
}
```

- `startSession`、`openSession`、`startRun` 受理时，Kernel 依次收敛当前运行、关闭当前 Session，再打开或新建目标 Session；
  结果以 Session 级事件 `SessionOpened` 或 `SessionFailed` 告知。
- `openSession` 只接受引用存在、未删除、且仓库与本进程一致的 Session，否则以 `SESSION_NOT_FOUND` 拒绝，不说明是哪一种情况。
- **对当前 Session 的 `openSession`** 用于运行结束后在同一 Session 中继续（M2Design 第 2.3 节 WorkflowRun 第 1 条，例如因额度结束后用户确认继续）：
  当前运行已经 CLOSED 时，Kernel 不关闭 Session、不再下达 Session 命令，直接开启新的运行（`RunStart(initialInput: false)`），
  不再发出 `SessionOpened`，结果以新运行的 `RunStateChanged` 告知；当前运行尚未 CLOSED 时以 `SESSION_IN_USE` 拒绝。

### 2.3 运行内的请求

```ts
interface AnswerAuthorizationRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  questionId: string;
  answer: AuthorizationAnswer;
}

type AuthorizationAnswer =
  | { scope: 'ALLOW' }               // 不确定级与安全级：本运行内对这个资源键有效；project.instructions：信任这份内容
  | { scope: 'DENY' };
  // 阶段 2：单次允许；阶段 3：本运行内这条命令、本运行内这个前缀

interface AnswerHumanRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  humanRequestId: string;
  input: UserInput;                  // kind = 'prompt'；阶段 5 增加结构化答复
  template?: DefinitionRef;          // 以 /run 发起本 Turn 时给出（阶段 7）
}

interface ReadArtifactRequest {
  requestId: string;
  sessionId: string;                 // M1 为 workflowRunId；产物的归属改为 Session（M2Design 第 10.1 节）
  ref: ArtifactRef;
}
```

`ArtifactContent`、`ShutdownRequest` 沿用 M1Interface 第 4.2、4.3 节的 major 0。
`readArtifact` 读取已按保留期回收的正文（例如 7 天前的完整工具输出）时以 `ARTIFACT_EXPIRED` 拒绝，界面显示"完整输出已过期删除"。

### 2.4 `/compact`（阶段 8）

```ts
interface CompactContextRequest {
  requestId: string;
  sessionId: string;
  workflowRunId: string;
}
```

- 只在 Turn-chat 运行处于 AWAITING_INPUT 时受理，对象为 main 的投影（M2Design 第 9.6 节）；其他状态以 `REQUEST_CONFLICT` 拒绝。
- 受理即返回 `SyscallAck`；结果以运行级事件 `ContextCompacted` 告知，没有可压缩的范围、额度不足或失败时以 `CompactionFailed` 告知。

## 3. Kernel → UserInteraction

### 3.1 运行级事件

信封为 `RunInboxEvent<KernelToInteractionEvent>`，Schema `kernel.control.InteractionInboxEvent.v1`。

```ts
type KernelToInteractionEvent =
  | AuthorizationRequest | AuthorizationResolved
  | HumanRequest | HumanResolved
  | MessagePublished | RunStateChanged | ActivityEvent | RunFinished;
  // 阶段 8：ContextCompacted、CompactionFailed（第 3.4 节）

type AuthorizationRequest =
  | {
      type: 'AuthorizationRequest'; questionId: string; capability: 'repo.read';
      repositoryPath: string; exclusions: string[]; provider: string; expiresAt: string;
    }
  | {
      type: 'AuthorizationRequest'; questionId: string; capability: 'project.instructions';
      path: string; contentRef: ArtifactRef; truncated: boolean; expiresAt: string;   // path：'AGENTS.md'，阶段 2 起也可以是子目录的 AGENTS.md
    };
  // 阶段 2：workspace.write；阶段 3：command.exec、command.network；阶段 6：web.search、web.fetch

interface AuthorizationResolved {
  type: 'AuthorizationResolved';
  questionId: string;
  resolution: 'GRANTED' | 'DECLINED' | 'TIMED_OUT' | 'CANCELLED';
}

interface HumanRequest {
  type: 'HumanRequest';
  humanRequestId: string;
  kind: 'prompt';                    // 阶段 5 增加其余种类与 source
}

interface HumanResolved {
  type: 'HumanResolved';
  humanRequestId: string;
  resolution: 'ANSWERED' | 'CANCELLED';
}

interface MessagePublished {         // message-publish 完成时发出
  type: 'MessagePublished';
  messageRef: ArtifactRef;           // UserInteraction 经 readArtifact 读取正文
  agentLabel: string;                // ≤80
  kind: 'REPLY' | 'RUN_RESULT';
}

interface RunStateChanged {
  type: 'RunStateChanged';
  state: 'RUNNING' | 'AWAITING_INPUT' | 'CONVERGING';   // 阶段 5 增加 PAUSING、PAUSED、INTERRUPTING
  turnId?: string;                   // 有开启中的 Turn 时给出
}

interface ActivityEvent {            // 只用于界面，由 Kernel 依据登记与尝试状态生成
  type: 'ActivityEvent';
  agentRunId: string;
  label: string;                     // 登记时的 display.label
  parentAgentRunId?: string;         // 阶段 4
  phase: ActivityPhase;
  unit?: { unitAttemptId: string; toolName: string; argsSummary: string; state: 'QUEUED' | 'RUNNING' | 'DONE' };
  retry?: { attempt: number; retryAt: string };   // phase = 'RETRYING' 时必填：第几次技术重试、何时重试（M2Design 第 7.4 节）
  todos?: { total: number; done: number; current?: string };   // 阶段 2：Workflow 经 updateActivity 交来的待办进度，原样转发
  at: string;
}

type ActivityPhase =
  | 'ASSEMBLING' | 'THINKING' | 'RETRYING' | 'CALLING_TOOL' | 'AWAITING_AUTHORIZATION'
  | 'QUEUED' | 'WRAPPING_UP' | 'ENDED';
  // 阶段 4：WAITING_SUBTASKS；阶段 5：AWAITING_ANSWER、PAUSED；阶段 8：COMPACTING

interface RunFinished extends RunEnd {   // RunEnd 见 WorkflowKernel 第 3.1 节
  type: 'RunFinished';
}
```

`ActivityPhase` 与界面上显示的阶段名称（M2Design 第 11.1 节）的对应由 UserInteraction 决定。

### 3.2 Session 级事件

信封为 `SessionInboxEvent<KernelToInteractionSessionEvent>`，Schema `kernel.session.InteractionSessionEvent.v1`。

```ts
type KernelToInteractionSessionEvent =
  | SessionOpened | SessionFailed | SessionClosed;

interface SessionOpened {
  type: 'SessionOpened';
  repositoryRoot: string;
  title?: string;                    // ≤80，来自第一条 prompt
  turnCount: number;
  fork?: { fromSessionId: string; fromTurnCount: number };
  // 阶段 2：divergedFiles（打开时的工作区差异，M2Design 第 2.3 节 Session 第 6 条）
}

interface SessionFailed {
  type: 'SessionFailed';
  requestId: string;                 // 对应的 startSession、openSession 或 startRun
  code: 'SESSION_LOCKED' | 'SESSION_LOG_CORRUPT' | 'SESSION_FORMAT_UNSUPPORTED' | 'SESSION_STORAGE_FAILED';
}

interface SessionClosed {
  type: 'SessionClosed';             // 该 Session 序列的最后一个事件（失败时为 SessionFailed）
  reason: 'SWITCHED' | 'SHUTDOWN';
}
```

- 一个 Session 序列以 `SessionClosed` 或 `SessionFailed` 结束：打开或新建失败时 `SessionFailed` 是最后一个事件，不再发出 `SessionClosed`。

### 3.3 系统级事件

信封为 `SystemInboxEvent<KernelToInteractionSystemEvent>`（Interface 第 4 节），Schema `kernel.session.InteractionSystemEvent.v1`。

```ts
type KernelToInteractionSystemEvent = SessionList | SessionDeleted;

interface SessionList {
  type: 'SessionList';
  requestId: string;                 // 对应的 listSessions
  sessions: {
    sessionId: string;
    title?: string;                  // ≤80
    createdAt: string;
    lastActiveAt: string;
    turnCount: number;
    fork?: { fromSessionId: string; fromTurnCount: number };
  }[];                               // 只含本仓库、未删除的 Session，按最后活动时间倒序
}

interface SessionDeleted {
  type: 'SessionDeleted';
  requestId: string;                 // 对应的 deleteSession
  sessionId: string;
  outcome: 'DELETED' | 'FAILED';     // FAILED：Workflow 删除日志失败；Session 引用仍标为已删除，Kernel 照常删除自己的文件，不再出现在列表中
}
```

### 3.4 压缩的通知（阶段 8）

运行级事件，属于 `KernelToInteractionEvent`。

```ts
interface ContextCompacted {         // 压缩生效（Workflow 已记入日志）之后发出
  type: 'ContextCompacted';
  trigger: 'AUTO' | 'OVERFLOW' | 'USER' | 'IDLE';
  summaryRef?: ArtifactRef;          // 界面可以经 readArtifact 展示摘要；只有修剪、没有写摘要时省略
  compactedTurns: number;            // 被摘要取代的 Turn 数（部分取代的 Turn 也计入）；只有修剪时为 0
  prunedResults: number;            // 被修剪的工具结果数
}

interface CompactionFailed {
  type: 'CompactionFailed';
  trigger: 'AUTO' | 'OVERFLOW' | 'USER';   // 空闲触发的失败不通知界面（M2Design 第 9.6 节）
  reason: 'NOTHING_TO_COMPACT' | 'BUDGET_INSUFFICIENT' | 'SUMMARY_FAILED' | 'NOT_RECORDED';
}
```

## 4. Schema 强制的约束

| 对象 | 约束 |
|---|---|
| `StartSessionRequest` | `mode = 'FORK'` 时必须有 `fromSessionId`；`mode = 'NEW'` 时不得有 |
| `AuthorizationRequest` | 按 `capability` 取对应变体的字段 |
| 运行内请求 | `sessionId`、`workflowRunId` 必须与 `BoundaryContext` 中的一致 |
| `RunStateChanged` | `state = 'AWAITING_INPUT'` 时不得有 `turnId` |
| `ActivityEvent` | `phase = 'RETRYING'` 时必须有 `retry`，其他阶段不得有 |

## 5. 原因码

| 原因码 | 出现位置 | 含义 |
|---|---|---|
| `SESSION_NOT_FOUND` | `SyscallRejected`（`openSession`、`deleteSession`、`startSession` 的 Fork） | 引用不存在、已删除，或仓库与本进程不一致 |
| `SESSION_IN_USE` | `SyscallRejected`（`deleteSession`、对当前 Session 的 `openSession`） | 不能删除当前打开的 Session；当前 Session 的运行尚未结束时不能在其中开启新的运行 |
| `TEMPLATE_UNSUPPORTED` | `SyscallRejected`（`startRun`） | 阶段 1 只接受 `analyze` |
| `QUESTION_NOT_PENDING` | `SyscallRejected`（`answerAuthorization`） | 沿用 M1 |
| `HUMAN_REQUEST_NOT_PENDING` | `SyscallRejected`（`answerHuman`） | 请求不存在或已答复 |
| `ARTIFACT_EXPIRED` | `SyscallRejected`（`readArtifact`） | 正文已按保留期回收 |
| `REQUEST_CONFLICT` | `SyscallRejected`（`compactContext`） | 阶段 8：不是 Turn-chat，或运行不处于 AWAITING_INPUT（沿用 M1 的原因码） |
