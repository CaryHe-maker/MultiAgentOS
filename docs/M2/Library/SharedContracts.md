# MultiAgentOS M2 SharedContracts

> 状态：草稿（阶段 1）。

## 1. 定位

SharedContracts 是静态库 `@multiagentos/contracts`，提供全部跨模块 Schema、由 Schema 派生的类型、Port 接口、Protocol Registry 与校验工具。
字段与语义以 [Interface](../Interface/README.md) 为准；本文规定每个类型的 Schema ID、文件与测试。长期规划见 [SharedContracts 架构](../../Architecture/Library/SharedContracts.md)。

## 2. 规则

M1 的规则全部保留（归档的 [M1 SharedContracts](../../History/M1/Library/SharedContracts.md) 第 2 节）：TypeBox、`$id = <family>.<Name>.v<major>`、
条件必填以联合变体表达、类型由 Schema 派生、文件之间无导入环。M2 补充：

- M1 的 major 0 Schema 冻结，原样保留并继续注册；M2 新增或语义变化的 Schema 注册为 major 1，与 major 0 并存（Interface 第 2.2 节）。
- major 1 的 Schema 放在与 major 0 相同的 family 目录中，文件名不带版本；同一文件可以同时导出两个 major。
- 每个阶段的契约门（M2Plan 第 2.2 节）只增加本阶段需要的 Schema；major 1 在 M2 发布前属于草稿，可以原地修改。
- Interface 各文档"Schema 强制的约束"小节中的每一条，都必须由 Schema 强制，并有反例测试。

## 3. Schema 清单（阶段 1）

### 3.1 `platform.common`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `platform.common.BoundaryContext.v1`、`platform.common.Envelope.v1` | `platform-common/common-schemas.ts` | Interface 第 4 节 |
| `platform.common.ExecutionKind.v1` | `platform-common/execution-kind.ts` | Interface/Definitions 第 5 节 |
| `platform.common.ReasonCode.v1` | `platform-common/reason-code.ts` | M1 的全部原因码加上各 Interface 文档第 5 节的新增 |

### 3.2 `kernel.session`（新增）

| Schema ID | 文件 | 定义 |
|---|---|---|
| `kernel.session.WorkflowSessionEvent.v1`（含 `SessionCommand`） | `kernel-session/workflow-session-events.ts` | WorkflowKernel 第 3.2 节 |
| `kernel.session.WorkflowSystemEvent.v1`（含 `SessionListQuery`、`SessionDelete`） | `kernel-session/workflow-session-events.ts` | WorkflowKernel 第 3.3 节 |
| `kernel.session.InteractionSessionEvent.v1`（含 `SessionOpened`、`SessionFailed`、`SessionClosed`） | `kernel-session/interaction-session-events.ts` | InteractionKernel 第 3.2 节 |
| `kernel.session.InteractionSystemEvent.v1`（含 `SessionList`、`SessionDeleted`） | `kernel-session/interaction-session-events.ts` | InteractionKernel 第 3.3 节 |

### 3.3 `kernel.unit`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `kernel.unit.RegisterAgentRunRequest.v1`、`SubmitUnitRequest.v1`、`EndAgentRunRequest.v1`、`CloseRunRequest.v1` | `kernel-unit/workflow-syscalls.ts` | WorkflowKernel 第 2.2 节 |
| `kernel.unit.RequestHumanRequest.v1`、`ReadProjectFileRequest.v1`、`ProjectFileContent.v1` | `kernel-unit/workflow-syscalls.ts` | 同上 |
| `kernel.unit.ReportSessionCommandRequest.v1`、`ReportSessionListRequest.v1` | `kernel-unit/session-replies.ts` | WorkflowKernel 第 2.3 节 |
| `kernel.unit.WorkflowInboxEvent.v1`（含 `RunStart`、`UnitReport`、`HumanAnswered`、`TurnClosed`、`RunClosed`） | `kernel-unit/workflow-events.ts` | WorkflowKernel 第 3.1 节 |
| `kernel.unit.BudgetView.v1`、`kernel.unit.TurnUsage.v1` | `kernel-unit/budget-state.ts` | 同上 |
| `kernel.unit.MessagePublishInput.v1`、`MessagePublishOutput.v1` | `kernel-unit/message-publish.ts` | [Kernel/Execution](../Kernel/Execution.md) 第 5 节 |
| `kernel.unit.UnitInput.v1`、`UnitOutput.v1` | `kernel-unit/unit-io.ts` | 各 Unit 输入输出的联合，增加 `repository-list`、`message-publish` |

