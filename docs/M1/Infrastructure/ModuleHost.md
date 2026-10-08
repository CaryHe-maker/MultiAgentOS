# MultiAgentOS M1 ModuleHost

## 1. 定位

ModuleHost 提供系统装配、就绪与生命周期机制，Supervisor 承担监管与生命周期协调职责。
长期规划见 [ModuleHost 架构](../../Architecture/Infrastructure/ModuleHost.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10。

AgentToolPool、ExecutorSet、SharedContracts 是静态库，不作为自主服务或独立生命周期主体。
基础设施独立地位不要求独立进程，M1 采用单进程部署。

## 2. 启动与关闭

每个模块实现 `LifecyclePort`，`moduleId` 取值见 M1Interface 第 10 节：
`fabric`、`artifact-store`、`persistence`、`supervisor`、`kernel-core`、`gateway`、`workflow`、`user-interaction`。

启动：

```text
1. 组合根（apps/control-plane）：加载并校验系统配置与目录（AgentToolPool），构造全部模块
2. 组合根启动 fabric，再启动 supervisor（清空 <dataDir>/tmp/，取得 Executor 注册表）
3. Supervisor 协调 ModuleHost 按依赖启动：
     artifact-store → persistence → kernel-core → gateway → workflow → user-interaction
4. 全部就绪后 CLI 开始接收命令；在此之前没有任何请求进入 Gateway
```

关闭：

```text
UserInteraction → shutdown → Gateway → Core 运行管理
  → 全部运行 actor 收敛为 CLOSED，且 Outbox 投递完毕（Kernel/Interaction 第 7 节）
  → SupervisorPort.shutdown
Supervisor 协调 ModuleHost：
  1. 按启动的相反顺序 stop：user-interaction → workflow → gateway → kernel-core → persistence → artifact-store
     （user-interaction 与 workflow 先处理完 Inbox 中剩余的事件；gateway 停止后拒绝一切请求；persistence 完成全部写入）
  2. supervisor 终止残留子进程，清理临时文件
  3. fabric 最后关闭
进程退出；下次启动只清空 <dataDir>/tmp/，<dataDir>/runs/ 保留，不恢复未完成的运行
```

- Executor 由 Supervisor 装配与回收，不由 ModuleHost 装配。
- 任一模块启动失败时，已启动的模块按相反顺序停止，系统不开放 Gateway。
- 一个进程只处理一个运行；运行结束、展示完成后系统关闭。
