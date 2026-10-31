# MultiAgentOS M2 Kernel.Gateway

> 状态：已评审（阶段 1）。

## 1. 定位

Gateway 是外部 syscall 的唯一入口，负责调用方身份、契约与准入检查；逻辑上独立，M2 与 Kernel 核心同进程。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) 第 4 节。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| `createRun` 时生成 `workflowRunId` 与 `correlationId` | `startSession`、`startRun` 时生成 `sessionId`；`startSession`、`openSession`、`startRun` 时生成 `correlationId`；`workflowRunId` 由 Core 生成 | Interface 第 2.1、3 节 |
| 按 `workflowRunId` 缓存准入状态与 `correlationId` | 按 `sessionId` 缓存 `correlationId`；按 `workflowRunId` 缓存准入状态 | — |
| 九种 syscall | 增加 M2 的 syscall（第 3 节） | Interface 第 4 节 |

职责（身份检查、Schema 校验与无效正文回调、准入封锁、直接返回 `SyscallRejected(issuer = 'GATEWAY')`、不保存 Lease 与额度）与 M1 相同，
见归档的 [M1 Gateway](../../History/M1/Kernel/Gateway.md) 第 2 节。

## 3. 调用方与请求

| 请求 | 允许的 producer | 需要已知的标识 | 阶段 |
|---|---|---|---|
| `registerAgentRun`、`submitUnit`、`endAgentRun`、`closeRun`、`requestHuman`、`readProjectFile` | `workflow` | `sessionId`、`workflowRunId` | 1 |
| `reportSessionCommand`、`reportSessionList` | `workflow` | 无：不属于运行；`commandId`、`queryId` 由 Core 核对（`DELETE` 与列表查询针对的不是打开的 Session） | 1 |
| `updateActivity` | `workflow` | `sessionId`、`workflowRunId` | 2 |
| `reserveDelegation`、`releaseDelegation` | `workflow` | `sessionId`、`workflowRunId` | 4 |
| `startSession`、`startRun` | `user-interaction` | 无 | 1 |
| `openSession`、`listSessions`、`deleteSession`、`shutdown` | `user-interaction` | 无 | 1 |
| `answerAuthorization`、`answerHuman` | `user-interaction` | `sessionId`、`workflowRunId` | 1 |
| `readArtifact` | `user-interaction` | `sessionId` | 1 |
| `undoTurns`、`confirmUndo`、`diffTurns` | `user-interaction` | `sessionId`、`workflowRunId` | 2 |
| `pauseRun`、`resumeRun`、`interruptRun`、`steerRun` | `user-interaction` | `sessionId`、`workflowRunId` | 5 |
| `reportCompactionSource`、`ackCompaction` | `workflow` | `sessionId`、`workflowRunId` | 8 |
| `compactContext` | `user-interaction` | `sessionId`、`workflowRunId` | 8 |

| 检查 | 不通过时的原因码 |
|---|---|
| producer 与请求类型不匹配 | `CALLER_FORBIDDEN` |
| 请求不符合 Schema | `INVALID_REQUEST` |
| 需要已知 `sessionId` 的请求中，`sessionId` 不是当前打开的 Session | `SESSION_NOT_FOUND` |
| `workflowRunId` 不在准入状态缓存中 | `RUN_NOT_FOUND` |
| 准入封锁 | `RUN_BLOCKED`，附 `closeReason` |

## 4. 准入封锁

- Core 在开启运行时推送 `AdmissionProjection(RUNNING)`，此后只由 Core 推送更新，Gateway 只读（与 M1 相同）。
- 运行状态为 CONVERGING 或 CLOSED 时，拒绝 `registerAgentRun`、`submitUnit`、`requestHuman`、`readProjectFile`，返回 `RUN_BLOCKED`；
  其余请求放行，由 Core 按 [Interaction](Interaction.md) 第 6.5 节处理。AWAITING_INPUT 不在 Gateway 封锁，由 Core 判断（`NO_OPEN_TURN`）。
- 封锁在同一运行内设置后不解除；新的运行有新的 `workflowRunId`。

## 5. 不实现

请求速率限制与按分片路由（与 M1 相同）。

## 6. 阶段

第 3 节表格中各行按"阶段"一栏加入，其余内容属于阶段 1。
