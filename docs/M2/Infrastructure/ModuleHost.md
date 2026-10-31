# MultiAgentOS M2 ModuleHost

> 状态：已评审（阶段 1）。

## 1. 定位

ModuleHost 提供系统装配、就绪与生命周期机制，Supervisor 承担监管与生命周期协调职责（[ModuleHost 架构](../../Architecture/Infrastructure/ModuleHost.md)）。
静态库不作为自主服务或独立生命周期主体；M2 仍是单进程部署。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 一个进程只处理一个运行；运行结束、展示完成后系统关闭 | 一个进程同一时刻打开一个 Session，Session 中的运行先后进行；进程在 `/exit`、`mas run` 完成或停机时关闭 | M2Design 第 2.3 节 |
| 启动前没有进程级的互斥 | 组合根在启动任何模块之前取得实例锁 | M2Design 第 10.1 节 |
| 关闭：全部运行 actor 收敛后关闭 | 关闭：Session 管理收敛当前运行、关闭当前 Session 后再关闭 | M2Design 第 2.6 节 |

模块清单、`LifecyclePort`、生命周期账本、启动超时与迟到完成的规则与 M1 相同，见归档的 [M1 ModuleHost](../../History/M1/Infrastructure/ModuleHost.md) 第 3、4 节。

## 3. 启动

```text
1. 组合根：建立最小诊断、进程保护与 panic 入口；确定本进程的仓库根目录（工作目录或 --repo，取 realpath）；
   取得实例锁（Persistence 第 5.1 节），失败时报错退出；加载并校验系统配置与目录（AgentToolPool）；
   构造全部模块与各通讯主体的 Fabric 客户端，把 Executor 注册表注入 Supervisor；此时不启动任何模块
2. 组合根在 bootMs 总期限内调用 supervisor.start()
3. Supervisor 清空 <dataDir>/tmp/，再驱动 ModuleHost 按依赖启动：
     fabric → artifact-store → persistence → kernel-core → gateway → workflow → user-interaction
   kernel-core 启动时，Execution 完成一次产物回收（ArtifactStore 第 4 节）后才开放服务；此后每小时一次，由 Session 管理触发（Kernel/Interaction 第 5.1 节）
4. 全部就绪且未进入 panic 后，组合根执行已解析的 CLI 命令：交互模式进入 Session 选择或草稿；mas run 发出 startRun
```

## 4. 关闭

```text
UserInteraction → shutdown → Gateway → Core 的 Session 管理
  → 当前运行收敛为 CLOSED（closeReason = ENDED_BY_USER 或 SHUTDOWN），运行级 Outbox 投递完毕
  → 向 Workflow 下达 Session 命令 CLOSE，Workflow 释放 Session 锁并回复
  → Session 级 Outbox 投递完毕（最后一个事件为 SessionClosed）
  → SupervisorPort.shutdown
Supervisor 驱动 ModuleHost：按启动的相反顺序 stop，终止残留子进程，清理临时文件
组合根释放实例锁，决定退出码
```

- 停机（M2Design 第 4.7 节）不走上述流程：组合根执行 M1 的有期限 panic，最后同样释放实例锁。
- 任一模块启动失败时的回滚与退出码与 M1 相同；此时同样释放实例锁。

## 5. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 1：只有 Kernel 能产生外部副作用；Workflow 与 UserInteraction 只写自己命名空间的系统数据 | 架构测试：组合根只把 `SupervisorPort`、`ArtifactStorePort` 与 `kernel-core`、`kernel-execution` 命名空间的 Port 注入 Kernel 核心；Workflow 只得到 `WorkflowGatewayPort` 与 `workflow` 命名空间的 Port，UserInteraction 只得到 `InteractionGatewayPort`；依赖检查禁止 Workflow 与 UserInteraction 导入 ExecutorSet |
| 24：同一个 `dataDir` 至多一个实例 | 集成测试：实例锁在任何模块启动之前取得；启动失败、正常关闭与停机后都释放 |
| 关闭顺序 | 集成测试：`SessionClosed` 是 UserInteraction 收到的最后一个 Session 级事件，之后才停止模块 |

## 6. 阶段

全部内容属于阶段 1。
