# MultiAgentOS Execution

## 1. 定位

Execution 是 Kernel 管辖的执行面，由 Model、Tool、Workspace、Sandbox 和远程 Executor Adapter 组成。它承载满足特定 ExecutorDefinitionVersion 的运行时 Executor，但不拥有静态定义。它不是领域 Module，不拥有 Task、Agent、Policy、Grant 或完成判定。

## 2. 输入与输出

Execution 只接受 Kernel 签发的 ExecutionPermit 和不可变 UnitAttempt。Permit 必须绑定 identity、tenant/project、missionScopeId、graphRevision、Agent/Unit/Tool/Executor definition digest、运行时 ExecutorInstance、workspace、capability、资源上限、deadline、Lease 和 fencing token。

输出为结构化执行事实：状态、ArtifactRef、EffectRecord、usage、日志引用和错误。Executor 不回调 Workflow，不把物理成功解释为业务成功，也不自行重试业务动作。

## 3. Unit 准入后的执行流程

```text
领取 Lease -> 校验 Permit/Agent/Unit/Tool/Executor definition/workspace/deadline/fencing
-> 创建或连接 Sandbox -> 注入最小 Secret/Tool projection
-> 执行 -> 捕获输出和副作用 -> 写入不可变 Artifact
-> 生成 EffectRecord/usage -> 以 fencing token 提交结果 -> 清理资源
```

提交时必须再次验证 Lease、fencing、revision 和 deadline。过期 Attempt 的结果只能作为 Evidence 保存，不得成为当前结果。

## 4. Workspace

- 每个可写 TaskAttempt 使用独立 workspace；不同 Attempt 不共享可变目录。
- WorkspaceRef 绑定 base revision、隔离方式、所有者和生命周期。
- 所有路径在 `realpath` 后验证根目录边界；拒绝绝对路径、`..`、symlink 和 junction 逃逸。
- 文件读取、写入、命令、测试和 Git 操作分别声明能力，不得由通用 Shell 权限隐式替代。
- 恢复不保存活目录句柄；使用 base commit、ordered patch/commit refs 或受控 snapshot 在新 workspace 中物化。

## 5. Sandbox 与资源

Sandbox Adapter 必须支持 CPU、内存、磁盘、进程数、wall-clock、输出大小、网络和文件系统策略。默认拒绝宿主用户目录、控制面网络、容器 socket 和未声明 Secret。强隔离实现可以替换，但不得改变 ExecutionPermit 和结果语义。

进程执行必须使用参数数组，不拼接 Shell 字符串。超时后终止完整进程树；清理失败形成独立诊断，不覆盖原执行结果。

## 6. Secret 与网络

- UnitIntent 只携带 SecretRef，不含明文凭据。
- Kernel 在执行前依据身份、Policy、definition 和目标资源签发短期 Secret materialization。
- Secret 仅注入需要它的进程或请求，禁止写入日志、Artifact、环境快照和模型上下文。
- 网络默认拒绝；允许项绑定目标域、端口、协议、用途和有效期。
- 重试或恢复必须重新签发 Secret 和网络许可。

## 7. 模型与工具

Model Adapter 校验上下文上限、结构化输出 Contract、usage 和 Provider 错误；原始响应按数据等级保存。Tool Adapter 校验 Unit Permit 投影出的 ToolDefinitionVersion、参数、结果、风险与 EffectRecord。

Tool Adapter 不接受裸 Tool 请求。所有 Tool 调用必须位于一个 UnitAttempt 内，且 Tool 必须属于该 UnitDefinitionVersion 的 `toolRefs`。模型不能直接调用工具：tool call 只是动作提案，必须返回 Workflow 形成 UnitIntent，再由 Kernel 重新验证 Agent→Unit→Tool 并准入。

未知 Provider 状态不得直接标记失败并重试。若外部副作用可能已发生，结果进入 `UNKNOWN_EFFECT`，交由 reconciliation 或人工处理。

## 8. Git 与 ChangeSet

代码执行结果必须生成不可变 ChangeSet，至少绑定 taskAttemptId、baseRevision、patch/commit ref、changedPaths、rename/delete/binary metadata、workspace、definitionVersion、测试证据、contentHash 和 provenance。

集成在干净 workspace 中按 Workflow 提供的不可变 IntegrationPlan 执行：验证 base → 按确定顺序应用 ChangeSet → 记录冲突 → 运行 QualityGate → 生成 IntegratedRevision。Executor 自测不能替代集成 QualityGate；push、PR 和发布是独立副作用 Unit。

## 9. Lease、fencing 与取消

- Lease 表示有限时间内执行某 Attempt 的资格，不表示业务所有权。
- fencing token 必须单调递增；旧 token 的结果和副作用提交一律拒绝。
- cancel 先停止签发新 Permit，再请求运行中 Executor 协作终止；物理终止不等于业务取消成功。
- 不能确认副作用状态时进入 reconciliation，不得自动重复执行。

## 10. 错误分类

Execution 区分 VALIDATION、POLICY、TIMEOUT、RESOURCE、DEPENDENCY、EXECUTION、INTEGRITY 和 UNKNOWN_EFFECT。错误必须携带 attempt、correlation、executor、workspace 和可选 diagnosticsRef；message 只供展示。

## 11. 可观测性与测试

记录排队时长、Sandbox 启动时长、资源峰值、模型/tool 延迟、usage、Lease 续期、fencing 拒绝、超时、清理失败和未知副作用。不得记录 Secret 或完整 Prompt。

测试必须覆盖路径逃逸、资源限制、网络默认拒绝、Secret 泄漏、进程树终止、静态 Executor 定义与运行时实例不匹配、capability 不足、裸 Tool 调用、Tool 越出 Unit 允许集合、Lease 过期、旧 fencing 结果、Executor 崩溃、重复提交、未知副作用、ChangeSet base mismatch、集成冲突和 QualityGate 失败。
