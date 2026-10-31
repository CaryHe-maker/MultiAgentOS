# MultiAgentOS M2 接口

> 状态：已评审（阶段 1 的部分）。本目录是 M2 全部跨模块数据结构与 Port 的字段级权威。
> `packages/libraries/contracts` 按本目录实现 Schema 与 Port；二者不一致时以本目录为准，并在同一 PR 中修正代码。

## 1. 文档分工

| 文档 | 权威内容 |
|---|---|
| 本文 | 规范约定、版本规则、标识、通讯主体与路由、Schema 清单 |
| [WorkflowKernel](WorkflowKernel.md) | Workflow 与 Kernel 之间的 syscall 与事件 |
| [InteractionKernel](InteractionKernel.md) | UserInteraction 与 Kernel 之间的请求与事件 |
| `KernelSupervisor.md` | Kernel 核心与 Supervisor 之间的执行请求、取消与执行事实（阶段 2 起） |
| [Persistence](Persistence.md) | 系统数据目录、会话日志的记录格式、各类索引、实例锁 |
| [Definitions](Definitions.md) | Agent、Unit、Tool、Model、Prompt 与模板的定义格式 |
| [SharedContracts](../Library/SharedContracts.md) | 上述类型在 `packages/libraries/contracts` 中的 Schema ID、文件位置与测试 |

文件名按 [Style](../../Style.md) 使用 PascalCase，不含连字符。
本目录出现的每个类型在 SharedContracts 的清单中有且只有一个 Schema ID；发现不一致时以本目录为准。

## 2. 规范约定

### 2.1 沿用 M1 的规则

以下规则与 M1 相同，本目录不重复，权威在归档的 [M1Interface](../../History/M1/M1Interface.md)：

- 记法：第 1.3 节（TypeScript 记法、camelCase、`Id`、`At`、`Ms` 后缀、条件必填字段以联合变体表达）；
- Schema 强制约束的写法：第 1.4 节；本目录新增的约束写在各文档的"Schema 强制的约束"小节中；
- 请求标识与幂等：第 2.3 节；
- correlationId：第 2.4 节，"运行"扩大为"Session"——Gateway 在 `startSession`、`openSession`、`startRun` 时生成并按 `sessionId` 保存；
- 公共值 `ArtifactRef`、`ErrorCategory`、排除规则：第 3.3、3.5 节。

### 2.2 版本规则

1. `schemaName + major` 唯一确定语义；未知 major 必须拒绝。
2. M1 的全部 Schema 为 major 0，已冻结。M2 中语义变化的 Schema 发布 major 1（`.v1`），与 major 0 并存；
   语义不变的 Schema 继续使用 major 0，本目录只列出名称并链接到 M1Interface 的定义。
3. M2 运行时只产生 major 1 的版本（存在 major 1 时）。内置模板 `analyze` 使用 M1 的 Agent 与 Unit 定义，
   它们的输入输出 Schema 仍是 major 0。
4. 阶段 1 之前，major 1 的 Schema 属于草稿，按本目录原地修改；M2 发布时冻结。冻结后的规则同 M1Interface 第 1.2 节。
5. 所有边界数据先经过运行时 Schema 校验；对象一律 `additionalProperties: false`。

## 3. 标识

格式沿用 M1：`<前缀>_<body>`，`body` 匹配 `[A-Za-z0-9][A-Za-z0-9_-]{5,127}`。M1 的全部前缀不变。M2 新增：

| 字段 | 前缀 | 生成者 | body | 说明 |
|---|---|---|---|---|
| `sessionId` | `ses` | Gateway（`startSession`、`startRun`） | ULID | 一个 Session；取代 M1 Envelope 中未使用的 `workSessionId` |
| `turnId` | `trn` | Core | ULID | 一个 Turn |
| `nodeId` | `nod` | Workflow | 节点路径 SHA-256 的前 32 位小写十六进制 | 节点路径见 [M2Design](../M2Design.md) 第 3.2 节 |
| `unitRunId` | `unr` | Workflow | UnitRun 路径 SHA-256 的前 32 位 | 同上 |
| `requestId`（提交 Unit 时） | `req` | Workflow | 提交路径 SHA-256 的前 32 位 | 其他请求的 `requestId` 仍为 ULID |
| `delegationId` | `dlg` | Core | ULID | 一次委派保留（阶段 4） |
| `humanRequestId` | `hrq` | Workflow | 节点 ID 的 body | 一个人类请求，与 HUMAN 节点一一对应 |
| `inputId` | `inp` | UserInteraction | ULID | 一次用户输入；重复提交按它去重（M2Design 第 10.3 节写入规则第 5 条） |
| `commandId` | `scm` | Core | ULID | Kernel 下达给 Workflow 的一条 Session 命令（包括系统级的 `DELETE`） |
| `queryId` | `slq` | Core | ULID | 一次 Session 列表查询 |
| `compactionId` | `cmp` | Core | ULID | 一次上下文压缩（阶段 8，M2Design 第 9.6 节） |

- 由路径派生的 ID：路径按 UTF-8 编码后计算 SHA-256，取前 32 位小写十六进制。可读路径作为同一记录中的 `path` 字段保存。
- `workflowRunId` 在 M1 中由 Gateway 在 `createRun` 时生成；M2 中由 Core 在开启 WorkflowRun 时生成，随该运行的事件信封交给接收方。
- `agentRunId` 仍由 Workflow 生成（ULID），写入日志，重放时从日志读取，因此同样确定。
- `viewId` 不是随机标识，M2 中恒为 `'main'`（[M2Design](../M2Design.md) 第 6.5 节）。

