# 持久化接口

> 状态：已实现；发布前再与代码核对一次。约定见 [Interface](README.md)。
> 存储机制与写入规则见 [Infrastructure/Persistence](../Infrastructure/Persistence.md)；本文只定义目录、记录格式与 Port。

## 1. 目录

```text
<dataDir>/
  instance.lock/                           实例锁（第 6 节）
  tmp/                                     未完成的写入（M1 原样）
  artifacts/<sha256>                       ArtifactStore 正文（Kernel.Execution）
  kernel-core/session-refs.jsonl           Session 引用（第 4.1 节）
  kernel-core/trusted-instructions.jsonl   项目指令的信任记录（第 4.2 节）
  kernel-core/trusted-web-search.jsonl     允许网页搜索的文件夹（第 4.6 节）
  kernel-core/shutdown-requests.jsonl      谁请求了退出（只供开发者查看，第 4.5 节）
  workflow/session-index.jsonl             Session 列表（第 3 节）
  sessions/<sessionId>/
    session.lock/                          Session 锁（第 6 节）
    workflow/log.v1.jsonl                  会话日志（第 2 节）
    kernel-core/audit.jsonl                Kernel 审计（第 5 节）
    kernel-execution/artifact-owners.jsonl 本 Session 拥有的产物（第 4.3 节）
    kernel-execution/snapshot-index.jsonl  快照索引
    kernel-execution/snapshots/            影子 git 目录
    kernel-execution/quarantine/           隔离目录
```

- 命名空间：`workflow`、`kernel-core`、`kernel-execution`。每个 Owner 只拿到自己命名空间的 Port（M1 的规则，M2 增加 `kernel-execution`）。
- 所有 JSONL 文件每行一条记录，UTF-8，以 `\n` 结尾；只追加，不修改、不删除已写入的行（删除整个 Session 时整个目录一起删除）。

## 2. 会话日志

### 2.1 记录的公共字段

```ts
interface LogRecordBase {
  seq: number;              // 从 1 连续递增；不连续时拒绝打开（M2Design 第 10.3 节）
  at: string;               // 写入时间
  type: LogRecordType;
  workflowRunId?: string;   // 属于某个运行的记录必填
  turnId?: string;          // 属于某个 Turn 的记录必填
}
```

记录的格式版本由文件名中的 `v1` 与 `SESSION_STARTED.formatVersion` 共同表达；未知的 `type` 或未知的 `formatVersion` 一律拒绝打开。

### 2.2 记录类型

只保存结构化字段与产物引用，不保存任何正文（M2Design 第 10.1 节）。

