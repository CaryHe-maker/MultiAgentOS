# UserInteraction 与 Kernel 的接口

> 状态：已实现，与 `packages/libraries/contracts`（`ports.ts` 的 `InteractionGatewayPort`、`kernel-control`、`kernel-session`）一致。约定见 [Interface](README.md)。

## 1. 范围

本文定义 `InteractionGatewayPort`（UserInteraction 调用 Kernel）与发往 `inbox.user-interaction` 的事件。
UserInteraction 不保存任何 Session 信息（M2Design 第 2.4 节），界面上显示的 Session 列表、标题与 Fork 关系都来自本文的事件。

本进程的仓库根目录在启动时由组合根确定（M2Design 第 2.3 节 Session 第 0 条），写入 Kernel 的配置；
UserInteraction 的请求不携带仓库路径。

| 方向 | 内容 |
|---|---|
| UserInteraction → Kernel | 新建、Fork、打开、列出、删除 Session；以模板开启运行；回答授权与人类请求；读取产物；关闭 |
| UserInteraction → Kernel | 回退、回到 checkpoint、继续上次进程留下的长任务、差异与 checkpoint 列表 |
| UserInteraction → Kernel | 暂停、继续、中止、运行中插话 |
| UserInteraction → Kernel | `/compact` |
| Kernel → UserInteraction | 压缩完成的通知 |
| Kernel → UserInteraction | 授权询问与结果、人类请求与结果、发布的消息、运行状态、活动、运行结束；Session 级事件；系统级事件（Session 列表、删除结果） |

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
  pauseRun(request: PauseRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  resumeRun(request: ResumeRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  interruptRun(request: InterruptRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  steerRun(request: SteerRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;          // 运行中插话，只在 RUNNING 时受理（M2Design 第 4.5 节）
  compactContext(request: CompactContextRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;   // 第 2.4 节
  undo(request: UndoRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  recoverRun(request: RecoverRunRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;      // /recover（Orchestration 第 7.6 节）
  confirmUndo(request: ConfirmUndoRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
  diff(request: DiffRequest, context: BoundaryContext): Promise<CheckpointDiff | SyscallRejected>;
  rewindCheckpoint(request: RewindCheckpointRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;   // 暂停时回到第 N 个 checkpoint（Orchestration 第 7.5 节）
  listCheckpoints(request: ListCheckpointsRequest, context: BoundaryContext): Promise<CheckpointList | SyscallRejected>;
  shutdown(request: ShutdownRequest, context: BoundaryContext): Promise<SyscallAck | SyscallRejected>;
}
```

M1 的 `createRun` 与 `cancelRun` 在 major 1 中删除：`createRun` 由 `startSession` 与 `startRun` 取代，`cancelRun` 由 `interruptRun` 取代。

### 2.2 Session 请求

```ts
interface StartSessionRequest {      // 草稿中提交第一条提示词时发出（M2Design 第 2.3 节 Session 第 2 条）
  requestId: string;
  mode: 'NEW' | 'FORK';              // 'NEW' 新建，'FORK' 从当前 Session 分出
  fromSessionId?: string;            // mode = 'FORK' 时必填，必须是当前打开的 Session
  prompt: UserInput;
}

interface OpenSessionRequest {
  requestId: string;
  sessionId: string;
  confirmWorkspaceChange?: boolean;  // 用户同意在本进程的文件夹里打开最后在别的文件夹工作过的 Session（M2Design 第 2.3 节）
}

interface StartRunRequest {          // mas run <模板> "<目标>"，总是新建 Session
  requestId: string;
  template: DefinitionRef;           // `mas run` 总是内置模板 mission
  goal: UserInput;
}

interface UserInput {
  inputId: string;                   // 前缀 inp，UserInteraction 分配；重复提交按它去重
  text: string;                      // 1..100000 个字符；Kernel 交给 Execution 存为产物，不进入日志正文
  delegateTo?: string;               // /mission：这次输入要交给哪个派生工具（Orchestration D114）；Kernel 只转交
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
- `openSession` 只接受引用存在、未删除的 Session，否则以 `SESSION_NOT_FOUND` 拒绝，不说明是哪一种情况。
- Session 最后在别的文件夹工作过时，必须带 `confirmWorkspaceChange: true`，否则以 `WORKSPACE_CHANGE_NOT_CONFIRMED` 拒绝：确认由 Kernel 判定，不依赖客户端是否弹过确认。确认后 Kernel 让快照另起一段、把引用改为本进程的文件夹，再打开；Workflow 在日志里追加 `WORKSPACE_BOUND`。
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
  | { scope: 'ONCE' }                // 极危险级只有它与 DENY；这个 UnitAttempt 结束时作废
  | { scope: 'COMMAND' }             // 命令：本运行内这条命令
  | { scope: 'PREFIX' }              // 命令：本运行内这个前缀
  | { scope: 'ANY_HOST' }            // web.fetch：本运行内任何公开网站
  | { scope: 'FOLDER' }              // web.search：这个文件夹以后都允许
  | { scope: 'DENY' };

interface UndoRequest {              // /undo：回到最近一个 checkpoint 之前（ALL：第一个之前）；只在 AWAITING_INPUT，否则 UNDO_NOT_AVAILABLE
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  scope: 'LAST' | 'ALL';
}

interface RewindCheckpointRequest {  // 只在暂停时：文件回到这个 checkpoint 的快照，切面之后的工作被取代
  requestId: string; sessionId: string; workflowRunId: string;
  checkpoint: number;                // listCheckpoints 中的序号
}

interface RecoverRunRequest {        // 只在新对话等第一条输入时：上次进程留下的长任务从最近的 checkpoint 继续
  requestId: string; sessionId: string; workflowRunId: string;
}

interface ConfirmUndoRequest {       // 回答 UndoConfirmationRequested
  requestId: string;
  sessionId: string;
  workflowRunId: string;
  undoId: string;
  decision: 'FORCE' | 'CANCEL';
}

interface DiffRequest {              // listCheckpoints 中第 checkpoint 个，或倒数第 n 个（都没有时为 1）的区间改了什么
  requestId: string;
  sessionId: string;
  n?: number;
  checkpoint?: number;
}

interface CheckpointDiff {
  requestId: string;
  outcome: 'ACCEPTED';
  files: { path: string; change: 'ADDED' | 'MODIFIED' | 'DELETED' }[];
  diffRef: ArtifactRef;              // 统一 diff 文本；被排除的文件不在其中
}

interface ListCheckpointsRequest { requestId: string; sessionId: string }

interface CheckpointList {           // 没有被回退的 checkpoint，从早到晚（Orchestration 第 7.4 节）
  requestId: string;
  outcome: 'ACCEPTED';
  items: {
    seq: number;
    kind: 'INPUT' | 'ROOT_SPAWN' | 'HUMAN_ANSWER' | 'TEMPLATE';   // INPUT 是用户的一条输入
    label: string;
    at: string;
    changedFiles?: number;           // 这一段改了几个文件（已知时）
  }[];
}

// 运行控制。四个请求都只带运行的标识；Kernel 不解释说明的内容，只存正文并转交 Workflow
interface PauseRunRequest { requestId: string; sessionId: string; workflowRunId: string }
interface InterruptRunRequest { requestId: string; sessionId: string; workflowRunId: string }
interface ResumeRunRequest {
  requestId: string; sessionId: string; workflowRunId: string;
  steer?: { input: UserInput; targetAgentRunId?: string };   // 继续并附加说明；缺省目标为 main（代替 chat 工作的 Mission 在时为它，D115）
}
interface SteerRunRequest {
  requestId: string; sessionId: string; workflowRunId: string;
  input: UserInput;                  // kind = 'steer'
  targetAgentRunId?: string;         // 缺省同上；给出时必须是本运行的 AgentRun（否则 INVALID_INPUT）
}

  requestId: string;
  sessionId: string;
  workflowRunId: string;
  humanRequestId: string;
  input: UserInput;                  // 开放输入的答复，或局部询问（ask、confirm、review）的答复文本
}

interface ReadArtifactRequest {
  requestId: string;
  sessionId: string;                 // M1 为 workflowRunId；产物的归属改为 Session（M2Design 第 10.1 节）
  ref: ArtifactRef;
}
```

`ArtifactContent` 的字段与 M1Interface 第 4.2 节相同，以 major 1 发布。`ShutdownRequest` 在 M1 的基础上增加 `source`（`EXIT_COMMAND`、`INTERRUPT_TWICE`、`RUN_FINISHED`、`EXIT_CODE`）：谁请求了退出，只写进 Kernel 的系统级开发者记录（[Persistence](Persistence.md) 第 4.5 节），不转给 Workflow、不进 Session 日志。
`readArtifact` 读取已按保留期回收的正文（例如 7 天前的完整工具输出）时以 `ARTIFACT_EXPIRED` 拒绝，界面显示"完整输出已过期删除"。

### 2.4 `/compact`

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
  | MessagePublished | RunStateChanged | ActivityEvent | BackgroundJobs | RunFinished
  | UndoConfirmationRequested | UndoCancelled | CheckpointRolledBack
  | ContextCompacted | CompactionFailed        // 第 3.4 节
  | ExternalReadPaused;                         // Kernel/Core 第 5h 节

type AuthorizationRequest =
  | {
      type: 'AuthorizationRequest'; questionId: string; capability: 'repo.read';
      repositoryPath: string; exclusions: string[]; provider: string;
    }
  | {
      type: 'AuthorizationRequest'; questionId: string; capability: 'project.instructions';
      path: string; contentRef: ArtifactRef; truncated: boolean;   // path：'AGENTS.md'，也可以是子目录的 AGENTS.md
    }
  | {  // 不确定级，回答 ALLOW 或 DENY
      type: 'AuthorizationRequest'; questionId: string; capability: 'workspace.write';
      writeRoot: string; critical: false;
    }
  | {  // 写 AGENTS.md，极危险级，回答 ONCE 或 DENY；展示确切内容
      type: 'AuthorizationRequest'; questionId: string; capability: 'workspace.write';
      path: string; contentRef: ArtifactRef; critical: true;
    }
  | {  // 读工作区之外的目录，危险级，回答 ALLOW 或 DENY；root 是回答所授权的目录，path 是被请求的路径
      type: 'AuthorizationRequest'; questionId: string; capability: 'external.read';
      root: string; path: string; provider: string;
    }
  | {  // 一条命令（Kernel/Core 第 5b 节）：确切地显示要运行什么、在哪里、可以写哪里、是否联网、是否未隔离；options 是可以回答的范围
      type: 'AuthorizationRequest'; questionId: string; capability: 'command.exec';
      command: string; workdir: string; writableRoots: string[]; network: boolean; unisolated: boolean; critical: boolean;
      prefixes: string[]; unreusable: UnreusableReason[]; matched?: string; approvalDigest: string;
      options: ('ONCE' | 'COMMAND' | 'PREFIX' | 'DENY')[];   // 极危险或不能复用的命令只有 ONCE 与 DENY
    }
  | { type: 'AuthorizationRequest'; questionId: string; capability: 'web.search'; queries: string[]; provider: string }
  | { type: 'AuthorizationRequest'; questionId: string; capability: 'web.fetch'; url: string; host: string }
  | {  // 这次输入的额度快用完了（M2Design 第 7.3 节规则 6；派生时借不出也问，Orchestration D115）：ALLOW 加 add，DENY 收尾
      type: 'AuthorizationRequest'; questionId: string; capability: 'budget.extend';
      used: number; limit: number; add: number; tasks: number;
    }
  | {  // 这次运行启动的子任务到了上限（Orchestration D62）：ALLOW 再允许 add 个，DENY 拒绝这次与以后的调用
      type: 'AuthorizationRequest'; questionId: string; capability: 'tasks.extend';
      started: number; limit: number; add: number;
    };

interface ExternalReadPaused {       // 连续两次读取外部文件失败，运行已暂停（Kernel/Core 5h）；控制台用红字显示
  type: 'ExternalReadPaused';
  attempts: { path: string; reason: 'UNAVAILABLE' | 'DECLINED' | 'FAILED' }[];
}

interface UndoConfirmationRequested {  // 有外部修改时；不是授权询问
  type: 'UndoConfirmationRequested';
  undoId: string;
  files: { path: string; change: 'ADDED' | 'MODIFIED' | 'DELETED' | 'UNKNOWN' }[];
}

interface UndoCancelled {
  type: 'UndoCancelled';
  undoId: string;
  reason: 'USER_CANCELLED' | 'NEW_INPUT' | 'SESSION_CLOSED' | 'FILE_CHANGED';
}

interface CheckpointRolledBack {     // 工作区回到了一个 checkpoint（Orchestration 第 7.5 节）；发给 UserInteraction 与 Workflow
  type: 'CheckpointRolledBack';
  checkpointId: string;
  label: string;
  files: string[];                   // 放回的文件
  backupSnapshot?: string;           // 放回之前它们的内容
  undo?: boolean;                    // /undo：这个 checkpoint 本身也被取回（打开它的那条输入一起撤销）；没有时是回到 checkpoint，工作从那里继续
  forced?: boolean;                  // 用户选择覆盖系统之外的修改
  externalFiles?: string[];          // 被覆盖的外部修改
}

interface AuthorizationResolved {
  type: 'AuthorizationResolved';
  questionId: string;
  resolution: 'GRANTED' | 'DECLINED' | 'CANCELLED';   // 询问不超时；CANCELLED 只在运行收敛时（M2Design 第 5.3 节）
}

interface HumanRequest {
  type: 'HumanRequest';
  humanRequestId: string;
  kind: 'prompt' | 'ask' | 'confirm' | 'review';   // 后三种是局部询问，不要求静止，不结束这次输入的工作
  attachedAgentRunId?: string;       // 局部询问：发起 ask_user 的 AgentRun；界面据此标明来自哪个 Agent 与任务名
  question?: string;                 // 局部询问：问题文本（≤1000）
  fields?: HumanField[];             // 局部询问：至多 8 个，type 为 'text' | 'textarea' | 'select' | 'multiselect' | 'confirm'
  reviewRef?: ArtifactRef;           // kind = review：要审阅的产物，界面经 readArtifact 展示
}

interface HumanResolved {
  type: 'HumanResolved';
  humanRequestId: string;
  resolution: 'ANSWERED' | 'CANCELLED' | 'WITHDRAWN';   // WITHDRAWN：工作不等用户继续了，开放输入被收回（Orchestration 第 4.4 节）
}

interface MessagePublished {         // message-publish 完成时发出
  type: 'MessagePublished';
  wrapUpReason?: WrapUpReason;      // 回复来自提前收尾的 final-call 时带上；界面在回复后提示
  messageRef: ArtifactRef;           // UserInteraction 经 readArtifact 读取正文
  agentLabel: string;                // ≤80
  kind: 'REPLY' | 'DEGRADED_REPLY';   // DEGRADED_REPLY 的产物是 { reason }，文字由 UserInteraction 生成
}

interface RunStateChanged {
  type: 'RunStateChanged';
  state: 'RUNNING' | 'AWAITING_INPUT' | 'CONVERGING' | 'PAUSING' | 'PAUSED' | 'INTERRUPTING';
  checkpointId?: string;             // 这份工作所属输入的 checkpoint；AWAITING_INPUT 时没有
}

interface ActivityEvent {            // 只用于界面，由 Kernel 依据登记与尝试状态生成
  type: 'ActivityEvent';
  agentRunId: string;
  label: string;                     // 登记时的 display.label
  parentAgentRunId?: string;
  missionId?: string;                // 它所属的任务与上级任务：活动区按任务画树，任务在两段之间休眠时树不变
  parentMissionId?: string;
  standsIn?: true;                   // 代替调用方工作的 Mission（Orchestration D115）：活动区把它画在调用方的位置，用户的话交给它
  phase: ActivityPhase;
  unit?: { unitAttemptId: string; toolName: string; argsSummary: string; state: 'QUEUED' | 'RUNNING' | 'DONE'; fullRef?: ArtifactRef };   // toolName 与 argsSummary 取自 submitUnit 的 display；fullRef 只在 DONE 且预览截断时给出
  retry?: { attempt: number; retryAt: string };   // phase = 'RETRYING' 时必填：第几次技术重试、何时重试（M2Design 第 7.4 节）
  todos?: { total: number; completed: number; current?: string };   // Workflow 经 updateActivity 交来的待办进度，原样转发
  at: string;
}

interface BackgroundJobs {           // 只用于界面：一个任务正在运行的后台命令（Orchestration 6.1），有变化就发
  type: 'BackgroundJobs';
  agentRunId: string;                // 启动它的 AgentRun
  missionId?: string;                // 它的任务；活动区按任务计，任务换了新的一段也还在
  startedAt: string[];               // 每一条开始运行的时刻（转到后台的命令从它开始运行时算）；空数组表示已经没有了
}

type ActivityPhase =
  | 'ASSEMBLING' | 'THINKING' | 'RETRYING' | 'CALLING_TOOL' | 'AWAITING_AUTHORIZATION' | 'QUEUED'
  | 'WAITING_SUBTASKS'               // 调用了 run_subagents，等它的任务
  | 'AWAITING_ANSWER'                // 调用了 ask_user，等答复
  | 'AWAITING_GRANT'                 // 向上级申请更多轮次，等回答（Orchestration D91）
  | 'PAUSED' | 'COMPACTING' | 'WRAPPING_UP'
  | 'SLEEPING'                       // 这一段结束，任务休眠到被唤醒（Orchestration 第 4 节），活动区保留它的一行
  | 'ENDED';

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
  inputCount: number;
  fork?: ForkOrigin;
  interruptedRun?: { label: string };   // 上次进程留在中途的长任务：/recover 从这个 checkpoint 继续
  divergedFiles?: string[];          // 打开时的工作区差异（M2Design 第 2.3 节 Session 第 6 条）
}

interface ForkOrigin {               // 从哪个 Session 分出、那时它有几条输入；checkpoint 取代 Turn 之前写的行是 fromTurnCount
  fromSessionId: string;
  fromInputCount?: number;
  fromTurnCount?: number;
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
    repositoryRoot: string;          // 最后一次工作的文件夹（Kernel 的引用为准）
    here: boolean;                   // 是不是本进程的文件夹；不是的，打开时要用户确认
    title?: string;                  // ≤80
    createdAt: string;
    lastActiveAt: string;
    inputCount: number;
    fork?: ForkOrigin;
  }[];                               // 至多 1000 个                               // 所有未删除的 Session（各个文件夹的），按最后活动时间倒序
}

interface SessionDeleted {
  type: 'SessionDeleted';
  requestId: string;                 // 对应的 deleteSession
  sessionId: string;
  outcome: 'DELETED' | 'FAILED';     // FAILED：Workflow 删除日志失败；Session 引用仍标为已删除，Kernel 照常删除自己的文件，不再出现在列表中
}
```

### 3.4 压缩的通知

运行级事件，属于 `KernelToInteractionEvent`。

```ts
interface ContextCompacted {         // 压缩生效（Workflow 已记入日志）之后发出
  type: 'ContextCompacted';
  trigger: 'AUTO' | 'OVERFLOW' | 'USER';
  summaryRef?: ArtifactRef;          // 界面可以经 readArtifact 展示摘要；只有修剪、没有写摘要时省略
  compactedInputs: number;           // 工作被摘要取代的用户输入数（部分取代的也计入）；只有修剪时为 0
  prunedResults: number;            // 被修剪的工具结果数
}

interface CompactionFailed {
  type: 'CompactionFailed';
  trigger: 'AUTO' | 'OVERFLOW' | 'USER';
  reason: 'NOTHING_TO_COMPACT' | 'BUDGET_INSUFFICIENT' | 'SUMMARY_FAILED' | 'NOT_RECORDED';
}
```

## 4. Schema 强制的约束

| 对象 | 约束 |
|---|---|
| `StartSessionRequest` | `mode = 'FORK'` 时必须有 `fromSessionId`；`mode = 'NEW'` 时不得有 |
| `AuthorizationRequest` | 按 `capability` 取对应变体的字段 |
| 运行内请求 | `sessionId`、`workflowRunId` 必须与 `BoundaryContext` 中的一致 |
| `RunStateChanged` | `state = 'AWAITING_INPUT'` 时不得有 `checkpointId` |
| `ActivityEvent` | `phase = 'RETRYING'` 时必须有 `retry`，其他阶段不得有 |

## 5. 原因码

| 原因码 | 出现位置 | 含义 |
|---|---|---|
| `SESSION_NOT_FOUND` | `SyscallRejected`（`openSession`、`deleteSession`、`startSession` 的 Fork） | 引用不存在或已删除 |
| `WORKSPACE_CHANGE_NOT_CONFIRMED` | `SyscallRejected`（`openSession`） | Session 最后在别的文件夹工作过，请求没有带 `confirmWorkspaceChange: true` |
| `SESSION_IN_USE` | `SyscallRejected`（`deleteSession`、对当前 Session 的 `openSession`） | 不能删除当前打开的 Session；当前 Session 的运行尚未结束时不能在其中开启新的运行 |
| `QUESTION_NOT_PENDING` | `SyscallRejected`（`answerAuthorization`） | 沿用 M1 |
| `HUMAN_REQUEST_NOT_PENDING` | `SyscallRejected`（`answerHuman`） | 请求不存在或已答复 |
| `ARTIFACT_EXPIRED` | `SyscallRejected`（`readArtifact`） | 正文已按保留期回收 |
| `REQUEST_CONFLICT` | `SyscallRejected`（`compactContext`） | 不是 Turn-chat，或运行不处于 AWAITING_INPUT（沿用 M1 的原因码） |
