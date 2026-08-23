# 架构

## MVP 组件

```text
CLI
  -> Planner
  -> Plan Validator
  -> Scheduler
      -> State Store (SQLite)
      -> Worker Runtime (Git worktree + subprocess)
  -> Integrator
  -> Report
```

Orchestrator 管理整个 Run。Worker 不能任意创建子 Worker，也不通过自由格式聊天记录彼此传递信息。

| 组件 | 职责 | 不负责 |
|---|---|---|
| CLI | 接收命令、展示面向人的输出 | 调度策略 |
| Planner | 将目标转成 `Plan`、任务卡和 contract | 修改文件 |
| Validator | 拒绝不合法图、依赖、ownership 和策略输入 | 自动修复 Plan |
| Scheduler | 释放安全的 ready task，并执行预算/并发限制 | 编写任务代码 |
| State Store | 保存 Run、checkpoint 和任务状态 | 模型 Prompt |
| Worker Runtime | 创建隔离 worktree，执行一个已获批任务 | 合并到基准分支 |
| Integrator | 应用已接受的 Worker 改动，并运行质量门 | 静默重定义 contract |
| Reporter | 展示时间、成本、质量、冲突和审批记录 | 修改 Run 状态 |

## 当前已实现

`models.py`、`dag.py`、`store.py` 和 `cli.py` 已实现协议骨架、任务图校验、初始状态创建、SQLite checkpoint 和三个 CLI 命令。Planner、Runtime、Integrator 和真实指标采集仍是后续模块。

## 边界规则

组件之间以版本化结构化对象或 artifact reference 传递数据。组件可以为 artifact 增加证据，但不能重新解释其他组件的角色，也不能静默修改 contract。
