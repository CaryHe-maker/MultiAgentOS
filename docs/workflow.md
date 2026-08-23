# Run 工作流

## 生命周期

```text
goal
  -> plan
  -> 静态校验
  -> 审批（需要时）
  -> 调度 ready task
  -> 执行隔离 Worker
  -> 集成
  -> 质量门
  -> report
```

## 状态模型

| 状态 | 含义 | 后续状态 |
|---|---|---|
| `pending` | 等待依赖 | `ready`、`blocked`、`cancelled` |
| `ready` | 依赖已通过，资源可用 | `running`、`cancelled` |
| `running` | Worker 持有有效 lease | `succeeded`、`failed`、`blocked`、`cancelled` |
| `succeeded` | 验收证据通过 | 不再执行 Worker retry |
| `failed` | Worker 或质量门失败 | retry 允许时进入 `ready`，否则 `blocked` |
| `blocked` | 需要决策、审批或修复不可恢复依赖 | `ready`、`cancelled` |
| `cancelled` | 被明确停止 | 终止状态 |

当前代码只持久化初始 `ready` 和 `pending` 状态。后续实现必须在发起下一项副作用前，持久化每次状态变化。

## 并行规则

两个任务只有同时满足以下条件，才可以并行：

1. 两者均不存在未满足依赖。
2. 两者的 `owned_paths` 不重叠。
3. 两者均不使用已声明的串行资源，例如数据库迁移或 lockfile。
4. Run 有足够的并发和 token 预算。
5. 两者的命令均被 Policy 允许。

任何条件不明确时，使用串行执行。串行是正确的 Scheduler 决策，不是系统失败。

## 质量门

Worker 自称完成，并不表示实现任务完成。Integrator 收集 lint、类型检查、单测、contract test 和端到端测试等已声明的证据。质量门失败时，系统创建有次数上限的修复任务，或请求人工介入。
