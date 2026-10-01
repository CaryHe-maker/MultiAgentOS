# MultiAgentOS Execution

## 1. 定位

Execution 是独立执行模块，维护 UnitAttempt、Executor 步骤实例和实际执行过程，
由 Model、Tool、Workspace、Sandbox 接入和远程 Executor Adapter 等能力组成。
Kernel 管授权、调度、资源和监管，Execution 不拥有 Task、Agent、Policy、Grant 或业务完成判定。
静态定义仍归 AgentToolPool。

可信运行管理代码与不可信 Executor 实现必须分开。用户工具注册后不自动成为可信组件，
不能直接写 Attempt 管理状态、读取其他运行数据或取得控制面凭据。

### 1.1 Tool、Executor 与 Process

Unit 对应一个 Tool 粒度操作；Tool 封装权限需求、输入输出和一个或多个 Executor 的执行序列。
Executor 是开发者定义的最小组合操作，不保证事务原子性、不可中断、可回滚或可安全重试。
运行时形成 UnitAttempt、步骤实例与承载它们的 Processes。
一实例一进程或进程复用由 MVP 按隔离和取消范围选择，不强制将静态定义等同于 OS 进程。

Execution 解释固定步骤依赖并向 Scheduler 报告就绪步骤；
Scheduler 分配执行机会，Monitor 预留资源，Supervisor 提供执行环境。

## 2. 输入与输出

Execution 只接受由 Kernel 获准的请求，并幂等创建 UnitAttempt，随后依据调度安排启动或继续步骤。
UnitIntent 和固定定义引用不可变，Attempt 的进度由 Execution 按版本规则维护。
ExecutionPermit 是 Lease 对本次尝试或步骤的最小范围投影，应绑定 identity、tenant/project、
missionScopeId、graphRevision、定义 digest、运行目标、workspace、capability、
资源上限、deadline、租约依据和 fencing。
一个 Attempt 可包含多个 Executor 实例，应保留各步骤关联，不能只绑定一个 executorId 代表全部过程。

Gateway 和统一可信执行基础设施负责资格验证与使用点限制，Executor 不各自建设鉴权模块。
租约合法不代表资源已经可用，排队后实际开始前仍须确认当前执行条件。

输出为结构化执行事实：状态、ArtifactRef、EffectRecord、usage、日志引用和错误。Executor 不回调 Workflow，不把物理成功解释为业务成功，也不自行重试业务动作。

## 3. Unit 准入后的执行流程

```text
Gateway 验证租约 / Core 必要裁决
-> Execution 幂等创建 UnitAttempt，准备 Tool 执行序列
-> 就绪步骤申请 Scheduler 调度，Monitor 预留额度
-> 可信边界验证定义、Permit、workspace、deadline 和 fencing
-> Supervisor 提供 Sandbox，Execution 注入最小 Secret/能力投影
-> 执行 -> 捕获输出和副作用 -> 写入不可变 Artifact
-> 提交 EffectRecord/usage/候选结果 -> Kernel 确认接收并结算
-> 清理资源或推进下一获准步骤
```

Kernel 接收结果时再次验证租约适用性、fencing、revision、deadline、来源和完整性。
过期或被取代 Attempt 的结果只能作为 Evidence 保存，不得覆盖当前结果。
部分步骤成功后失败必须保留实际效果，Kernel 拒绝结果也不能抹去费用或物理事实。

### 3.1 运行时状态

Execution 保存 Attempt、步骤依赖、实例关联、输入输出引用和实际进度。
Core 保存租约与接收决定，Scheduler 保存调度关系，Monitor 保存账本，
Supervisor 保存进程事实，Workflow 保存业务验收，其他组件通过查询或事件协作。
不建立任意模块可写的全局“AgentOS 内存”。

派发、创建、启动和回执并非跨模块原子事务。重复派发、已创建未启动和启动回执缺失
都必须可查询核对，不能直接重跑未知效果。持久化范围由 MVP 的恢复承诺决定。

## 4. Workspace

- 每个可写 TaskAttempt 使用独立 workspace；不同 Attempt 不共享可变目录。
- WorkspaceRef 绑定 base revision、隔离方式、所有者和生命周期。
- 所有路径在 `realpath` 后验证根目录边界；拒绝绝对路径、`..`、symlink 和 junction 逃逸。
- 文件读取、写入、命令、测试和 Git 操作分别声明能力，不得由通用 Shell 权限隐式替代。
- 恢复不保存活目录句柄；使用 base commit、ordered patch/commit refs 或受控 snapshot 在新 workspace 中物化。

## 5. Sandbox 与资源

Supervisor 管理 Sandbox 的创建、健康、终止和回收，Execution 通过受限 Port 接入。Sandbox Adapter 必须支持 CPU、内存、磁盘、进程数、wall-clock、输出大小、网络和文件系统策略。默认拒绝宿主用户目录、控制面网络、容器 socket 和未声明 Secret。Ubuntu LTS 上的强隔离实现可以替换，但不得改变执行范围和结果语义。能力不足不得静默降级为无限制执行。

