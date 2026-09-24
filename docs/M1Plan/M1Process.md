# MultiAgentOS M1 完成表

> 文档类型：M1 执行进度账本<br>
> 状态日期：2026-09-24<br>
> 范围权威：`docs/M1Plan/TargetM1.md`<br>
> 顺序与分工：`docs/M1Plan/M1AchievePlan.md`<br>
> 需求基线：`docs/Requirements/M1RequirementsSpecification.md`

## 1. 更新规则

- 本文是 M1 唯一完成表，不替代目标设计或需求规格。
- 任务按 `S0 → S1 → S2 → S3 → S4 → S5` 推进；阶段内可以并行，退出条件未满足不得将阶段标记完成。
- 状态只允许 `⬜ 未开始`、`🟨 进行中`、`✅ 已完成`、`⛔ 阻塞`。
- 只有实现、自动化测试和证据同时存在时才可标记完成；接口、TODO、人工口头确认和假成功不算完成。
- 每完成一项，必须在同一提交或 PR 更新状态、日期和证据。范围变化须先更新 `TargetM1.md` 和 SRS。

## 2. 阶段总览

| 阶段 | 目标 | 状态 | 退出条件 |
|---|---|---|---|
| S0 | 工程基线与协议治理 | 🟨 进行中 | 质量门、协议注册、兼容矩阵、依赖规则全部通过 |
| S1 | 架构骨架与 Fake 纵向闭环 | 🟨 进行中 | 五 Module、五 Infrastructure、Executor 和完整 Fake 环可验证 |
| S2 | 真实模型与单轮只读分析 | ⬜ 未开始 | 真实 Provider 经 Kernel 使用只读工具并输出来源化结论 |
| S3 | 多轮 Agent 与陌生仓库分析 | ⬜ 未开始 | 未知文件定位、补充检索和分析报告验收闭环 |
| S4 | 固定任务集与安全加固 | ⬜ 未开始 | F1–F5、边界测试、报告和兼容矩阵通过 |
| S5 | M1 发布验收 | ⬜ 未开始 | 全部 AC、发布门、文档和 main 合并条件满足 |

## 3. 顺序任务

### S0：工程基线与协议治理

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S0-01 | 固定 Node.js、pnpm、TypeScript、workspace、lockfile 和精确依赖 | ✅ 已完成 | 2026-09-23 | 根配置、`M1DependencyBaseline.md` |
| M1-S0-02 | 建立 build、format、lint、typecheck、test 统一质量门 | ✅ 已完成 | 2026-09-23 | `pnpm.cmd run check` |
| M1-S0-03 | 定义 Envelope、typed ID/Ref、Error、Artifact、Workspace、Capability schema | ✅ 已完成 | 2026-09-23 | `packages/contracts/src/schemas.ts` |
| M1-S0-04 | 定义 Interaction、Workflow、Kernel、Context、Catalog 的 M1 schema | 🟨 进行中 | 2026-09-24 | Intent 判别联合、BoundaryContext、WorkflowRunView 已完成；AnalysisAction、Observation、AnalysisReport 待补 |
| M1-S0-05 | Protocol Registry 覆盖全部协议族并拒绝重复协议/未知 major | ✅ 已完成 | 2026-09-23 | Registry 与 contract tests |
| M1-S0-06 | 后续协议只预留 owner、opaque Ref、capability 和 Unsupported 语义 | ✅ 已完成 | 2026-09-24 | 已移除未经用例验证的未来完整 Port；完整 Port 在对应里程碑定义 |
| M1-S0-07 | producer/consumer fixture 与同 major 前后兼容矩阵 | 🟨 进行中 | - | 已有正反/未知 major；完整 fixture matrix 待补 |
| M1-S0-08 | 自动化架构规则阻止跨模块绕行 | 🟨 进行中 | 2026-09-24 | 已覆盖入口文件与 manifest；完整源码依赖图、BoundaryContext 和异步 Envelope 规则待补 |

