# MultiAgentOS M1 Kernel.Gateway

## 1. 定位

Gateway 是外部 syscall 的唯一申请入口，负责准入检查。Gateway 在逻辑上是独立的通讯主体，
只经可序列化的契约把请求交给 Kernel 核心；M1 与 Kernel 核心同进程，是否独立成进程由后续 MVP 决定。
组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §4。

## 2. 职责

- 外部模块申请受保护系统服务、执行能力或提交 Kernel 控制请求时，以 Gateway 为唯一申请入口。
- 确认可信调用身份，校验、规范化请求并建立请求关联，将请求信息移交 Core 的统一控制响应逻辑。
- 处理创建运行请求时生成 `workflowRunId`，随 RunCreated 返回；后续请求以它关联运行。
- 检查准入封锁标志：运行被封锁时拒绝 `registerAgentRun` 与 `submitUnit`，放行 `endAgentRun`、`closeRun` 与取消。
- 准入被拒时直接向调用方返回 AdmissionException，并在契约错误时向 Core 报告。
- 授权与 Lease 裁决交由 Core 负责；Gateway 不保存 Lease 实体、快照或验证缓存，也不持有额度数据。

## 3. 准入封锁

准入封锁由 Core 设置，原因包括 `RUN_TIMEOUT`、`CANCELLED`、`CLOSING`、`VIOLATION`，
在同一 WorkflowRun 内设置后不解除。封锁状态由 Core 推送给 Gateway，Gateway 只读，
Core 处理请求时仍会再次核对。M1 不实现请求速率限制，也不需要按分片路由。