进程执行必须使用参数数组，不拼接 Shell 字符串。超时后终止完整进程树；清理失败形成独立诊断，不覆盖原执行结果。

## 6. Secret 与网络

- UnitIntent 只携带 SecretRef，不含明文凭据。
- Kernel 在执行前依据身份、Policy、definition 和目标资源签发短期 Secret materialization。
- Secret 仅注入需要它的进程或请求，禁止写入日志、Artifact、环境快照和模型上下文。
- 网络默认拒绝；允许项绑定目标域、端口、协议、用途和有效期。
- 重试或恢复必须重新签发 Secret 和网络许可。

## 7. 模型与工具

模型网关（Model Adapter）位于 Execution，负责 Provider 适配并校验上下文上限、结构化输出 Contract、usage 和 Provider 错误；原始响应按数据等级保存。Tool Adapter 校验 Unit Permit 投影出的 ToolDefinitionVersion、参数、结果、风险与 EffectRecord。

Tool Adapter 不接受绕过 Gateway 的裸请求。Unit 对应一个 Tool 操作，其固定序列中的步骤在同一 Attempt 内推进，且必须处于声明与租约范围内。
现有 `toolRefs` 契约与新序列结构的衔接见 [架构指南](../README.md#6-文档衔接清单)。
模型 tool call 只是新业务动作提案，必须返回 Workflow 形成 UnitIntent，不能在模型网关自由执行。

API 管理池由 Kernel Scheduler 维护容量和调用机会，Monitor 维护预算与消耗；
模型网关处理实际请求。未就绪步骤不占据 API 槽位，Provider 超时不自动释放未知消耗。
ContextEngine 保留独立上下文与检索所有权，通过执行契约接入；现有 Permit 检查应显式衔接。

未知 Provider 状态不得直接标记失败并重试。若外部副作用可能已发生，结果进入 `UNKNOWN_EFFECT`，交由 reconciliation 或人工处理。

## 8. Git 与 ChangeSet

代码执行结果必须生成不可变 ChangeSet，至少绑定 taskAttemptId、baseRevision、patch/commit ref、changedPaths、rename/delete/binary metadata、workspace、definitionVersion、测试证据、contentHash 和 provenance。

集成在干净 workspace 中按 Workflow 提供的不可变 IntegrationPlan 执行：验证 base → 按确定顺序应用 ChangeSet → 记录冲突 → 运行 QualityGate → 生成 IntegratedRevision。Executor 自测不能替代集成 QualityGate；push、PR 和发布是独立副作用 Unit。

## 9. Lease、fencing 与取消

- Lease 表示主体在条件内使用能力的资格，可长期或不设预定到期日，不表示业务所有权。Core 维护权威记录；本次 Attempt/步骤使用受限凭证，Execution 不维护第二套租约权威。
- fencing token 在同一受控调度/资源范围内单调递增，由 Scheduler 管理相应代次；旧 token 的结果和副作用提交拒绝，长期租约仍有效不能使旧实例重新获得提交权。
- cancel 先阻止受影响范围的新调度，再通过中断请求 Execution 停止序列，Supervisor 监管并必要时终止执行域；物理终止不等于业务取消成功，也不默认撤销主体所有长期租约。
- 不能确认副作用状态时进入 reconciliation，不得自动重复执行。

Execution 响应中断并汇报安全点、在途调用和效果；信号收到不等于停止完成。
执行故障主动报送 Core 控制分派器，普通工具失败不发起全局 panic。
局部重试满足定义、幂等与授权条件，业务重试由 Workflow 决定。
checkpoint 恢复先核对效果，再取得当前资格，不能从快照直接复活旧会话。

## 10. 错误分类

Execution 使用 Protocol 的统一错误类别，包括 VALIDATION、CONFLICT、POLICY、TIMEOUT、RESOURCE、DEPENDENCY、EXECUTION、INTEGRITY、CONTRACT 和 INTERNAL。未知效果使用稳定 code UNKNOWN_EFFECT，归入 EXECUTION/INTEGRITY 处理路径，不作为独立类别或自动重试依据。错误必须携带 attempt、correlation、executor、workspace 和可选 diagnosticsRef；message 只供展示。

## 11. 可观测性与测试

记录排队时长、Sandbox 启动时长、资源峰值、模型/tool 延迟、usage、Lease 续期、fencing 拒绝、超时、清理失败和未知副作用。不得记录 Secret 或完整 Prompt。

测试必须覆盖路径逃逸、资源限制、网络默认拒绝、Secret 泄漏、进程树终止、静态 Executor 定义与运行时实例不匹配、capability 不足、裸 Tool 调用、Tool 越出 Unit 允许集合、Lease 过期、旧 fencing 结果、Executor 崩溃、重复提交、未知副作用、ChangeSet base mismatch、集成冲突和 QualityGate 失败。

流式进度与输出经授权逻辑通道展示，需绑定 Attempt 和来源，不直接改写 Workflow 状态。暂态输出、执行完成、Kernel 接受结果和业务验收必须分开。共享实例的测试还需覆盖跨运行污染、取消范围和部分步骤失败。
