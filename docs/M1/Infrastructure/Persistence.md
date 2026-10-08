# MultiAgentOS M1 Persistence

## 1. 定位

Persistence 提供状态存取与持久化机制，ModuleHost 管理其生命周期，各 Owner 保有数据权威。
长期规划见 [Persistence 架构](../../Architecture/Infrastructure/Persistence.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10，Port 见 [M1Interface](../M1Interface.md) 第 10 节。

## 2. 系统数据目录

- `dataDir` 由系统配置给出，缺省为 `~/.multiagentos`，必须是绝对路径。`createRun` 时 Core 检查被分析仓库与 `dataDir`
  不互相包含（`REPOSITORY_INVALID`），保证运行前后被分析仓库保持不变。
- 启动时只清空 `<dataDir>/tmp/`；`<dataDir>/runs/` 不删除。清理不涉及被分析仓库、配置或凭据。

```text
<dataDir>/
  tmp/                                  未完成的写入
  runs/<workflowRunId>/
    artifacts/<sha256>                  ArtifactStore（含报告与 RunSummary）
    workflow/<id>.json                  Workflow 的 RepositoryPort（WorkflowRunRecord）
    kernel-core/audit.jsonl             Core 的 AuditLogPort
```

## 3. Port 与写入规则

- `PersistencePort.repository(namespace, workflowRunId)`：按 `id` 读写一条 JSON 记录，写入先落 `tmp/` 再原子 rename。
- `PersistencePort.auditLog(namespace, workflowRunId)`：向 `audit.jsonl` 追加一行 JSON。
- `namespace` 只有 `workflow` 与 `kernel-core`；每个 Owner 只拿到自己命名空间的 Port，不能读写其他 Owner 的记录。
- 事务、Journal 与持久化的 Outbox/Inbox 明确不支持（`platform.persistence` 能力描述为 Unsupported）。

## 4. 运行记录

| 部分 | Owner | 位置 | 内容 |
|---|---|---|---|
| 业务部分 | Workflow | `workflow/<workflowRunId>.json` | `WorkflowRunRecord`（[Workflow](../Module/Workflow.md) 第 13 节） |
| 执行部分 | Core 组装，Execution 写入 | `artifacts/`，由 `runSummaryRef` 指向 | `RunSummary`（M1Interface 第 11 节） |
| 审计 | Core | `kernel-core/audit.jsonl` | [Core](../Kernel/Core.md) 第 7 节 |

AnalysisReport 正文只保存在 ArtifactStore，运行记录只记录 `reportRef`。
普通日志与审计不记录 Secret、完整 Prompt、源码、工具正文或 Lease 内容，必要内容使用受控 Artifact 引用。
