# MultiAgentOS M1 Kernel.Execution

## 1. 定位

Execution 负责 UnitAttempt、执行队列与产物发布。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Execution 架构](../../Architecture/kernel/Execution.md)。

## 2. 职责

- 幂等建立 UnitAttempt 并记录建立时的 runEpoch，维护步骤、执行进度、输入输出、已知与未知效果及新旧尝试关系。
- 维护唯一的 Unit FIFO 执行队列，按受理顺序串行推进；前一执行活动完成或确认停止后才启动下一项。
- 需要 API 时经内部 syscall 向 Core 申请预留，附估算上界（输入 token 上界 + `max_tokens`）与是否为 final-call；执行完成后经内部 syscall 向 Core 提交结果检查，用量随之交给 Core。
- 向 Supervisor 提交 `executionKind`、已获准参数、范围约束与限制，由其装配并执行，不自行扩大操作范围。
- 管理本次分析所需的上下文构建记录、检索台账和来源关联；为上下文组装解析本运行内的输入产物。
- 维护产物归属索引，解析 Unit 输入中的 ArtifactRef 前检查其归属（第 3 节）。
- 产物只由 Execution 写入 ArtifactStore，包括执行产物与 Workflow 经 `report-publish` 提交的最终报告。
- 封装执行结果（输出、ArtifactRef、效果），随结果检查交给 Core；UnitReport 由 Core 经 Outbox 交付，
  Execution 不直接向 Workflow 发送。
- 收到 Executor 违规报告时隔离该次输出，不交付、不发布，并经内部 syscall 上报 Core。

模型输出只是动作提案，由 Workflow 形成后续 UnitIntent；静态库不保存可变运行状态。
非 API 工作并发执行仅作为后续演进方向，不纳入 M1。

## 3. 产物归属与解析

Execution 为每个写入的产物登记归属：`artifactId → workflowRunId、产生它的 unitAttemptId、mediaType`。

```text
Unit 输入含 ArtifactRef
  → 归属索引中存在、属于同一 WorkflowRun，且 sha256、size 与对象一致 → 解析为内容
  → 否则 → UnitReport REJECTED(OUT_OF_SCOPE)，不说明是不存在还是不属于本运行
```

- Executor 只接收 Execution 解析后的内容，不持有 ArtifactStore 句柄，不能自行读取其他产物。
- context-assemble 所需的 Agent 指令与工具 Schema 由 Execution 依据该 AgentRun 登记的固定定义
  从 AgentToolPool 解析，不经 ArtifactRef 传递。
- UserInteraction 的“读取产物”请求由 Gateway 移交 Core，Core 核对请求属于该运行后由 Execution 按同一规则解析。

## 4. 技术重试

技术重试由 Execution 执行，对 Workflow 不可见，不计 Round；每个 Unit 最多 3 次。

model-call 只在确认请求未发出时重试（如连接建立失败、provider 返回 429），每次重试重新预留；
请求可能已发出但无法得到结果时不重试，按未知消耗结算后以 `UNAVAILABLE` 交付，
避免同一次调用的未知消耗被多次计入。

## 5. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| 技术重试次数上限 | Execution 配置 | Execution | 3 |