| 类型 | 字段（除公共字段外） |
|---|---|
| `SESSION_STARTED` | `formatVersion: 1`、`repositoryRoot`、`definitionsDigest`、`definitionVersions`（Agent、Unit、Tool、Model、Prompt 与模板的 `id@version` 列表） |
| `WORKFLOW_RUN_STARTED` | `mode`、`templateRef?`（与 `RunStart` 相同：`ORCHESTRATION` 时必填）、`preset`、`initialInput` |
| `WORKFLOW_RUN_ENDED` | `closeReason`（含 `PROCESS_EXITED`、`FORKED`） |
| `TURN_STARTED` | `promptNodeId`、`template?` |
| `TURN_ENDED` | `reason`（含 `PROCESS_EXITED`）、`usage?` |
| `GRAPH_EXTENDED` | `revision`、`source: 'TEMPLATE' \| 'CHAT_GROWTH' \| 'LOOP' \| 'SPAWN'`、`nodes`、`edges` |
| `NODE_STARTED` | `nodeId`、`path` |
| `NODE_RESUMED` | `nodeId`、`call`（`toolCallId`、`delegationId`）：这次派发的调用回来了，节点不再 WAITING；此前调用的结果由唤醒边的前驱的结果推出 |
| `NODE_ENDED` | `nodeId`、`status`、`skipReason?`、`resultRef?`；以后可能增加失败原因（M2Design 第 14.2 节第 8 条） |
| `HUMAN_REQUESTED` | `humanRequestId`、`nodeId`、`kind`；局部询问另有 `attachedAgentRunId`、`question`、`fields`、`reviewRef?` |
| `HUMAN_ANSWERED` | `nodeId`、`humanRequestId?`、`kind`（含 `steer`）、`origin`（`initial`、`requested`；`unrequested`：没有人在等的运行中插话）、`inputId`、`contentRef`、`attachedAgentRunId?`、`redirectedFrom?`（运行中插话的目标已结束、改投父 AgentRun 时为原定目标） |
| `AGENT_RUN_REGISTERED` | `agentRunId`、`nodeId`、`agentRef`、`effort` |
| `AGENT_WRAP_UP` | `agentRunId`、`reason`、`round`：下一次模型调用是最后一次（M2Design 第 7.3 节） |
| `AGENT_RUN_ENDED` | `agentRunId`、`outcome`、`wrapUpReason?` |
| `UNIT_SUBMITTED` | `requestId`、`path`、`agentRunId`、`unitRunId`、`unitRef`、`inputSource`：工具 Unit 为 `{ kind: 'TOOL_CALL', modelTurnRequestId, toolCallId, workflowFields? }`（参数正文在模型调用的输出产物中，`workflowFields` 是 Workflow 填写的字段，如 `baseSha`，以及 `read_output` 的 `fullRef`；内建 Unit 为 `{ kind: 'STRUCTURED', input }`（只含结构化字段与产物引用） |
| `UNIT_COMPLETED` | `requestId`、`status`、`reasonCode?`、`output?`、`outputRef?`（预览）、`fullRef?`（截断时的完整输出，7 天后过期；不进入投影，模型只能经 `read_output` 按 `toolCallId` 分段读取）、`budget` |
| `UNIT_INTERRUPTED` | `requestId`、`reason`：`RECOVERED`（打开 Session 时的修复）、`PAUSED`、`ABORTED` |
| `MODEL_TURN` | `requestId`、`agentRunId`、`outputRef`（模型调用的完整输出，含工具调用参数）、`toolCalls`（名称、`toolCallId`、参数摘要）、`reasoningRef?`、`replayable`（是否可回传思考内容：没有被打断、没有出错，写入时决定）、`usage` |
| `MODEL_ATTEMPT_FAILED` | `requestId`、`reasonCode`；不进入模型历史 |
| `FEEDBACK` | `agentRunId`、`code`、`message`（≤1000，不含模型的参数值）、`toolCallId?`；没有执行的工具调用的回答，或对没有动作的回复的纠正，进入投影 |
| `PROJECT_FILE_LOADED` | `path`、`ref`、`sha256`、`trusted?`；子目录的 `AGENTS.md`另带 `agentRunId`（加载它的投影），超过数量上限时只有 `path`、`agentRunId` 与 `skipped: 'LIMIT'` |
| `REQUEST_CONTEXT` | `agentRunId`、`modelRef`、`thinking`、`toolsDigest`、`runtimeContext`（工作目录、沙盒状态、当前日期）；变化时追加，投影在该位置加入一条运行时上下文条目（M2Design 第 9.2 节） |
| `CONTEXT_ASSEMBLED` | `requestId`、`projectionDigest`、`tokenCount`、`tokenBudget`、`headDigest`（ContextPack 的 system 段、工具定义与模型参数的摘要，压缩的估算用它判断实测值是否可用）、`elidedEntries?`（只在收尾调用的保险去掉条目时出现，为被去掉条目的 `seq`） |
| `TODOS_UPDATED` | `agentRunId`、`source: { modelTurnRequestId, toolCallId }`（待办的正文在模型调用的输出产物中）、`counts: { total, pending, inProgress, done, cancelled }` |
| `TOOL_RESULTS_PRUNED` | `compactionId`、`target`、`items: { requestId, toolCallId, prunedRef, readableRef, omittedBytes }[]`（`prunedRef` 为修剪后的结果，长期保留；`readableRef` 为 `read_output` 可读回的引用：截断过的为 `fullRef`，否则为原预览） |
| `CONTEXT_COMPACTED` | `compactionId`、`target`（`{ kind: 'MAIN' }` 或 `{ kind: 'AGENT_RUN', agentRunId }`）、`fromSeq`、`toSeq`、`keptSeqs`（范围内原样保留的条目的 `seq`：`PINNED` 条目与 Kernel 选出的用户消息，M2Design 第 9.6 节）、`summaryRef`、`summaryInput: { mode: 'PREFIX' \| 'TEXT'; omittedEntries: number }`、`usage` |
| `CONTEXT_COMPACTION_REVOKED` | `compactionId`、`reason: 'TURN_REVERTED'`；只撤销该次压缩的摘要，`TOOL_RESULTS_PRUNED` 不受影响 |
| `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED` | `questionId`、`capability`、资源键摘要、`resolution?`；不进入上下文，重放时不恢复授权 |
| `LOG_TAIL_REPAIRED` | `truncatedBytes` |
| `STALE_UNITS_SETTLED` | `requestIds`、`turnIds`、`workflowRunIds` |
| `WORKSPACE_REVERTED` | `revertedTurnIds`、`forced`、`externalFiles`、`backupSnapshot?` |
| `WORKSPACE_DIVERGED` | `files` |
| `SESSION_FORKED` | `fromSessionId`、`fromSeq` |
| `TODOS_UPDATED` | `agentRunId`、`source: { modelTurnRequestId, toolCallId }`、`counts` |
| `RUN_PAUSED` | 无附加字段 |
| `RUN_RESUMED` | `steerInputId?`（继续时附加了说明；说明本身是 `HUMAN_ANSWERED(kind: steer)`） |
| `RUN_INTERRUPTED` | `reason`（`MEMORY_PRESSURE`、`USER_ABORT`、`TURN_TIMEOUT`、`PAUSE_TIMEOUT`） |
| `LOOP_EXHAUSTED` | 条件边的有界循环用尽时记录（使用者模板，M2ReleasePlan phase 2） |

