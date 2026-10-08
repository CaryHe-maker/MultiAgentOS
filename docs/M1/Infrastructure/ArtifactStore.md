# MultiAgentOS M1 ArtifactStore

## 1. 定位

ArtifactStore 提供不可变内容存储、完整性与保留原语，Execution 承担管理职责。
长期规划见 [ArtifactStore 架构](../../Architecture/Infrastructure/ArtifactStore.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10，Port 见 [M1Interface](../M1Interface.md) 第 10 节。

## 2. 写入与发布

- `ArtifactStorePort` 只注入 Kernel 核心，由 Execution 使用。产物只由 Execution 写入：执行产物、
  Workflow 经 `report-publish` 提交的最终报告（Execution 内建完成）与 RunSummary。
- 收到 Executor 违规报告时，Execution 隔离该次输出，不写入。
- 报告发布路径见 [Workflow](../Module/Workflow.md) 第 10 节与 [Execution](../Kernel/Execution.md) 第 5 节。

## 3. 存储位置与格式

- 按运行分目录：`<dataDir>/runs/<workflowRunId>/artifacts/<sha256>`，内容寻址；`artifactId = 'art_' + sha256`。
- `put(workflowRunId, content, mediaType)`：先写入 `<dataDir>/tmp/`，复验 SHA-256 与 size 后原子 rename；
  同名文件已存在时校验内容相同后直接返回引用。未完成的写入不形成可用引用。
- `mediaType` 记录在 Execution 的归属索引中，与 `ArtifactRef.mediaType` 一致；M1 的五种产物 mediaType 见 M1Interface 6.1。
- `get(workflowRunId, ref)`：读取后复验 SHA-256 与 size，不一致时返回完整性错误，不返回内容。
- 产物随运行目录保留；启动清理只删除 `<dataDir>/tmp/`，因此运行记录中的 `reportRef` 在下次启动后仍可在磁盘上找到。

## 4. 读取

ArtifactStore 不判断访问权限。所有读取经 Execution，Execution 先按产物归属索引检查引用属于请求所在的 WorkflowRun
（[Execution](../Kernel/Execution.md) 第 4 节）；Executor、Workflow 与 UserInteraction 都不直接访问 ArtifactStore。
