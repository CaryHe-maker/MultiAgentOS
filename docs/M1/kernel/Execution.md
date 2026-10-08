# MultiAgentOS M1 Kernel.Execution

## 1. 定位

Execution 负责 UnitAttempt、执行队列与产物发布。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Execution 架构](../../Architecture/kernel/Execution.md)。

## 2. 职责

- 幂等建立 UnitAttempt，维护步骤、执行进度、输入输出、已知与未知效果及新旧尝试关系。
- 维护唯一的 Unit FIFO 执行队列，按受理顺序串行推进；前一执行活动完成或确认停止后才启动下一项。
- 需要 API 时经内部 syscall 向 Core 申请预留；执行完成后经内部 syscall 向 Core 提交结果检查，用量随之交给 Core。
- 向 Supervisor 提交 `executionKind`、已获准参数、范围约束与限制，由其装配并执行，不自行扩大操作范围。
- 管理本次分析所需的上下文构建记录、检索台账和来源关联；为上下文组装解析本运行内的输入产物。
- 产物只由 Execution 写入 ArtifactStore，包括执行产物与 Workflow 经 `report-publish` 提交的最终报告。
- 依据 Core 的判定封装结果并交付 Workflow；交付前核对 runEpoch，状态已变时不再交付，结果只作为证据保存。
- 收到 Executor 违规报告时隔离该次输出，不交付、不发布，并经内部 syscall 上报 Core。

模型输出只是动作提案，由 Workflow 形成后续 UnitIntent；静态库不保存可变运行状态。
非 API 工作并发执行仅作为后续演进方向，不纳入 M1。

## 3. 技术重试

技术重试由 Execution 执行，对 Workflow 不可见，不计 Round；每个 Unit 最多 3 次，model-call 每次重试重新预留。

## 4. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| 技术重试次数上限 | Execution 配置 | Execution | 3 |
