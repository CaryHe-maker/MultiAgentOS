# 协议和接口约定

## 唯一事实来源

已实现字段以 `src/multi_agent_os/models.py` 为准。本文件解释字段意图，并列出目标协议的后续扩展；任何跨组件 Schema 改动，都必须在同一个 Pull Request 中更新本文件。

## Plan

`Plan` 是 Planner 的输出，由 Validator 和 Scheduler 消费。

| 字段 | 含义 | 当前状态 |
|---|---|---|
| `goal` | 用户请求的简洁目标 | 已实现 |
| `tasks` | 一个或多个任务卡 | 已实现 |

## TaskCard

| 字段 | 含义 | 规则 |
|---|---|---|
| `id` | 稳定任务标识，例如 `backend.auth` | 小写，且在同一 Plan 中唯一 |
| `title` | 面向人的任务名称 | 必填 |
| `role` | `contract`、`backend`、`frontend` 或 `test` 等职责 | 只描述职责，不授予权限 |
| `inputs` | artifact reference 或输入内容 | 只传递与任务相关的输入 |
| `owned_paths` | 任务允许修改的路径 | 无顺序关系的任务路径重叠会被拒绝 |
| `dependencies` | 必须先成功的任务 ID | 必须存在，且不能形成环 |
| `acceptance` | 证明任务完成的命令或可观察检查 | 实现任务应非空 |
| `budget` | 最大输入和输出 token | 接入 LLM 后由 Scheduler 强制执行 |
| `retry_policy` | 有上限的 retry 设置 | 禁止无限 retry |

示例：

```json
{
  "id": "backend.auth",
  "title": "Implement JWT login endpoint",
  "role": "backend",
  "inputs": ["artifact://contracts/auth.openapi.json@v1"],
  "owned_paths": ["server/**"],
  "dependencies": ["contract.auth"],
  "acceptance": ["pytest tests/auth"],
  "budget": {"max_input_tokens": 8000, "max_output_tokens": 12000},
  "retry_policy": {"max_attempts": 1}
}
```

## 目标接口

下列对象将在当前骨架之后实现，当前还不是可调用 API：

| 对象 | 必须解决的问题 |
|---|---|
| `Contract` | 前后端共享的、有版本的 OpenAPI、JSON Schema 或事件 schema |
| `Artifact` | 含内容 hash 的、不可变 diff、摘要、测试报告、日志或文件快照引用 |
| `WorkerResult` | 任务 ID、最终状态、摘要、artifact reference、token 用量、耗时和阻塞原因 |
| `Policy` | 允许路径、命令、网络域名、并发、预算和需要审批的动作 |
| `Checkpoint` | 输入快照、provider/model、任务状态、artifact reference 和 retry 次数 |

## 兼容性规则

修改被其他组件使用的字段时，必须采用以下之一：向后兼容的可选字段、版本化协议，或在一个 Pull Request 中协同更新所有组件。Worker 不得编造当前 `Contract` 中不存在的 API 字段。
