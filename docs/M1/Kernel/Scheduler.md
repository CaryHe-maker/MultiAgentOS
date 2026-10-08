# MultiAgentOS M1 Kernel.Scheduler

## 1. 定位

Scheduler 负责 API 调用机会的分配，只被 Core 调用。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/Module/Kernel.md) §8。

## 2. 职责

- 实现 `SchedulerDuties`（Interaction 3.4）：`acquire(provider)`、`release(grantId)`、`stopGranting()`、`releaseAll()`。
- 经 `ProviderCapacityPort` 取得跨运行的 provider 令牌；M1 为进程内实现，每个 provider 容量为 1。
- 运行状态分块中只记录本运行持有的 `grantId → 令牌`。
- 不维护执行队列，不改变 Unit 的 FIFO 顺序；只有 model-call 经过 Scheduler。
- 不判断额度；`stopGranting()` 之后不再发放机会。

实际 Provider 请求由 Supervisor 管理的 model-call Executor 发起。

## 3. 调用机会的生命周期

每个机会按 `grantId` 只释放一次，`release` 幂等。

| 时机 | 调用 | 位置 |
|---|---|---|
| 申请预留 | `acquire` | Core 处理 `requestReservation`（[Core](Core.md) 5.1） |
| Monitor 拒绝预留 | `release`（释放点 ①） | 同一次 `requestReservation` 内，先于返回拒绝 |
| 结果检查 | `release`（释放点 ②） | Core 结果检查第 ② 步；`STOP_UNCONFIRMED` 除外 |
| 技术重试 | `release`（释放点 ③） | Core 处理 `retryExecution`，在重新 `acquire` 之前 |
| 开始收敛 | `stopGranting` | 收敛第 ① 步；在途机会不收回 |
| 收敛中的执行事实 | `release` | 同释放点 ②，`STOP_UNCONFIRMED` 除外 |
| 完成收敛 | `releaseAll` | 收敛第 ③ 步，归还剩余的全部机会 |

申请预留是原子的：一次 `requestReservation` 要么同时得到调用机会与额度预留，要么两者都不持有。

## 4. M1 不实现

优先级、公平性、抢占、并行 Agent 调度、负载均衡或自适应并发。
