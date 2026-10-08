# MultiAgentOS M1 Kernel.Gateway

## 1. 定位

Gateway 是外部 syscall 的唯一申请入口，负责准入检查。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §3。

## 2. 职责

- 外部模块申请受保护系统服务、执行能力或提交 Kernel 控制请求时，以 Gateway 为唯一申请入口。
- 确认可信调用身份，校验、规范化请求并建立请求关联，将请求信息移交 Core 的统一控制响应逻辑。
- 检查准入封锁标志：运行被封锁时拒绝 `registerAgentRun` 与 `submitUnit`，放行 `endAgentRun`、`closeRun` 与取消。
- 准入被拒时直接向调用方返回 AdmissionException，并在契约错误时向 Core 报告。
- 授权与 Lease 裁决交由 Core 负责；Gateway 不保存 Lease 实体、快照或验证缓存，也不持有额度数据。

## 3. 准入封锁

准入封锁由 Core 设置，原因包括 `USAGE_LIMIT`、`RUN_TIMEOUT`、`CANCELLED`、`CLOSING`、`VIOLATION`，
在同一 WorkflowRun 内设置后不解除。M1 不实现请求速率限制。
