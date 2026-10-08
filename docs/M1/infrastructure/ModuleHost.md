# MultiAgentOS M1 ModuleHost

## 1. 定位

ModuleHost 提供系统装配、就绪与生命周期机制，Supervisor 承担监管与生命周期协调职责。
长期规划见 [ModuleHost 架构](../../Architecture/infrastructure/ModuleHost.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10。

AgentToolPool、ExecutorSet、SharedContracts 是静态库，不作为自主服务或独立生命周期主体。
基础设施独立地位不要求独立进程，M1 采用单进程部署。

## 2. 启动与关闭

- 组合根（`apps/control-plane`）承担引导：先建立 Supervisor 与基础通信，再由 Supervisor
  协调 ModuleHost 按依赖装配并启动各模块，全部就绪后才开放 Gateway。
- Executor 由 Supervisor 装配与回收，不由 ModuleHost 装配；M1 的 Executor 在进程内运行，`rg` 以子进程运行。

- 运行结束后，系统由 Supervisor 按序卸载模块并正常关闭；下次启动从空白运行状态开始，不恢复未完成运行。
- 启动时只清空临时数据，`runs/<runId>/` 保留（见 [Persistence](Persistence.md)）。

```text
UserInteraction 展示完成 → Gateway → Core：请求关闭
Core → Supervisor：协调 ModuleHost 按启动的相反顺序关闭
  停止接收新工作 → 各模块 stop → Persistence 完成写入 → ArtifactStore 关闭 → 通信最后关闭
进程退出；下次启动只清空临时数据，runs/<runId>/ 保留
```

装配顺序与各主体的启动依赖尚待设计，见 [kernel/Interaction](../kernel/Interaction.md) 第 9 节。
