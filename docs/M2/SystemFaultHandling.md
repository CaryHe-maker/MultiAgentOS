# MultiAgentOS M2 系统故障与停机

> 状态：草稿（阶段 3，待评审）。M1 的异常语义、panic 流程与退出码见归档的 [M1 SystemFaultHandling](../History/M1/SystemFaultHandling.md)，
> 本文只写 M2 的变化。设计以 [M2Design](M2Design.md) 第 4.7、7.7 节为准。

## 1. 相对 M1 的变化

| M1 | M2 | 阶段 |
|---|---|---|
| `STOP_UNCONFIRMED` 记为任务异常，收敛这一个运行 | 系统故障，出现即停机：无法确认停止的执行意味着工作区可能仍在被改动，EXEC 互斥与并发计数无法安全释放 | 3 |
| 停机原因只有故障 | 增加"可恢复的退出"：一次性命令（`mas run`）遇到内存压力的 DANGER 级收敛后以退出码 75 退出，日志完整，下次启动可以恢复 Session；对话不退出，下一条消息开启新的运行（M2Design 第 7.7 节） | 3 |
| 恢复时只修复日志 | 停机后打开 Session：未完成的 Unit 记为 `INTERRUPTED`（原因"上一个进程故障停机"），没有结束快照的 Turn 记为异常结束，与最后一个快照的差异告知用户与 main，不改动文件 | 1、2 |

## 2. 停机流程（`STOP_UNCONFIRMED`）

```text
Supervisor 上报 ExecutionFact(STOP_UNCONFIRMED)
  → Execution 不释放该执行的并发计数与 EXEC 互斥，通知 Core
  → Core：reportSystemFault(kind = 'STOP_UNCONFIRMED', unit, pid?, knownEffects)
      1. 封锁新的请求与执行；对全部残余执行发出取消
      2. 写审计：Unit、进程号、已知效果
      3. 界面：无法确认 <命令摘要> 已停止（进程 <pid>），系统已停止，请检查该进程与工作区
      4. 请求组合根停机；进程以非零退出码退出（M1 的故障退出码），释放实例锁
```

停机时不保证 Workflow 写完日志；恢复见第 1 节第三行。

## 3. 可恢复的退出（内存压力）

```text
Monitor 采样 → MemoryPressure(DANGER) → Core.interrupt(MEMORY_PRESSURE)
  → 全部运行进入 INTERRUPTING，Workflow 以确定性结果收敛，closeRun(INTERRUPTED)
  → 全部运行关闭、日志落盘后：对话（Turn-chat）保持打开，用户的下一条消息开启新的运行；
    一次性命令（`mas run`）按正常停机流程退出，退出码 75
```

| 退出码 | 含义 |
|---|---|
| 0 | 正常退出 |
| 64、130、命令的非零码 | M1 沿用 |
| 70 | 系统故障、配置或引导失败、实例锁被占用（M1 沿用），含 `STOP_UNCONFIRMED` |
| 75 | 一次性命令因内存压力的受控退出，日志完整，可以直接重启并 `/resume` |

收敛超时（运行在宽限期内没有全部关闭）时，不继续等待，按系统故障退出。
