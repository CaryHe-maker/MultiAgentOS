# MultiAgentOS M1 ArtifactStore

## 1. 定位

ArtifactStore 提供不可变内容存储、完整性与保留原语，Execution 承担管理职责。
长期规划见 [ArtifactStore 架构](../../Architecture/infrastructure/ArtifactStore.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10。

## 2. 写入与发布

- 产物只由 Execution 写入 ArtifactStore，包括执行产物与 Workflow 经 `report-publish` 提交的最终报告。
- 收到 Executor 违规报告时，Execution 隔离该次输出，不发布。
- 报告发布路径见 [Workflow](../module/Workflow.md) 第 9 节。
