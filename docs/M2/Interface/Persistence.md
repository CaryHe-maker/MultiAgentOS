# 持久化接口

> 状态：草稿（阶段 1 的部分）。约定见 [Interface](README.md)。语义以 [M2Design](../M2Design.md) 第 10 节为准。
> 存储机制与写入规则见 [Infrastructure/Persistence](../Infrastructure/Persistence.md)；本文只定义目录、记录格式与 Port。

## 1. 目录

```text
<dataDir>/
  instance.lock/                           实例锁（第 6 节）
  tmp/                                     未完成的写入（M1 原样）
  artifacts/<sha256>                       ArtifactStore 正文（Kernel.Execution）
  kernel-core/session-refs.jsonl           Session 引用（第 4.1 节）
  kernel-core/trusted-instructions.jsonl   项目指令的信任记录（第 4.2 节）
  workflow/session-index.jsonl             Session 列表（第 3 节）
  sessions/<sessionId>/
    session.lock/                          Session 锁（第 6 节）
    workflow/log.v1.jsonl                  会话日志（第 2 节）
    kernel-core/audit.jsonl                Kernel 审计（第 5 节）
    kernel-execution/artifact-owners.jsonl 本 Session 拥有的产物（第 4.3 节）
    kernel-execution/snapshot-index.jsonl  快照索引（阶段 2）
    kernel-execution/snapshots/            影子 git 目录（阶段 2）
    kernel-execution/quarantine/           隔离目录（阶段 3）
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

| 类型 | 字段（除公共字段外） | 阶段 |
|---|---|---|
| `SESSION_STARTED` | `formatVersion: 1`、`repositoryRoot`、`definitionsDigest`、`definitionVersions`（Agent、Unit、Tool、Model、Prompt 与模板的 `id@version` 列表） | 1 |
| `WORKFLOW_RUN_STARTED` | `mode`、`templateRef?`（与 `RunStart` 相同：`ORCHESTRATION` 时必填）、`preset`、`initialInput` | 1 |
| `WORKFLOW_RUN_ENDED` | `closeReason`（含 `PROCESS_EXITED`、`FORKED`） | 1 |
| `TURN_STARTED` | `promptNodeId`、`template?` | 1 |
| `TURN_ENDED` | `reason`（含 `PROCESS_EXITED`）、`usage?` | 1 |
| `GRAPH_EXTENDED` | `revision`、`source: 'TEMPLATE' \| 'CHAT_GROWTH' \| 'LOOP' \| 'SPAWN'`、`nodes`、`edges` | 1 |
| `NODE_STARTED` | `nodeId`、`path` | 1 |
| `NODE_ENDED` | `nodeId`、`status`、`skipReason?`、`resultRef?` | 1 |
| `HUMAN_REQUESTED` | `humanRequestId`、`nodeId`、`kind` | 1 |
| `HUMAN_ANSWERED` | `nodeId`、`humanRequestId?`、`kind`、`origin`、`inputId`、`contentRef`、`attachedAgentRunId?` | 1 |
| `AGENT_RUN_REGISTERED` | `agentRunId`、`nodeId`、`agentRef`、`effort` | 1 |
| `AGENT_RUN_ENDED` | `agentRunId`、`outcome`、`wrapUpReason?` | 1 |
| `UNIT_SUBMITTED` | `requestId`、`path`、`agentRunId`、`unitRunId`、`unitRef`、`inputSource`：工具 Unit 为 `{ kind: 'TOOL_CALL', modelTurnRequestId, toolCallId, workflowFields? }`（参数正文在模型调用的输出产物中，`workflowFields` 是 Workflow 填写的字段，如 `baseSha`）；内建 Unit 为 `{ kind: 'STRUCTURED', input }`（只含结构化字段与产物引用） | 1 |
| `UNIT_COMPLETED` | `requestId`、`status`、`reasonCode?`、`output?`、`outputRef?`（预览）、`fullRef?`（截断时的完整输出，7 天后过期，不进入上下文）、`budget` | 1 |
| `UNIT_INTERRUPTED` | `requestId`、`reason`（打开 Session 时的修复，或阶段 5 的暂停与中止） | 1 |
| `MODEL_TURN` | `requestId`、`outputRef`（模型调用的完整输出，含工具调用参数）、`toolCalls`（名称、`toolCallId`、参数摘要）、`reasoningRef?`、`replayable`（是否可回传思考内容：没有被打断、没有出错，写入时决定）、`usage` | 1 |
| `MODEL_ATTEMPT_FAILED` | `requestId`、`reasonCode`；不进入模型历史 | 1 |
| `PROJECT_FILE_LOADED` | `path`、`ref`、`sha256`、`trusted?` | 1 |
| `REQUEST_CONTEXT` | `agentRunId`、`modelRef`、`thinking`、`toolsDigest`、`runtimeContext`（工作目录、沙盒状态、当前日期）；变化时追加，投影在该位置加入一条运行时上下文条目（M2Design 第 9.2 节） | 1 |
| `CONTEXT_ASSEMBLED` | `requestId`、`projectionDigest`、`elidedEntries?`（只在收尾调用的保险去掉条目时出现，为被去掉条目的 `seq`） | 1 |
| `CONTEXT_COMPACTED` | `compactionId`、`target`（`{ kind: 'MAIN' }` 或 `{ kind: 'AGENT_RUN', agentRunId }`）、`fromSeq`、`toSeq`、`summaryRef`、`usage` | 8 |
| `CONTEXT_COMPACTION_REVOKED` | `compactionId`、`reason: 'TURN_REVERTED'` | 8（阶段 2 已完成时） |
| `AUTHORIZATION_REQUESTED`、`AUTHORIZATION_DECIDED` | `questionId`、`capability`、资源键摘要、`resolution?`；不进入上下文，重放时不恢复授权 | 1 |
| `LOG_TAIL_REPAIRED` | `truncatedBytes` | 1 |
| `STALE_UNITS_SETTLED` | `requestIds`、`turnIds`、`workflowRunIds` | 1 |
| `WORKSPACE_REVERTED`、`WORKSPACE_DIVERGED`、`SESSION_FORKED` | 见阶段 2 | 2 |
| `RUN_PAUSED`、`RUN_RESUMED`、`RUN_INTERRUPTED` | 见阶段 5 | 5 |
| `LOOP_EXHAUSTED` | 见阶段 7 | 7 |

- M2Design 第 10.2 节的 `UNIT_COMPLETED` 带结构化输出与 ArtifactRef。`UNIT_SUBMITTED` 不复制工具参数，只指向 `MODEL_TURN` 中的工具调用；
  工具调用的参数正文由 `model-call` 的输出产物保存。这样先写日志、再提交（第 10.3 节写入规则第 1、2 条）不需要额外的产物写入。
- `AGENT_RUN_REGISTERED`、`AGENT_RUN_ENDED`、`MODEL_ATTEMPT_FAILED`、`CONTEXT_ASSEMBLED` 是 M2Design 第 10.2 节"Unit"类记录的展开，
  为重放上下文所必需（不变量 7）。

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
  path: 'AGENTS.md';
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
  source: 'PRODUCED' | 'INHERITED';   // INHERITED：Fork 时从原 Session 继承（阶段 2）
  retainedSince: string;              // 保留期的起点：PRODUCED 为写入时间，INHERITED 沿用原 Session 的登记
  at: string;
}
```

- `EXPIRING` 的正文在 `retainedSince` 之后满 `expiringRetentionDays`（缺省 7 天）即可回收；`SESSION` 的正文只在没有任何 ACTIVE 的 Session 拥有时回收。
- 只有 Session 引用为 ACTIVE 的 Session 的归属文件参与回收的标记（[Infrastructure/ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节）。

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
  | { scope: 'SYSTEM'; file: 'session-index' | 'session-refs' | 'trusted-instructions' }
  | { scope: 'SESSION'; sessionId: string; file: 'log' | 'audit' | 'artifact-owners' | 'snapshot-index' };

interface AppendLogPort<T> {
  append(record: T): Promise<void>;                       // 写入并 fsync 后才返回
  readAll(): AsyncIterable<T>;                            // 逐行校验 Schema
  repairTail(): Promise<{ truncatedBytes: number }>;      // 截断到最后一个完整换行；没有不完整的行时返回 0
}

interface SessionDirectoryPort {
  create(): Promise<void>;                                // 已存在时失败
  copyLogFrom(fromSessionId: string): Promise<void>;      // Fork：复制整个会话日志（阶段 2）
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