## 4. 通讯主体、地址与路由

通讯主体与 M1 相同（M1Interface 第 2.1 节），Kernel 核心内部改为 Session actor（[Kernel/Interaction](../Kernel/Interaction.md)）。
Fabric 的使用规则不变：每次交互经 Fabric，包装为 `Envelope`，在接收边界按 Schema 校验 payload。

**Envelope 与 BoundaryContext 的变化**（major 1）：

```ts
interface BoundaryContext {
  correlationId: string;
  causationId?: string;
  tenantId: string;            // M2 固定为 'local'
  projectId: string;           // M2 固定为 'local'
  sessionId?: string;          // Session 内的消息必填
  workflowRunId?: string;      // 运行内的消息必填；有它时 sessionId 也必填
}
```

`Envelope` 增加可选字段 `sessionId`，规则同上；M1 Envelope 中保留未用的 `workSessionId` 在 major 1 中删除。

**路由**（只列 M2 新增与改变的部分，其余见 M1Interface 第 2.2 节）：

| schemaName 或地址 | 方式 | 发送方 | 处理方 | 阶段 |
|---|---|---|---|---|
| Workflow 的 syscall（[WorkflowKernel](WorkflowKernel.md) 第 2 节） | request | workflow | gateway | 1 |
| UserInteraction 的请求（[InteractionKernel](InteractionKernel.md) 第 2 节） | request | user-interaction | gateway | 1 |
| 地址 `inbox.workflow`：运行级事件 `kernel.unit.WorkflowInboxEvent.v1`、Session 级事件 `kernel.session.WorkflowSessionEvent.v1`、系统级事件 `kernel.session.WorkflowSystemEvent.v1` | send | kernel-core | workflow | 1 |
| 地址 `inbox.user-interaction`：运行级事件 `kernel.control.InteractionInboxEvent.v1`、Session 级事件 `kernel.session.InteractionSessionEvent.v1`、系统级事件 `kernel.session.InteractionSystemEvent.v1` | send | kernel-core | user-interaction | 1 |
| Kernel 核心与 Supervisor 之间的新消息（`KernelSupervisor.md`） | request / send | kernel-core、supervisor | supervisor、kernel-core | 2、3、5 |

**事件的三个序列**（[M2Design](../M2Design.md) 第 2.6 节）：

```ts
interface RunInboxEvent<T> {           // 运行级事件，取代 M1 的 InboxEvent
  eventId: string;
  sessionId: string;
  workflowRunId: string;
  seq: number;                         // 每个运行、每个接收方从 1 连续递增
  occurredAt: string;
  event: T;
}

interface SessionInboxEvent<T> {       // Session 级事件
  eventId: string;
  sessionId: string;
  seq: number;                         // 每个 Session、每个接收方从 1 连续递增
  occurredAt: string;
  event: T;
}

interface SystemInboxEvent<T> {        // 系统级事件：不属于任何 Session，由 Session 管理发出
  eventId: string;
  seq: number;                         // 每个进程、每个接收方从 1 连续递增
  occurredAt: string;
  event: T;
}
```

接收方按 `eventId` 去重，按各自序列的 `seq` 顺序处理。三个序列对同一接收方共用一个有序发送器，
投递顺序与登记顺序一致（[Fabric](../Infrastructure/Fabric.md) 第 3 节），例如 `SessionOpened` 一定在该 Session 第一个运行的 `RunStart` 之前到达；
接收方不依赖跨序列的 `seq` 比较。

## 5. Schema 清单

只列 M2 新增或升到 major 1 的 Schema；"状态"一栏随文档推进更新。

| Schema | 定义位置 | 阶段 | 状态 |
|---|---|---|---|
| `platform.common.BoundaryContext.v1`、`platform.common.Envelope.v1` | 本文第 4 节 | 1 | 已评审 |
| Workflow 的 syscall 与运行级、Session 级、系统级事件 | [WorkflowKernel](WorkflowKernel.md) | 1 起 | 已评审（阶段 1） |
| UserInteraction 的请求与运行级、Session 级、系统级事件 | [InteractionKernel](InteractionKernel.md) | 1 起 | 已评审（阶段 1） |
| 会话日志记录、Session 列表、Session 引用、实例锁 | [Persistence](Persistence.md) | 1 起 | 已评审（阶段 1） |
| Agent、Model、模板定义的 major 1 | [Definitions](Definitions.md) | 1 起 | 已评审（阶段 1） |
| Kernel 核心与 Supervisor 的消息 | `KernelSupervisor.md` | 2 起 | 未开始 |
| 上下文压缩的请求、事件与日志记录 | [WorkflowKernel](WorkflowKernel.md) 第 2.4、3.4 节；[InteractionKernel](InteractionKernel.md) 第 2.4、3.4 节；[Persistence](Persistence.md) 第 2.2 节 | 8 | 草稿（字段已列出，阶段 8 的文档门中评审） |

## 6. 原因码

M1 的原因码（M1Interface 第 3.4 节）全部保留。M2 新增的原因码以 [M2Design](../M2Design.md) 第 7.5 节为准，
每个原因码出现在哪些位置，在定义它的接口文档中列出。