- M2Design 第 10.2 节的 `UNIT_COMPLETED` 带结构化输出与 ArtifactRef。`UNIT_SUBMITTED` 不复制工具参数，只指向 `MODEL_TURN` 中的工具调用；
  工具调用的参数正文由 `model-call` 的输出产物保存。这样先写日志、再提交（第 10.3 节写入规则第 1、2 条）不需要额外的产物写入。
- `AGENT_RUN_REGISTERED`、`AGENT_RUN_ENDED`、`MODEL_ATTEMPT_FAILED`、`CONTEXT_ASSEMBLED` 是 M2Design 第 10.2 节"Unit"类记录的展开，
  为重放上下文所必需（不变量 7）。

### 2.3 图的节点与边

```ts
interface GraphNodeRecord {
  nodeId: string;
  path: string;                 // <workflowRunId>/<revision>/<名称>#<迭代号>
  name: string;                 // ≤64
  kind: 'AGENT' | 'HUMAN';
  trigger: 'all_success' | 'all_done';
  iteration: number;
  loopId?: string;              // 所属循环；不在循环中时省略
  agentRef?: DefinitionRef;     // AGENT 必填
  goal?: string;                // ≤4000
  inputFrom?: 'HANDOFF';
  output?: boolean;
}

interface GraphEdgeRecord {
  from: string;                 // nodeId
  to: string;                   // nodeId
  kind: 'DEPENDS' | 'CONDITIONAL';
  when?: EdgeCondition;         // Definitions 第 4 节；CONDITIONAL 时必填
}
```

`NODE_ENDED` 另带 `result?`：条件边读取的结构化结果（如 planner 的 `action`），写入日志后重放时不需要读取产物。

## 3. Session 列表

`workflow/session-index.jsonl`，Owner 为 Workflow。每次变化追加一行，读取时每个 `sessionId` 取最后一行。

```ts
interface SessionIndexLine {
  sessionId: string;
  repositoryRoot: string;      // 来自 Kernel 的 Session 命令，只用于按仓库筛选
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  titleRef?: ArtifactRef;
  fork?: { fromSessionId: string; fromTurnCount: number };
  status: 'ACTIVE' | 'DELETED';
}
```

