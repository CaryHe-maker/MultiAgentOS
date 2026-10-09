# MultiAgentOS M1 计划

> 架构衔接说明（2026-10-08）：本文已按三 Module、六组件宏内核与运行 actor 更新。
> Kernel 对外行为见 [Kernel（外部视角）](Module/Kernel.md)，组件职责见 [Kernel/](Kernel/Interaction.md)，
> 跨模块字段见 [M1Interface](M1Interface.md)。各 Module 与 ExecutorSet 的实现进度由 GitHub Issues 跟踪。

## 1. 目标与范围权威

M1 交付一个本地、单用户、单项目、单进程、单活动 Task 的只读仓库分析系统，由 Planner 与 CodeViewer 两个 Agent 单向交接完成。用户提交仓库分析问题后，系统通过受控的概览、搜索与读取路径生成带仓库快照摘要（`snapshotId`）、路径、行范围和 provenance 的结构化报告。M1 的验收平台为 Ubuntu LTS。

本文件是 M1 范围和验收的权威来源。除 M1 外，不定义其他里程碑的范围、排期、接口或完成承诺。任何超出 M1 的能力只作为非目标记录；必须在 M1 完成验收后，依据实测结果另行立项和评审。

M1 的技术选择、允许依赖和明确排除项以 [M1TechStack.md](M1TechStack.md) 为准。

## 2. 必须交付

1. CLI 经 UserInteraction、Kernel 和 Workflow 创建运行、回答授权、终止运行并展示结果。
2. AgentToolPool 提供 [AgentToolPool](Library/AgentToolPool.md) 第 4 节的全部定义：Agent（`planner`、`code-viewer`，含 Round 上限、启动 Unit 与控制动作）、Unit（含受保护能力与 `failurePolicy`）、Tool（UNIT 与 CONTROL 两类）、Model、Prompt；运行开始后固定版本与 digest。
3. Workflow 实现模型返回的解释、Validation、`failurePolicy`、Round 上限、final-call 收尾、交接、来源核验、AnalysisReport 与降级报告，并经 `report-publish` 发布报告。
4. Kernel 六组件按 [Kernel（外部视角）](Module/Kernel.md) 与 [Kernel/](Kernel/Interaction.md) 下的组件文档实现：调用方身份与准入、Lease 与用户授权、token 额度状态与 final-call 保留额度、运行超时、FIFO 执行、运行 actor（不可重入、控制通道优先）与三步收敛、Kernel 核心内部的模块化隔离、经 Core 的技术重试、Supervisor 执行并上报执行事实、结果检查与内存版 Outbox 交付、内建的报告发布、关闭。
5. 上下文与检索 Executor 实现仓库快照、概览、搜索、上下文组装、provenance、稳定前缀、预算和检索评测。
6. Executor 对用户仓库只允许只读访问，并实现硬编码的执行点检查；所有副作用请求确定性拒绝。
7. 三个 Module 与四类基础设施均有公开 Port、默认或 fake adapter、组合位置和边界测试；三个静态库有 contract test。
8. Protocol Registry 覆盖所有已声明协议族；未知 major 被拒绝，未支持能力无副作用。
9. 面向用户的最终报告包含结论、来源和未确认项，提前收尾时注明原因；步骤、Round、调用、token、耗时和失败分类写入运行记录。
10. 固定任务集形成成功率、来源完整性、成本和延迟基线。

## 3. 非目标

M1 不实现文件写入、项目命令、项目测试、任何 git 调用（含 diff/worktree）、Coding Agent、多 Task/DAG、并行 Agent（M1 只做 Planner 与 CodeViewer 单向交接）、动态重规划、崩溃续跑、暂停/恢复、持久审批、AgentRun 级额度、Checkpoint/Restore、Web UI、多租户、远程执行、跨进程 IPC、消息集群、语义向量检索或生产级隔离。相关请求必须返回结构化 Unsupported 结果，不得以占位成功响应代替实现。

## 4. 团队分工

| 代号 | 负责人 | 主责 | 配套责任 |
|---|---|---|---|
| A | Cary | Workflow、UserInteraction 与 CLI | Fabric、ModuleHost、Persistence、ArtifactStore、组合根、`packages/testing`、报告与业务验收 |
| B | field | Kernel（Gateway、Core、Scheduler、Execution、Supervisor、Monitor） | Executor 准入与审计 |
| C | meti | ExecutorSet 与 AgentToolPool | 定义文件、检索评测 |

Shared Contracts 由三人评审。每个 Schema 变更必须同时提交兼容说明、正反例和 contract test。
任务、进度与验证证据由 GitHub Issues 跟踪，每个 Issue 只有一个负责人；完成时在 Issue 中关联 PR 与测试证据。

