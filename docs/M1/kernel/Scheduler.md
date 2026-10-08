# MultiAgentOS M1 Kernel.Scheduler

## 1. 定位

Scheduler 负责 API 调用机会的分配，只被 Core 调用。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §8。

## 2. 职责

- 由 Core 调用：根据固定定义与可用状态匹配 API 调用目标，分配与释放调用机会（M1 每个 provider 并发为 1）。
- 不维护执行队列，不改变 Unit FIFO 顺序；非 API 步骤不经过 Scheduler。
- 不判断额度；停止或取消后不再发放机会。

实际 Provider 请求由 Supervisor 管理的 model-call Executor 发起，Execution 维护相应执行状态。
调用机会以“申请令牌、归还令牌”的接口提供，M1 为进程内实现；后续多实例部署时可替换为全局容量服务。

## 3. M1 不实现

优先级、公平性、抢占、并行 Agent 调度、负载均衡或自适应并发。