## 4. Kernel 的索引

### 4.1 Session 引用

`kernel-core/session-refs.jsonl`，Owner 为 Kernel.Core，系统级状态（M2Design 第 2.6 节）。

```ts
interface SessionRefLine {
  sessionId: string;
  repositoryRoot: string;      // realpath，由 Kernel 依据本进程的仓库写入
  status: 'ACTIVE' | 'DELETED';
  at: string;
}
```

### 4.2 项目指令的信任记录

`kernel-core/trusted-instructions.jsonl`，Owner 为 Kernel.Core，系统级状态（M2Design 第 9.5 节）。

```ts
interface TrustedInstructionLine {
  repositoryRoot: string;
  path: string;                // 'AGENTS.md'，也可以是子目录中 AGENTS.md 的相对路径
  sha256: string;
  source: 'USER_CONFIRMED' | 'APPROVED_WRITE';
  at: string;
}
```

### 4.3 产物归属

`sessions/<sessionId>/kernel-execution/artifact-owners.jsonl`，Owner 为 Kernel.Execution，Session 级状态。

```ts
interface ArtifactOwnerLine {
  artifactId: string;
  mediaType: string;
  sha256: string;
  size: number;
  retention: 'SESSION' | 'EXPIRING';  // M2Design 第 10.1 节
  source: 'PRODUCED' | 'INHERITED';   // INHERITED：Fork 时从原 Session 继承
  fullOutput?: true;                  // 某次工具调用的完整输出：截断时另存的完整输出，或修剪时为未截断的预览补登的一行；output-read 只接受带此标记的引用
  retainedSince: string;              // 保留期的起点：PRODUCED 为写入时间，INHERITED 沿用原 Session 的登记
  at: string;
}
```

