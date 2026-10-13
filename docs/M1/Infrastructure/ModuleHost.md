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
1. 组合根（apps/control-plane）：加载并校验系统配置与目录（AgentToolPool），构造全部模块与各通讯主体的 Fabric 客户端，
   调用 createExecutorRegistry() 并把 Executor 注册表注入 Supervisor；此时不启动任何模块
2. 组合根只调用 supervisor.start()
3. Supervisor 清空 <dataDir>/tmp/，再驱动 ModuleHost 按依赖启动：
     fabric → artifact-store → persistence → kernel-core → gateway → workflow → user-interaction
   fabric 就绪后，ModuleHost.start 的 afterStart 钩子让 Supervisor 注册 SupervisorPort 的处理器，
   处理器已登记但只在全部模块就绪后接受请求；钩子失败同启动失败一样回滚已启动模块
4. 全部就绪后 CLI 开始接收命令；在此之前没有任何请求进入 Gateway
```

Supervisor 是第一个启动、最后一个退出的模块，其余模块的启动与停止都由它驱动 ModuleHost 完成。
组合根只负责构造与注入：Fabric 客户端的身份由组合根固定，Supervisor 不创建其他主体的客户端，也不取得它们的依赖。
kernel-core 在 fabric 之后启动，因此 Supervisor 注册处理器之前不会收到执行请求。

关闭：

```text
UserInteraction → shutdown → Gateway → Core 运行管理
  → 全部运行 actor 收敛为 CLOSED，且 Outbox 投递完毕（Kernel/Interaction 第 7 节）
  → SupervisorPort.shutdown
Supervisor 驱动 ModuleHost：
  1. 按启动的相反顺序 stop：
     user-interaction → workflow → gateway → kernel-core → persistence → artifact-store → fabric
     （user-interaction 与 workflow 先处理完 Inbox 中剩余的事件；gateway 停止后拒绝一切请求；persistence 完成全部写入）
  2. supervisor 终止残留子进程，清理临时文件，最后退出
组合根以 UserInteraction 记录的退出码退出进程；下次启动只清空 <dataDir>/tmp/，<dataDir>/runs/ 保留，不恢复未完成的运行
```

- Executor 由 Supervisor 装配与回收，不由 ModuleHost 装配。
- 任一模块启动失败时，ModuleHost 先停止该失败模块，再按相反顺序停止已启动的模块，系统不开放 Gateway；
  Supervisor 启动失败时组合根确认已启动的模块全部停止后以退出码 70 退出。
- 一个进程只处理一个运行；运行结束、展示完成后系统关闭。
- 各模块的工厂函数、依赖清单与组合根的 `composeSystem` 见 [M1Interface](../M1Interface.md) 第 14 节。

## 3. 生命周期账本

ModuleHost 是机制，不作决定：它记录每个模块的状态并如实返回，是否关闭系统、以什么退出码退出由组合根决定
（[错误、Exception 与系统故障处理](../../SystemFaultHandling.md) 第 3、4 节）。

```text
REGISTERED → STARTING → READY → STOPPING → STOPPED
                 └→ START_FAILED ──────────┘      └→ STOP_FAILED
```

- `LifecyclePort.stop()` 必须可重复调用，并且在 `start()` 之前或中途失败之后调用也安全；它只清理本模块已取得的资源。
- `start()` 或 `afterStart` 钩子失败的模块记为 `START_FAILED`，回滚时同样调用它的 `stop()`。
  回滚干净后可以再次 `start()`。
- `stop()` 结束主机，此后 `start()` 被拒绝；并发与重复的 `stop()` 共用同一次执行。
  `start()` 进行中收到 `stop()` 时，正在启动的模块结束后不再启动后续模块，随即回滚。
- 一个模块停止失败不跳过其余模块。构造时可设置 `stopTimeoutMs`，超时的停止记为 `STOP_FAILED` 并继续；
  组合根取 5000 毫秒。
- `STOP_FAILED` 保留为证据，不重试；只要它存在，`stop()` 就以同一组错误拒绝。
- `ledger()` 返回每个模块的状态与错误。`health()` 只是调用时刻的快照，不通知两次调用之间发生的故障。
