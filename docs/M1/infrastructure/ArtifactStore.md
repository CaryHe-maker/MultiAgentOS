# MultiAgentOS M1 ArtifactStore

## 1. 定位

ArtifactStore 提供不可变内容存储、完整性与保留原语，Execution 承担管理职责。
长期规划见 [ArtifactStore 架构](../../Architecture/infrastructure/ArtifactStore.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10。

## 2. 写入与发布

- 产物只由 Execution 写入 ArtifactStore，包括执行产物与 Workflow 经 `report-publish` 提交的最终报告。
- 收到 Executor 违规报告时，Execution 隔离该次输出，不发布。
- 报告发布路径见 [Workflow](../module/Workflow.md) 第 9 节。

## 3. 存储位置与保留

- M1 的 ArtifactStore 按运行分目录：`runs/<runId>/artifacts/` 下按 SHA-256 内容寻址保存本运行的产物。
- 产物随运行目录保留，启动清理只删除未完成的临时写入，因此运行记录中的 `reportRef` 在下次启动后仍可解析。
- 写入先落临时文件，复验 SHA-256、size、mediaType 后原子 rename；未完成的写入不形成可用引用。

## 4. 读取

ArtifactStore 不判断访问权限。所有读取经 Execution 解析，Execution 先按产物归属索引检查引用属于
请求所在的 WorkflowRun（见 [Execution](../kernel/Execution.md) 第 3 节）；Executor、Workflow 与
UserInteraction 都不直接访问 ArtifactStore。
