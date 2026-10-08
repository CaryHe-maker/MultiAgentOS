# MultiAgentOS M1 Kernel.Gateway

## 1. 定位

Gateway 是外部 syscall 的唯一申请入口，负责调用方身份、契约与准入检查。Gateway 是逻辑上独立的通讯主体，
只经 Fabric 把请求以 `GatewayForward` 交给 Kernel 核心；M1 与 Kernel 核心同进程。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) §4。

## 2. 职责

- 提供 `WorkflowGatewayPort` 与 `InteractionGatewayPort` 的服务端（[M1Interface](../M1Interface.md) 4.1）。
  组合根只把前者的存根注入 Workflow、后者的存根注入 UserInteraction。
- 以 `Envelope.producer` 确认调用方身份，按第 3 节检查调用方与请求类型是否匹配。
- 按 Schema 校验请求（`SubmitUnitRequest.input` 先按 `kernel.unit.UnitInput` 校验，Unit 级的精确校验由 Core 完成）。
- 处理 `createRun` 时生成 `workflowRunId` 与 `correlationId`，随 `GatewayForward` 交给 Kernel 核心。
- 按 Core 推送的 `AdmissionProjection` 检查准入封锁（第 4 节）。
- 准入被拒时直接返回 `SyscallRejected(issuer = 'GATEWAY')`，并写入 Gateway 的结构化日志；通过的请求转发 Kernel 核心并原样返回其响应。
- 不保存 Lease、额度数据或运行状态，不根据任何副本做授权裁决。

## 3. 调用方与请求

| requestType | 允许的 producer | 需要 `workflowRunId` 已知 |
|---|---|---|
| `registerAgentRun`、`submitUnit`、`endAgentRun`、`closeRun` | `workflow` | 是 |
| `createRun` | `user-interaction` | 否 |
| `answerAuthorization`、`cancelRun`、`readArtifact` | `user-interaction` | 是 |
| `shutdown` | `user-interaction` | 否 |

| 检查 | 不通过时的原因码 |
|---|---|
| producer 与请求类型不匹配 | `CALLER_FORBIDDEN` |
| 请求不符合 Schema | `INVALID_REQUEST` |
| `workflowRunId` 不在 Gateway 的准入状态缓存中 | `RUN_NOT_FOUND` |
| 准入封锁（第 4 节） | `RUN_BLOCKED`，附 `closeReason` |

## 4. 准入封锁

- Gateway 按 `workflowRunId` 缓存运行的准入状态（`runState`、`closeReason`）。Gateway 在转发 `createRun` 之前把自己生成的
  `workflowRunId` 登记为 RUNNING，`createRun` 被拒时删除；此后只由 Core 推送的 `AdmissionProjection` 更新，Gateway 只读。
- `runState` 不为 RUNNING 时，拒绝 `registerAgentRun` 与 `submitUnit`，返回 `RUN_BLOCKED`；其余请求放行，由 Core 按
  [Interaction](Interaction.md) 4.5 处理。
- Core 处理请求时仍会再次核对运行状态；Gateway 放行后 Core 发现已封锁时，由 Core 返回同样的 `RUN_BLOCKED`（`issuer = 'CORE'`）。
- 封锁在同一 WorkflowRun 内设置后不解除。

## 5. M1 不实现

请求速率限制与按分片路由。
