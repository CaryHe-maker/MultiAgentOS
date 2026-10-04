# MultiAgentOS 运行实例

以下场景说明当前架构的协作方式，不固定调用接口或执行步骤。

## 1. 启动与创建运行

ModuleHost 在 Supervisor 管辖下完成装配与基础设施就绪，
各 Owner 恢复必要状态后才开放对应能力。
静态库参与定义和行为装配，不作为独立 Module 启动。

用户经 UserInteraction 提交目标，外部 syscall 进入 Gateway。
Kernel 协调 Workflow 建立业务运行与范围；Workflow 依据 AgentToolPool 模板创建 AgentRun，
并固定本次运行采用的定义。受理回执与后续运行结果分开交付。

## 2. 仓库分析与上下文

已知文件的读取、未知位置的搜索以及跨文件关系分析，
由 Workflow 按业务需求形成 Unit 并提交 Gateway。
Core 完成相应准入判断，Scheduler 安排执行，Execution 调用 ExecutorSet 中的具体行为。

模型可见搜索属于执行能力。上下文组装、检索、压缩与去重同样由 Executor 完成，
不存在独立 ContextEngine Module。
Execution 维护需要保留的检索台账与上下文运行关联，ContextPack 等大对象进入 ArtifactStore。
范围和来源约束贯穿搜索、组装及结果交付，不能由已找到内容反推有权读取。

## 3. Agent 与 Unit 循环

Workflow 根据当前业务状态选择下一步 Unit，不固定为某一种循环长度。
Tool 封装存在时，Core 根据授权和私有 Lease 作出判断；
没有 Tool 的行为以受信定义中的开发者授权为基础，不能由模型自行选择绕过检查。

需要人类授权时，经 UserInteraction 收集回答，由 Core 判断其有效性。
后续请求可由 Core 判断是否复用已有 Lease，Gateway 与 Workflow 不保存 Lease 内容。

获准工作进入调度与执行。Execution 报告用量、结果与故障，
Monitor 维护资源事实，Kernel 对外交付结果，Workflow 决定下一步业务动作。
执行产物可以通过引用交付，必要结构化结果也可以直接随结果提供。

## 4. 并行、模型调用与集成

Workflow 决定可并行任务和汇合条件，Scheduler 在资源与控制约束下安排执行。
模型与工具的实际调用由 Execution 管理，API 资源的可用性、安排和消耗
分别由相应 Kernel 职责协作维护，不能把请求结束直接当作资源已正确结算。

编码任务产生候选变更与验证证据。Workflow 决定验收和集成顺序，
冲突或验收失败形成新的业务决定，不由 Scheduler 擅自改写计划。
迟到结果只关联原有尝试，不能覆盖已重规划的任务。

## 5. 业务变化与人类参与

用户可以补充信息、修改目标、回答权限申请或验收结果。
UserInteraction 将操作交给 Gateway，Kernel 与 Workflow 按权限和业务职责处理。

目标变化时，Workflow 维护计划修订与任务关系，Kernel 协调受影响执行的控制。
已经发生的外部效果不会因修改计划而消失；
需要补偿时形成新的受控工作。旧审核回答不能自动作用于新的目标或范围。

## 6. 保存与恢复

保存 SessionCheckpoint 时，Workflow 组织业务状态与产物关联，
相应 Owner 保存必要运行事实，ArtifactStore 执行保留要求。
保存成功应代表约定内容可用于后续核对，不能仅凭会话展示已保存作出判断。

从检查点继续或派生运行时，先确认定义兼容、对象可用、作用范围和当前权限，
再核对执行中的未知效果。旧 Lease 不因检查点而成为可外部读取或永久有效的授权。
缺失内容或不兼容状态需要显式处理。

## 7. 暂停、中止与异常

控制请求经 Gateway 进入 Kernel，Core 协调 Scheduler 与 Execution 改变运行状态。
已受理中止不代表所有效果已经停止；Execution 报告可确认的终态与仍未知的部分。

普通执行失败形成可解释结果，由 Workflow 决定业务重试或调整。
越权绕过受保护入口、直接读写 Core 的 Lease 或破坏安全不变量时，
Kernel 拒绝操作并按 panic 规则进入安全处置。
可信监控事实按约定通道报告，不因未经过 Gateway 而被当作越权调用。

## 8. 故障、重连与最终交付

Supervisor 协调故障处置，ModuleHost 管理生命周期。
恢复先核对权威状态和外部效果，避免把断连当作未执行而重复产生效果。
UserInteraction 重连后查询正式状态，流式展示缺失不改变执行结论。

Execution 完成执行、Kernel 接受相关结果、Workflow 完成业务验收后，
UserInteraction 展示最终交付。完整正文可以从 ArtifactStore 的受控入口读取。
最终报告不能绕过正常的权限和资源约束。

运行查询由各 Owner 的公开状态形成视图；Monitor 汇集运行和资源事实，
展示采样不改变结算账目，也不成为新的业务权威。
