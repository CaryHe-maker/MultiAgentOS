# MultiAgentOS Shared Contracts

## 1. 职责

Shared Contracts 提供跨边界数据的 Schema、类型、规范化编码、协议注册和兼容测试。它定义 Agent、Unit、Tool、Executor 及其运行时对象的通用协议，不保存任何具体定义或运行实例，也不包含 Reducer、Policy、调度、检索或业务完成逻辑。

## 2. Schema 规则

- Schema 名称采用 `<namespace>.<Name>.v<major>`。
- `schemaName + major` 唯一确定语义；未知 major 必须拒绝。
- 对象默认 `additionalProperties: false`，边界输入使用 `unknown` 并立即校验。
- TypeScript 类型从 Schema 导出，不能替代运行时验证。
- 时间使用 UTC/RFC 3339；ID 为不可推测、全局唯一字符串。
- 大对象使用 ArtifactRef；Secret、连接句柄和内部数据库主键不得进入公共协议。
- 不允许 `any`、无语义 metadata/extensions 或空成功对象充当扩展点。

## 3. 兼容规则

同一 major 可以新增语义明确的可选字段、新独立 Schema 或消费者明确协商的枚举值；不得删除字段、改变含义、收紧合法值或复用旧名称。破坏性变化创建新 major，并提供显式转换器、双读期或迁移计划。

协议 minor 表示兼容演进，不参与隐式猜测。消费者必须依据 Schema 标识解析，不得通过字段存在性判断版本。

## 4. Protocol Registry

Registry 记录 schemaName、major/minor、owner、capability、handler 和状态。它必须拒绝重复注册、未知 major、Owner 缺失和 capability 与 handler 不一致。未实现协议注册为 `UNSUPPORTED`，调用后返回结构化错误且不产生副作用。

## 5. Agent、Unit、Tool 与 Executor 通用协议

Shared Contracts 只规定以下对象的结构、引用关系和不变量；具体版本由 AgentToolPool 发布，运行时实例由相应 Owner 创建。

| 协议 | 核心语义 | 不包含 |
|---|---|---|
| `AgentDefinitionVersion` | Agent 的不可变角色、行为约束、输入输出 Contract、允许的 `UnitDefinitionVersionRef` 集合及组合约束 | AgentRun 状态、动态预算、授权结论 |
| `UnitDefinitionVersion` | 单个可准入动作的不可变输入输出 Contract、所需 capability、允许的 Tool 引用、效果类型、幂等与资源约束 | UnitIntent、UnitAttempt、运行时 Executor |
| `ToolDefinitionVersion` | 工具操作的参数/结果 Schema、风险、副作用、幂等、补偿及供应链信息 | 工具调用、凭据、授权结论 |
| `ExecutorDefinitionVersion` | 执行器类别可提供的 capability、支持的 Unit/Tool Contract、环境与资源约束 | endpoint、进程、会话、Lease、健康状态 |
| `AgentRun` | Workflow 创建并持久化的一次 Agent 执行，固定 Agent 定义及允许的 Unit 定义集合 | 定义内容、物理执行状态 |
| `UnitIntent` | Workflow 创建的不可变执行需求，引用 AgentRun 与一个已固定的 Unit 定义版本 | executorId、明文 Secret、物理调度结论 |
| `UnitAttempt` | Kernel 为一次准入与调度创建的运行尝试，绑定选定 Executor 定义、运行时 Executor、Permit、Lease 与 fencing | 业务验收结论 |
| `UnitResult` | Executor 产生、Kernel 校验的结构化执行事实 | Task 或 Workflow 完成结论 |

所有 DefinitionVersionRef 必须携带稳定 ID、版本和内容 digest。`AgentDefinitionVersion.allowedUnitRefs` 是 Agent 可请求 Unit 的封闭集合；`UnitDefinitionVersion.toolRefs` 是该 Unit 可调用 Tool 的封闭集合。引用未知、未固定、已撤销或 digest 不匹配的定义必须拒绝。

Tool 不具有独立的运行入口。任何 Tool 调用必须位于一个 UnitIntent 对应的 UnitAttempt 内，并同时通过 Agent→Unit 成员关系、Unit→Tool 成员关系和 Kernel 准入校验。

## 6. 公共值

Shared Contracts 维护 Envelope、BoundaryContext、VersionedRef、ArtifactRef、WorkspaceRef、CapabilityDescriptor、ModuleError、Page/Cursor 和基础 ID Schema。领域 payload 由其 Owner 定义并注册；公共包不得成为所有模块字段的无边界共享模型。

## 7. 规范化与完整性

需要 hash、签名或幂等比较的 payload 必须使用确定性的字段顺序、UTF-8 和 LF 编码。浮点、时间、空值和缺省字段的规范化规则必须固定。ArtifactRef 在读取时复验 hash、size 和 mediaType。

## 8. 生成与测试

每个协议必须提供：合法 fixture、缺失字段、多余字段、边界值、未知 major、旧 reader/新 writer 兼容、规范化 hash 和 Unsupported 无副作用测试。Agent/Unit/Tool/Executor 协议还必须覆盖非法成员引用、digest 不匹配、未固定版本、Tool 脱离 Unit 调用和运行时字段进入静态定义。Producer 与 Consumer 共用 fixture，但不得共享会掩盖序列化错误的内部对象实例。

协议的长期语义见 [Protocol.md](../Protocol.md)；具体交付协议必须保持其责任方向和兼容规则。