- `EXPIRING` 的正文在 `retainedSince` 之后满 `expiringRetentionDays`（缺省 7 天）即可回收，此后读取一律返回 `ARTIFACT_EXPIRED`，不论正文是否已被删除；`SESSION` 的正文只在没有任何 ACTIVE 的 Session 拥有时回收。
- 只有 Session 引用为 ACTIVE 的 Session 的归属文件参与回收的标记（[Infrastructure/ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节）。

### 4.4 快照索引

`sessions/<sessionId>/kernel-execution/snapshot-index.jsonl`，只追加，最后一行为准：

```ts
type SnapshotIndexLine =
  | { kind: 'TURN_STARTED'; turnId: string; turnSeq: number; viewId: 'main'; startSnapshot?: string; at: string }
  | { kind: 'TURN_ENDED'; turnId: string; endSnapshot?: string;
      changedFiles: { path: string; change: 'ADDED' | 'MODIFIED' | 'DELETED' }[]; at: string }
  | { kind: 'REVERTED'; revertedTurnIds: string[]; forced: boolean; backupSnapshot?: string; at: string };
```

没有 `TURN_ENDED` 的 Turn 是进程退出或停机留下的（M2Design 第 4.6 节）。

### 4.5 退出请求的来源

`kernel-core/shutdown-requests.jsonl`，Owner 为 Kernel.Core，系统级，**只供开发者排查"这段对话为什么结束"**：Kernel 收到 `shutdown` 请求时先追加一行 `{ at, type: 'SHUTDOWN_REQUESTED', source, requestId }`，`source` 为 `EXIT_COMMAND`（`/exit`）、`INTERRUPT_TWICE`（两秒内连按两次 Ctrl+C）、`RUN_FINISHED`（`mas run` 的运行结束）、`EXIT_CODE`（控制台因对话之外的原因要结束，如内存不足的退出码）。它不进入 Session 日志，不发给 Workflow，也不显示给用户：业务层看到的仍然只是运行以 `SHUTDOWN` 关闭。写入失败只报告，不影响退出。

### 4.6 允许网页搜索的文件夹

`kernel-core/trusted-web-search.jsonl`，Owner 为 Kernel.Core，系统级状态（Kernel/Core 5f）。用户对 `web.search` 的询问回答"这个文件夹以后都允许"（`FOLDER`）时追加一行；之后在这个仓库里开始的运行一开始就带着 `web.search` 的条目，不再询问。

```ts
interface TrustedWebSearchLine {
  repositoryRoot: string;      // realpath，由 Kernel 依据本进程的仓库写入
  source: 'USER_CONFIRMED';
  at: string;
}
```

- 它只管 `web.search` 这一项能力：不含 `web.fetch`，不含命令；没有路径，也没有查询内容。
- 每个仓库至多一行（已经记下的不再追加）。启动时读入内存；尾行没写完整时丢弃（与其他追加日志相同）。
- 数据目录里模型运行的命令写不到的位置；撤销：删除这个仓库的行，或整个文件。

## 5. Kernel 审计

`sessions/<sessionId>/kernel-core/audit.jsonl`。条目的公共字段与 M1 相同（M1 Core 第 7 节：`at`、`type` 与相关标识），
增加 `sessionId`；`workflowRunId` 在运行内的条目中必填。M2 新增的条目类型在 Kernel/Core 文档中列出。

## 6. 锁

```ts
interface InstanceLockInfo {      // <dataDir>/instance.lock/owner.json
  pid: number;
  processStartedAt: string;       // 来自 /proc/<pid>/stat，用于识别 pid 复用
  hostname: string;
  version: string;                // MultiAgentOS 版本
  acquiredAt: string;
}

interface SessionLockInfo {       // sessions/<sessionId>/session.lock/owner.json
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
}
```

取得、心跳、过期判定与抢占的规则见 M2Design 第 10.1 节，实现见 [Infrastructure/Persistence](../Infrastructure/Persistence.md)。

## 7. Port

```ts
interface PersistencePort {
  appendLog<T>(namespace: PersistenceNamespace, path: StoragePath): AppendLogPort<T>;
  sessionDirectory(namespace: PersistenceNamespace, sessionId: string): SessionDirectoryPort;
  capabilities(): readonly CapabilityDescriptor[];
}

type PersistenceNamespace = 'workflow' | 'kernel-core' | 'kernel-execution';

type StoragePath =
  | {
      scope: 'SYSTEM';
      file: 'session-index' | 'session-refs' | 'trusted-instructions' | 'trusted-web-search';
    }
  | { scope: 'SESSION'; sessionId: string; file: 'log' | 'audit' | 'artifact-owners' | 'snapshot-index' };

interface AppendLogPort<T> {
  append(record: T): Promise<void>;                       // 写入并 fsync 后才返回
  readAll(): AsyncIterable<T>;                            // 逐行校验 Schema
  repairTail(): Promise<{ truncatedBytes: number }>;      // 截断到最后一个完整换行；没有不完整的行时返回 0
}

interface SessionDirectoryPort {
  create(): Promise<void>;                                // 已存在时失败
  copyLogFrom(fromSessionId: string): Promise<void>;      // Fork：复制整个会话日志
  remove(): Promise<void>;                                // 删除本命名空间在该 Session 下的全部文件
  lock(): Promise<LockResult>;                            // 只在 workflow 命名空间提供：Session 锁
}

interface InstanceLockPort {                              // 只注入组合根
  acquire(): Promise<LockResult>;
  release(): Promise<void>;                               // 可重复调用
}

type LockResult =
  | { outcome: 'ACQUIRED'; release(): Promise<void> }
  | { outcome: 'HELD'; owner: InstanceLockInfo | SessionLockInfo };
```

- `StoragePath` 与命名空间的对应是固定的：`session-index`、`log` 只属于 `workflow`；`session-refs`、`trusted-instructions`、`audit` 只属于 `kernel-core`；
  `artifact-owners`、`snapshot-index` 只属于 `kernel-execution`。组合根只把限定命名空间的 Port 注入对应 Owner，越权调用当场拒绝。
- M1 的 `repository`（按 id 原子覆盖）在 M2 中不再使用；`auditLog` 由 `appendLog` 取代。