### S1：架构骨架与 Fake 纵向闭环

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S1-01 | 建立五 Module、五 Infrastructure、三个 app 的 package/build 边界 | ✅ 已完成 | 2026-09-23 | 全仓 typecheck |
| M1-S1-02 | Module Host 注册、依赖排序、start/stop/health | ✅ 已完成 | 2026-09-23 | Module Host tests |
| M1-S1-03 | 进程内 Router；可靠投递/offset 明确 Unsupported | ✅ 已完成 | 2026-09-23 | Communication tests/capability |
| M1-S1-04 | 文件 Repository 原子替换；事务/Journal/Outbox/Inbox Unsupported | ✅ 已完成 | 2026-09-23 | Persistence tests/capability |
| M1-S1-05 | 内容寻址 Artifact Store 与 hash/size 完整性 | ✅ 已完成 | 2026-09-23 | Artifact integrity tests |
| M1-S1-06 | 内置 Agent/Model/Tool/Prompt/Contract DefinitionVersion 与 digest | ✅ 已完成 | 2026-09-23 | Catalog tests |
| M1-S1-07 | WorkSession、SessionTreeNode、PromptRevision、UserIntent | 🟨 进行中 | - | 身份与意图已有；不可变领域记录/持久化待补 |
| M1-S1-08 | KernelControlPort 准入、路由、Kernel-owned RuntimeProjection | 🟨 进行中 | 2026-09-24 | Kernel 已从 WorkflowRunView 生成投影；领域事件与执行状态汇总待补 |
| M1-S1-09 | WorkflowRun、GraphRevision、MissionScope、Task/Attempt、AgentRun/Step 与 reducer | 🟨 进行中 | - | Run/Revision/预算骨架已有；完整领域对象待补 |
| M1-S1-10 | M1 TaskGraph validator：恰好一个 Task、零 Edge | ⬜ 未开始 | - | - |
| M1-S1-11 | Unit 准入顺序、UnitAttempt 审计和结构化 UnitResult | 🟨 进行中 | - | schema/deadline/workspace/Context 路由已有 |
| M1-S1-12 | 安全 FILE_READ：workspace、绝对路径、`..`、symlink/junction、超时与输出上限 | 🟨 进行中 | 2026-09-24 | 路径、Windows junction、超时、输出上限与 M2 副作用拒绝已有测试；进程级调用来源验证待补 |
| M1-S1-13 | 只读 workspace revision 固定、写入拒绝和原仓库不变检查 | ⬜ 未开始 | - | worktree 与写入下移 M2 |
| M1-S1-14 | Context 文件树、ignore、文本/路径/符号检索、RepositorySnapshot | 🟨 进行中 | - | 文件树/ignore/文本已有；`rg`/符号/Snapshot 待补 |
| M1-S1-15 | ContextPack 分块、去重、token 裁剪、revision、provenance | 🟨 进行中 | - | 裁剪/revision/provenance 已有；分块/去重待补 |
| M1-S1-16 | FakeContext、FakeKernel 和主要 Port shared contract harness | 🟨 进行中 | - | FakeContext/RecordingKernel 已有，其余待补 |
| M1-S1-17 | UserInteraction → Kernel → Workflow → RuntimeProjection Fake 链 | ✅ 已完成 | 2026-09-23 | `runtime.test.ts` |
| M1-S1-18 | Workflow → UnitIntent → Kernel → Context/Executor → Result → Workflow 完整 Fake 环 | ⬜ 未开始 | - | Kernel → Context 局部路径已有 |

### S2：真实模型与单轮只读分析

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S2-01 | 定义并校验 QUERY/SEARCH/READ/FINAL AnalysisAction | ⬜ 未开始 | - | - |
| M1-S2-02 | 接入一个真实模型 Provider，SDK 错误映射 ModuleError | ⬜ 未开始 | - | - |
| M1-S2-03 | 按固定 Analysis Agent DefinitionVersion 组装 prompt、ContextPack、Observation | ⬜ 未开始 | - | - |
| M1-S2-04 | MODEL Unit、输出 schema、token/调用/耗时统计 | ⬜ 未开始 | - | - |
| M1-S2-05 | FILE_READ Unit、只读策略、超时和输出截断；写/命令/测试确定性 Unsupported | ✅ 已完成 | 2026-09-24 | `executor.test.ts` 覆盖读取、路径逃逸、junction、限额、deadline 与副作用拒绝 |
| M1-S2-06 | 只读 Executor adapter 接入 Kernel composition root | ✅ 已完成 | 2026-09-24 | Control Plane 使用 `LocalReadExecutor`；runtime test 证明请求到达真实 adapter |
| M1-S2-07 | 单轮 CONTEXT → MODEL → QUERY/READ → OBSERVATION/FINAL reducer | ⬜ 未开始 | - | - |
| M1-S2-08 | 步数、token、模型调用、wall-clock 预算确定性停止 | 🟨 进行中 | - | 配置已有；扣减/停止待补 |
| M1-S2-09 | 初版 AnalysisReport、来源审计和失败分类 | ⬜ 未开始 | - | - |
| M1-S2-10 | 真实模型完成已知相关文件的单轮分析并引用证据 | ⬜ 未开始 | - | - |