### 3.4 `kernel.control`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `kernel.control.CloseReason.v1`、`kernel.control.RunEnd`（嵌套） | `kernel-control/run-outcome.ts` | WorkflowKernel 第 3.1 节 |
| `kernel.control.StartSessionRequest.v1`、`OpenSessionRequest.v1`、`StartRunRequest.v1`、`ListSessionsRequest.v1`、`DeleteSessionRequest.v1` | `kernel-control/session-requests.ts` | InteractionKernel 第 2.2 节 |
| `kernel.control.AnswerAuthorizationRequest.v1`、`AnswerHumanRequest.v1`、`ReadArtifactRequest.v1` | `kernel-control/interaction-requests.ts` | InteractionKernel 第 2.3 节 |
| `kernel.control.SessionAccepted.v1` | `kernel-control/responses.ts` | InteractionKernel 第 2.2 节 |
| `kernel.control.InteractionInboxEvent.v1`（含 `AuthorizationRequest`、`AuthorizationResolved`、`HumanRequest`、`HumanResolved`、`MessagePublished`、`RunStateChanged`、`ActivityEvent`、`RunFinished`） | `kernel-control/interaction-events.ts` | InteractionKernel 第 3.1 节 |
| `kernel.control.GatewayForward.v1` | `kernel-control/gateway-forward.ts` | 增加 M2 的请求类型 |

### 3.5 `executor`、`kernel.execution`、`context`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `executor.RepositoryListInput.v1`、`RepositoryListOutput.v1` | `executor/repository-list.ts` | [ExecutorSet](ExecutorSet.md) 第 5 节 |
| `executor.FileReadOutput.v1` | `executor/file-read.ts` | 增加内容的 SHA-256 |
| `executor.ModelCallInput.v1`、`ModelCallOutput.v1` | `executor/model-call.ts` | 增加 `effort`、`finalMode`；思考内容单独返回；摘要请求（阶段 8）（ExecutorSet 第 7 节） |
| `kernel.execution.AssembleExecutorInput.v1` | `kernel-execution/execution-request.ts` | 增加段（ExecutorSet 第 6.1 节）、条目的 `turnId`、`seq` 与类别（`PINNED`、`NORMAL`） |
| `context.ContextPack.v1` | `context/context-pack.ts` | 增加 `elidedEntries`（只在收尾调用的保险中出现），取代 `elidedRequestIds` |
| `executor.RetentionNotice.v1` | `executor/retention.ts` | 预览的截断说明：策略、单位、上限、保留量、省略量（ExecutorSet 第 4 节） |

### 3.6 `workflow`、`catalog`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `workflow.ReplyArgs.v1` | `workflow/reply.ts` | `{ text }`，1..20000 个字符 |
| `catalog.AgentDefinition.v1`、`ModelDefinition.v1`、`UnitDefinition.v1`、`TemplateDefinition.v1` | `catalog/definition-schemas.ts` | Interface/Definitions |
| `catalog.PinnedDefinitionRef.v1` | `catalog/definition-schemas.ts` | `kind` 增加 `'TEMPLATE'` |

### 3.7 `platform.persistence`

| Schema ID | 文件 | 定义 |
|---|---|---|
| `platform.persistence.SessionLogRecord.v1`（各记录类型的联合） | `platform-persistence/session-log.ts` | Interface/Persistence 第 2 节 |
| `platform.persistence.SessionIndexLine.v1`、`SessionRefLine.v1`、`TrustedInstructionLine.v1`、`ArtifactOwnerLine.v1` | `platform-persistence/indexes.ts` | Interface/Persistence 第 3、4 节 |
| `platform.persistence.InstanceLockInfo.v1`、`SessionLockInfo.v1` | `platform-persistence/locks.ts` | Interface/Persistence 第 6 节 |

### 3.8 Port

`PersistencePort`、`InstanceLockPort`、`ArtifactStorePort`、`WorkflowGatewayPort`、`InteractionGatewayPort` 与两种 Inbox Port 的 M2 形式，
按 Interface 各文档定义，放在 `ports.ts`；M1 的 Port 签名在同一文件中保留到 M2 发布，供 `analyze` 回归使用。

## 4. 测试

- 每个 major 1 Schema 的正例与反例；Interface 各文档"Schema 强制的约束"的每一条都有反例（`kernel-protocol.test.ts` 的做法）。
- major 0 与 major 1 并存：同名 Schema 两个 major 都能注册与解析，未知 major 被拒绝。
- 由路径派生的 ID：`requestId`、`nodeId`、`unitRunId` 的 body 等于路径 SHA-256 的前 32 位（属性测试）。
- 协议快照守卫（M1 的做法）覆盖 major 0 与 major 1；major 0 的快照不允许改变。

## 5. 阶段

本文第 3 节为阶段 1 的清单；后续阶段的 Schema 在各自的契约门中加入本文。
阶段 8 加入压缩相关的类型：`CompactionSourceQuery`、`ContextCompacted`、`CompactionFailed`（运行级事件）、`ReportCompactionSourceRequest`、`AckCompactionRequest`、`CompactContextRequest`，
以及日志记录 `CONTEXT_COMPACTED`、`CONTEXT_COMPACTION_REVOKED`（Interface/WorkflowKernel 第 3.4 节、InteractionKernel、Persistence 第 2.2 节）。
