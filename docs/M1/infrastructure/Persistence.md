# MultiAgentOS M1 Persistence

## 1. 定位

Persistence 提供状态存取与持久化机制，ModuleHost 管理其生命周期，各 Owner 保有数据权威。
长期规划见 [Persistence 架构](../../Architecture/infrastructure/Persistence.md)，
M1 实现选择见 [M1TechStack](../M1TechStack.md) §10。

## 2. 运行目录与运行记录

- 运行数据按运行分目录：`runs/<runId>/` 保存运行记录、审计记录与本运行的产物（`artifacts/`，见
  [ArtifactStore](ArtifactStore.md)），启动时**不删除**；启动时只清空临时数据。清理不涉及被分析仓库、配置或凭据。
- AnalysisReport 正文只保存在 ArtifactStore，运行记录只记录 `reportRef`。
- 运行记录分两部分：业务部分（步骤、Round 数、收尾原因）由 Workflow 写入；执行部分（provider 请求次数、
  token 用量与未知消耗、耗时、结束来源、未知效果）与审计记录由 Core 写入。
- 普通日志不记录 Secret、完整 Prompt、源码或工具正文，必要内容使用受控 Artifact 引用。

运行记录与审计的具体格式尚待设计，见 [kernel/Interaction](../kernel/Interaction.md) 第 9 节。