### S3：多轮 Agent 与陌生仓库分析

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S3-01 | 多轮 Agent loop、Observation 历史和压缩 | ⬜ 未开始 | - | - |
| M1-S3-02 | 按 objective/query/未确认项/历史 Observation 增量检索 | ⬜ 未开始 | - | - |
| M1-S3-03 | 非法、空、重复 Action 与无进展检测 | ⬜ 未开始 | - | - |
| M1-S3-04 | 证据不足时继续检索，证据满足时进入完成候选 | ⬜ 未开始 | - | - |
| M1-S3-05 | AnalysisReport、source evidence Artifact、结论引用一致性校验 | ⬜ 未开始 | - | - |
| M1-S3-06 | 进程内 cancel 或按 M1 降级规则明确延期 | ⬜ 未开始 | - | - |
| M1-S3-07 | 全步骤贯穿身份、correlation/causation、DefinitionVersion | ⬜ 未开始 | - | - |
| M1-S3-08 | 完成未知目标文件的实现/调用/测试定位分析 | ⬜ 未开始 | - | - |
| M1-S3-09 | 完成“首次证据不足 → 补充查询 → 形成可复验结论” | ⬜ 未开始 | - | - |

### S4：固定任务集与安全加固

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S4-01 | 建立 F1–F5 只读分析 fixture、问题、禁区、预期来源和验收断言 | ⬜ 未开始 | - | - |
| M1-S4-02 | F1–F5 回归并记录成功率、步骤、token、耗时、失败 | ⬜ 未开始 | - | - |
| M1-S4-03 | Windows 路径、junction、只读边界、超时和输出专项测试 | ⬜ 未开始 | - | - |
| M1-S4-04 | Artifact/输出大小和敏感字段脱敏测试 | ⬜ 未开始 | - | - |
| M1-S4-05 | 所有 Port 的 shared contract 和 adapter 替换测试 | ⬜ 未开始 | - | - |
| M1-S4-06 | 旧 fixture、新 reader、未知 major、opaque Ref、Unsupported 兼容矩阵 | ⬜ 未开始 | - | - |
| M1-S4-07 | 架构绕行、无来源结论、写入请求、模型直调工具等负向测试 | 🟨 进行中 | - | 依赖绕行/部分 Unsupported 已覆盖 |
| M1-S4-08 | 统一报告：结论、来源、未确认项、步骤、调用、用量、耗时、失败 | ⬜ 未开始 | - | - |
| M1-S4-09 | M1 限制、M2 durable state 清单和 ADR backlog | ⬜ 未开始 | - | - |

### S5：M1 发布验收

| ID | 任务 | 状态 | 日期 | 证据/剩余工作 |
|---|---|---|---|---|
| M1-S5-01 | 每个 FR/NFR/AC 映射到测试、Artifact、报告或审查 | ⬜ 未开始 | - | - |
| M1-S5-02 | 运行全质量门、E2E、固定任务集和 Windows 专项套件 | ⬜ 未开始 | - | - |
| M1-S5-03 | 证明仓库未变并交付可复验的来源化 AnalysisReport | ⬜ 未开始 | - | - |
| M1-S5-04 | 至少一个真实模型成功完成简单 repository analysis task | ⬜ 未开始 | - | - |
| M1-S5-05 | 复核所有 M1 发布阻断条件均不存在 | ⬜ 未开始 | - | - |
| M1-S5-06 | 更新 README、运行手册、协议、限制和 M2 handoff | ⬜ 未开始 | - | - |
| M1-S5-07 | 形成可独立运行的发布候选并满足合并 `main` 条件 | ⬜ 未开始 | - | - |

## 4. 当前验证快照

| 日期 | 分支 | 质量门 | 结果 | 说明 |
|---|---|---|---|---|
| 2026-09-23 | `feat/M1` working tree | `pnpm.cmd run check` | ✅ 10 个测试文件、20 个测试通过 | 修改前基线；覆盖基础协议、Infrastructure、Context、Executor、纵向装配与依赖边界，不代表完整 M1 验收 |
| 2026-09-24 | `feat/M1` working tree | `pnpm.cmd run check` | ✅ 10 个测试文件、22 个测试通过 | 版本/边界统一后快照；format、lint、typecheck 与测试全部通过，仍不代表完整 M1 验收 |

## 5. 阶段退出签字

| 阶段 | 功能负责人 | 架构/协议负责人 | 测试负责人 | 状态 | 发布证据 |
|---|---|---|---|---|---|
| S0 | - | - | - | 🟨 进行中 | - |
| S1 | - | - | - | 🟨 进行中 | - |
| S2 | - | - | - | ⬜ 未开始 | - |
| S3 | - | - | - | ⬜ 未开始 | - |
| S4 | - | - | - | ⬜ 未开始 | - |
| S5 | - | - | - | ⬜ 未开始 | - |