## 5. 执行计划

### 5.1 契约与可替换骨架

- 按 [SharedContracts](Library/SharedContracts.md) 第 3 节实现并冻结全部 Schema：公共类型与 ReasonCode、Gateway 请求与响应、Inbox 事件（RunStart、UnitReport、RunClosed、AuthorizationRequest、AuthorizationResolved、RunFinished）、Kernel 核心与 Supervisor 的接口（ExecutionRequest、ExecutionFact）、各 Unit 的输入输出、ContextPack、Workflow 结构、Catalog 定义与 RunSummary。
- 建立三个 Module 包、四类基础设施包、三个静态库包、两个 app 及依赖规则。
- 完成 Protocol Registry、Fake Port、架构测试和 Fake 纵向闭环。

退出条件：全仓可构建；协议正反测试通过；UserInteraction 经 Gateway 创建运行、Workflow 收到 RunStart、运行收敛后 Workflow 收到 RunClosed、UserInteraction 收到 RunFinished 的 Fake 链可运行；未支持能力无副作用。

### 5.2 单轮真实只读分析

- 接入一个 Provider；校验结构化 AnalysisAction。
- 完成 repository-orient（快照与授权）、context-assemble、model-call、file-read、report-publish Unit 与 Artifact 输出。
- 生成初版 AnalysisReport；记录预算、调用和执行证据。

退出条件：真实模型完成已知文件分析并引用来源；所有写入、命令和测试请求被拒绝。

### 5.3 多轮检索与证据闭环

- 完成 repository-search、多轮历史、历史裁剪、重复调用与无进展检测。
- 完成未知文件定位、跨文件分析、补充检索和来源一致性校验。
- 贯穿身份、correlation/causation、固定定义（`PinnedDefinitionSet`）和 Artifact。

退出条件：首次证据不足后能够补充检索并形成可复验结论；工作区保持不变。

### 5.4 固定任务与发布验收

- 冻结功能，完成安全、兼容、回归、评测和文档。
- 在 Ubuntu LTS 上运行全部质量门和固定任务。
- 形成限制清单、验收证据和可独立运行的候选版本。

退出条件：第 7 节全部完成条件满足且不存在第 8 节阻断项。

## 6. 固定任务集

| ID | 任务 | 核心验证 |
|---|---|---|
| F1 | 解释已知函数的行为和边界 | 基本闭环 |
| F2 | 根据业务描述定位未知实现与测试 | 检索召回 |
| F3 | 跨两个以上文件解释接口与数据流 | 多轮上下文 |
| F4 | 识别拟议功能涉及的实现、测试和配置位置 | 来源完整性 |
| F5 | 首次证据不足后补充查询并形成结论 | Agent 循环 |

每个 fixture 必须固定仓库内容（由测试工具在运行前准备，产品代码不调用 git）、问题、预期来源、禁止路径、禁止副作用和验收断言；问题不得泄漏答案文件名。

## 7. 完成定义

M1 完成必须同时满足：

- F1–F5 均到达可解释终态；至少一个真实模型运行全部任务并记录指标。
- 所有任务完整经过权威调用链，且运行固定定义版本与 digest。
- ContextPack 和关键结论具有完整来源；无来源的成功结论数量为零。
- 步骤、token、模型调用和时间预算均可确定性终止。
- 写入、命令、测试、网络和 workspace 逃逸成功次数为零。
- 工作区在运行前后保持不变（测试工具在运行前后计算同一快照摘要并比对）。
- 每个 Module/Infrastructure 均有边界、适配器和测试；架构绕行被自动化测试阻止。
- 在 Ubuntu LTS 上，`pnpm run check`、E2E、固定任务集和兼容矩阵全部通过。
- README、索引、接口、限制和运行说明与实现一致。

## 8. 发布阻断项

以下任一情况阻断 M1：绕过 UserInteraction/Kernel/Workflow；Workflow 直连执行组件；模型直接调用工具；定义版本未固定；协议未注册；Unsupported 产生状态变化；副作用执行成功；缺少硬预算；关键结论无来源；ContextPack 无 snapshotId/provenance；模块通过异常字符串协作；无法独立替换或测试适配器；M1Interface、SharedContracts 与 AgentToolPool 不一致。

## 9. 范围控制

范围不足时可减少 fixture 数量至 3、简化检索排序或取消交互界面，但不得削减权威入口、Kernel Unit 路径、定义固定、只读边界、Context provenance、预算、来源验收、运行时 Schema 校验和架构测试。任何新增能力必须先通过 M1 范围变更 PR。
