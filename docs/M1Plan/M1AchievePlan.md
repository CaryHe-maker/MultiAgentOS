# MultiAgentOS M1 达成计划

> 周期：4 周  
> 团队：3 人，每人每周 20 小时  
> 总容量：240 名义人时  
> 目标设计：`docs/M1Plan/TargetM1.md`

## 1 达成目标

三人分别主责 Workflow、Kernel 和 ContextEngine，在四周内共同交付一个单 Agent coding MVP：它能够接收简单编码目标，理解陌生小型仓库，在隔离 worktree 中修改代码，运行测试并输出 diff 与执行报告。同时，M1 必须为总规划中的五个 Module 和五项 Infrastructure 建立真实、可编译、可测试的架构插槽；UserInteraction 与 AgentToolPool 可采用简单实现，Infrastructure 可采用本地/进程内 adapter，但不得省略边界。

M1 的完成标志不是三个主责模块分别“写完”，而是同一个真实任务能够稳定沿 `UserInteraction -> Kernel -> Workflow -> UnitIntent -> Kernel -> ContextEngine/Executor -> Kernel -> Workflow -> RuntimeProjection -> UserInteraction` 运行，并从 AgentToolPool 固定 DefinitionVersion。所有个人任务都必须最终连接到该端到端用例。

## 2 团队分工

| 负责人 | 主责 | 同时负责的预留实现 | M1 交付 |
|---|---|---|---|
| A | Workflow | UserInteraction 最小领域层与 CLI adapter | WorkSession/PromptRevision/UserIntent、Task/Agent 状态、Agent loop、步骤预算、终止、验收、报告 |
| B | Kernel | AgentToolPool 内置目录；Module Host 装配 | 控制/Unit 准入、DefinitionVersion 固定、路由、RuntimeProjection、workspace、执行安全与审计 |
| C | ContextEngine | Persistence/Communication/Artifact 本地 adapter 的接口协作 | repository snapshot、rg、分块、token 裁剪、ContextPack、检索评测和 Infrastructure contract harness |

Shared Contracts、Persistence Port、Communication Port 与 Artifact Port 由三人共同评审。任何人不得单方面修改其他模块已经依赖的 Contract；变更必须包含 schema、兼容说明和 contract test。上述分配只是交付责任，不允许 A 把 UserInteraction 合入 Workflow，或 B 把 AgentToolPool 合入 Kernel。

### 2.1 全架构占位完成标准

M1 第 1 周结束前必须出现并可独立构建：`user-interaction`、`workflow`、`kernel`、`context-engine`、`agent-tool-pool` 五个 Module 包，以及 Module Host、Shared Contracts、Persistence、Communication、Artifact Store 五项 Infrastructure 的 Port 与默认 adapter。每个插槽至少有 owner、公开入口、fake/disabled 实现和边界测试；暂不实现的操作统一返回结构化 `UNSUPPORTED_CAPABILITY`，不得留成跨模块直连的 TODO。

## 3 首先冻结的协作接口

第一周前两天共同完成以下最小契约：

1. `Envelope<T>`、ID、时间和 `ModuleError`。
2. `WorkSession/PromptRevisionRef`、`WorkflowRun`、`TaskGraph/GraphRevision`、根 `MissionScopeRef`、`TaskRun`、`AgentRun`、`AgentStep` 的最小 schema。
3. `ContextRequest`、`ContextPack` 和 `ContextItem`。
4. `UnitIntent`、`UnitResult`、`AgentAction` 和 `Observation`。
5. `ArtifactRef`、`WorkspaceRef` 和最终 `RunReport`。
6. `UserIntent`、`AdmittedCommand`、`RuntimeProjection` 与 `KernelControlPort`。
7. `DefinitionQuery`、`DefinitionVersionRef` 与 `CatalogPort`。
8. `ContextPort` 与 `KernelPort`；`CONTEXT` 必须是 Unit 类型，ContextPort 只由 Kernel adapter 使用。
9. `PersistencePort/Repository`、`CommunicationPort/Router` 与 `ArtifactStorePort` 的最小契约。
10. Protocol Registry：为 `platform.common`、`interaction`、`workflow`、`kernel.control`、`kernel.unit`、`context`、`catalog`、`checkpoint/restore`、`review`、`integration`、`platform.lifecycle/persistence/communication/artifact` 注册 schemaName、owner、版本、capability 和 handler。

五个 Module 的跨边界消息都必须使用 TypeBox/Ajv 或统一选择的 JSON Schema 工具进行运行时校验，不能只共享 TypeScript interface。M1 未实现的对象协议至少定义 opaque VersionedRef、Port 与 Unsupported result schema；不要用空对象、`any` 或永远返回 success 的 Noop 冒充兼容。

## 4 依赖顺序

```text
共享 Contract
   -> Module Host 组装五个 Module 与五项 Infrastructure
   -> CLI/UserInteraction -> UserIntent -> KernelControlPort
   -> Kernel -> AdmittedCommand -> Workflow
   -> Workflow -> CatalogPort -> 固定 DefinitionVersion
   -> Workflow -> UnitIntent -> KernelPort
        ├── CONTEXT -> LocalContextAdapter -> ContextPackRef
        └── MODEL/TOOL -> LocalKernelAdapter -> UnitResult
   -> Workflow/Event -> Kernel RuntimeProjection -> UserInteraction

所有最小 Adapter 就绪
   -> 单轮真实 Agent
   -> 多轮搜索/修改/测试
   -> 固定任务集
   -> 安全与失败场景
   -> M1 验收
```

Workflow 负责人不等待真实 Kernel/ContextEngine：先使用 fake 完成循环。Kernel 与 ContextEngine 负责人不等待 Workflow：各自使用 contract test 和独立 harness 验证 adapter。CLI harness 必须通过 UserInteraction 和 KernelControlPort 发起运行，不得为了联调临时直调 Workflow；Workflow 的 Context 请求也必须先形成 UnitIntent 再由 Kernel 路由。

## 5 四周执行计划

### 第 1 周：契约、骨架和 Fake 纵向闭环

本周共同目标：不用真实模型也能通过 fake 沿总规划的数据线路跑通一次完整 AgentStep，并一次性建立五个 Module、五项 Infrastructure 的稳定目录和装配插槽。

#### 共同架构骨架

1. 建立五个 Module 包和 `packages/module-host`、Shared Contracts、Persistence、Communication、Artifact Store 的 Infrastructure 包；`apps/control-plane` 只保留最终 composition entry、配置与具体 adapter 选择。
2. 为每个边界建立 dependency rule；禁止 CLI 依赖 Workflow、Workflow 依赖 ContextEngine/Kernel 实现、UserInteraction 读取其他 Module 状态。
3. 实现进程内 Router、文件 Persistence adapter、本地 Artifact adapter 和对应 fake；能力之外返回 `UNSUPPORTED_CAPABILITY`。
4. 用一个架构 smoke test 验证 Module Host 启动顺序、五个 Module 注册和全部默认 adapter 可替换。
5. 建立 Protocol Registry 与生成式/fixture contract tests；为 checkpoint/restore、review、integration、durable persistence/communication 等后续协议安装 Unsupported handler。
6. 统一 `Envelope`、typed Ref、capability negotiation 与 Unsupported result；检查 schemaName 唯一和未知 major 拒绝。

#### A：Workflow

1. 建立 WorkflowRun、`GraphRevision = 0`、根 MissionScope、TaskRun、TaskAttempt、AgentRun 和 AgentStep 最小状态机。
2. 实现只允许单 Task 的 TaskGraph capability validator。
3. 定义 Agent loop：Context → Model → Action → Observation → Final。
4. 实现 `FakeKernelPort` 驱动的 happy-path 测试；Fake Kernel 内部把 CONTEXT Unit 路由给 `FakeContextPort`，Workflow 不直接持有 ContextPort。
5. 实现最大步骤数、取消标志和最终结果骨架。
6. 实现 UserInteraction 最小 WorkSession、PromptRevision、UserIntent 与 CLI 入口，确保入口先到 Kernel。

#### B：Kernel

1. 实现 `KernelPort` contract test harness。
2. 建立 UnitIntent 准入顺序和结构化 UnitResult。
3. 实现临时 workspace 与 Git worktree 创建/销毁。
4. 实现 `FILE_READ`、`FILE_WRITE` 的 fake/local adapter。
5. 明确路径 canonicalization、symlink/junction 和 workspace 边界策略。
6. 实现最小 KernelControlPort、AdmittedCommand 路由和 RuntimeProjection 骨架。
7. 实现 AgentToolPool 内置 DefinitionVersion、digest 与 CatalogPort fake，确保运行固定所用版本。

#### C：ContextEngine

1. 实现 `ContextPort` contract test harness。
2. 建立 RepositorySnapshot、文件树和 ignore 规则。
3. 实现 `rg` 文本搜索的最小 adapter。
4. 定义不可变 ContextPack、ContextItem 和 provenance。
5. 准备第一个小型 fixture repository。

#### 第 1 周退出条件

- `contracts` 包可构建并运行正反 schema 测试。
- FakeContext + FakeKernel 能让 Workflow 完成一个假任务。
- 五个 Module 与五项 Infrastructure 均有可编译插槽、默认/fake adapter 和 Module Host 注册；架构依赖测试通过。
- Protocol Registry 覆盖 `TargetM1.md` 第 6.5 节全部协议族；每族至少有 schema fixture 和可解析 handler，未实现命令确定性返回 Unsupported。
- 假任务从 UserInteraction 发起，经 Kernel 路由到 Workflow，从 AgentToolPool 固定定义，并以 RuntimeProjection 返回 UserInteraction。
- Kernel 能在隔离 worktree 中安全读写指定文件。
- ContextEngine 能对 fixture 生成带来源的 ContextPack。

### 第 2 周：真实模型和单轮真实执行

本周共同目标：真实模型读取 ContextPack，产生结构化动作并完成一次受控修改。

#### A：Workflow

1. 实现 AgentAction reducer 和合法动作校验。
2. 将 ContextPack、Observation 和历史步骤组装为下一轮模型输入引用。
3. 实现 FINAL、失败、步数上限、token 上限和时间上限。
4. 为非法模型输出、空动作和重复动作建立失败策略。
5. 输出初版 RunReport。
6. 所有 Context 请求改为 `CONTEXT UnitIntent`，只消费 Kernel 返回的 Context UnitResult/ArtifactRef。

#### B：Kernel

1. 接入一个模型 Provider，完成 `MODEL` Unit。
2. 使用 schema 校验结构化 AgentAction。
3. 实现 `COMMAND` 和 `TEST` Unit、超时和输出截断。
4. 实现允许命令集合与禁止外部路径/网络的开发期策略。
5. 为每次模型与工具执行生成步骤审计记录。
6. 按 Unit 类型把 CONTEXT 路由到 ContextEngine，并基于固定 DefinitionVersion 执行 MODEL/TOOL；生成最小 RuntimeProjection。

#### C：ContextEngine

1. 实现文件分块、语言/文件类型识别和大小限制。
2. 实现 token 估算、去重和裁剪。
3. 支持按 objective、query 和 previous observation 二次检索。
4. 输出选择理由、repository revision 和来源范围。
5. 建立 ContextPack 单元测试和相关性人工检查表。

#### 第 2 周退出条件

- 真实模型基于 ContextPack 返回合法 AgentAction。
- 真实运行严格经过 `UserInteraction -> Kernel -> Workflow`，且 Context/模型/工具均经过 Kernel Unit 准入。
- AgentToolPool 返回的 DefinitionVersionRef/digest 写入运行记录，UserInteraction 只读 RuntimeProjection。
- 文件修改只通过 Kernel 发生。
- Agent 能完成至少一个“已知相关文件”的简单修改并运行测试。
- 达到预算或超时时能确定性停止并生成失败报告。

### 第 3 周：多轮 Agent 与陌生仓库任务

本周共同目标：Agent 不知道目标文件时，能够搜索、观察、修改、测试并至少进行一次修复迭代。

#### A：Workflow

1. 完成多轮 Agent loop 和 Observation 历史压缩策略。
2. 实现测试失败后的继续、成功后的验收和无进展检测。
3. 验证最终 diff、测试证据和模型 FINAL 声明的一致性。
4. 记录每步 correlation/causation 和 ArtifactRef。
5. 增加 cancel 的进程内语义。
6. 确保运行内所有跨边界数据只经 Envelope/ArtifactRef 和进程内 Communication Port 传递。

#### B：Kernel

1. 完善 worktree 生命周期和原始 checkout 不变测试。
2. 支持 patch/diff 获取和测试证据 Artifact。
3. 完成路径逃逸、symlink/junction、命令超时和进程树终止测试。
4. 实现模型/命令输出大小限制及敏感字段脱敏。
5. 建立本地 Executor 的已知安全限制说明。

#### C：ContextEngine

1. 支持文件树、文本搜索、测试错误和符号名称的组合召回。
2. 根据 Agent 查询生成增量 ContextPack，避免每轮重复全部内容。
3. 为跨两个文件的任务补充 provenance 和相关性测试。
4. 准备至少 5 个固定 fixture task。
5. 记录 context 命中率、token 使用和遗漏原因。

#### 第 3 周退出条件

- Agent 能完成至少一个未知目标文件的 bug 修复。
- 至少一次任务包含“第一次测试失败 → 再修改 → 测试成功”。
- 原始 checkout 保持不变，最终产生可应用 diff。
- 每个步骤可追溯到 ContextPack、UnitIntent、UnitResult 和 Artifact。
- 每个步骤可追溯到 WorkSession、PromptRevision、WorkflowRun、根 MissionScope、GraphRevision、DefinitionVersion、correlation/causation 和 UserInteraction 可见的 RuntimeProjection。

### 第 4 周：固定任务集、加固和验收

本周共同目标：停止增加功能，围绕固定任务集修复接口和稳定性问题。

#### A：Workflow

1. 固化状态转换和 Agent loop contract tests。
2. 完成成功、失败、取消、预算耗尽和测试未通过的报告。
3. 统计每个 fixture 的步骤数、用量、耗时和最终状态。
4. 清理跨模块直接依赖，确保五个 Module 只通过 Port/Envelope 通信。
5. 整理 M2 所需持久化状态清单。
6. 运行协议兼容矩阵：旧 fixture 被新 reader 接受、未知 major 被拒绝、Ref 不泄漏 owner 内部对象、Unsupported 不产生状态变化。

#### B：Kernel

1. 完成 Model/Tool adapter contract tests。
2. 加固路径、命令、超时、输出和清理失败处理。
3. 确保模型不能绕过 UnitIntent 直接调用工具。
4. 输出 workspace diff、test evidence 和执行审计。
5. 整理 M2 durable execution 和幂等需求。

#### C：ContextEngine

1. 对固定任务集运行检索回归测试。
2. 调整分块、排序、去重和 token budget。
3. 确保 ContextPack 不泄漏 workspace 外文件。
4. 输出 provenance 和 context 选择诊断。
5. 整理 M2 repository revision、缓存和持久化需求。

#### 第 4 周退出条件

- 五个固定任务可重复执行并生成统一报告。
- 至少一种真实简单编码任务端到端成功。
- 五个 Module 和五项 Infrastructure 的 Port/adapter 均通过对应 contract/架构测试；主要执行 Port 通过共享 contract tests。
- 原始 checkout、路径和命令边界测试通过。
- M1 已知限制和 M2 backlog 明确记录。

## 6 每人人时预算

每人每周 20 小时、四周 80 小时。个人容量按以下方式控制：

| 类别 | 每人预算 | 三人合计 |
|---|---:|---:|
| 模块实现 | 44 | 132 |
| 单元与 contract tests | 12 | 36 |
| 跨模块联调和 E2E | 12 | 36 |
| 评审、文档和 ADR | 6 | 18 |
| 未分配风险储备 | 6 | 18 |
| 合计 | **80** | **240** |

五个 Module/五项 Infrastructure 的薄骨架属于“模块实现”和“contract tests”预算，不是额外平台功能。UserInteraction、AgentToolPool、Persistence 与 Communication 在 M1 只做支撑关键线路所需的最小实现。风险储备只能用于既定 M1 验收项的返工、Provider 问题和平台差异，不得用于加入新功能。

## 7 共同集成纪律

1. 每天至少保持一次五模块关键线路的主分支集成，不允许三个主责模块各自开发三周后再联调。
2. 每个 Module 与 Infrastructure Port 提供 fake/disabled 或本地 adapter；调用方测试不得依赖另一模块的内部实现。
3. Contract 变更必须先更新 schema 和共享 contract tests，再更新 adapter。
4. 每周退出条件未满足时，下一周首先补齐，不平行堆叠更多未来能力。
5. 第 4 周冻结功能，只修复影响验收的问题。
6. 模型 prompt、工具参数和原始输出不得散落在普通日志；大对象使用 ArtifactRef。
7. 所有跨模块调用必须携带 correlationId，错误必须使用统一分类。
8. 任何为赶进度而提出的直连只能通过修改本计划与 `TargetM1.md` 的架构评审决定；不得先合并再留待 M2 重构。
9. 未实现协议只能补充 typed Ref、capability 与 Unsupported handler；没有真实用例前不得冻结臆测的完整 payload，也不得使用无约束扩展字段绕过版本治理。

## 8 M1 固定任务集

| 编号 | 任务 | 主要验证模块 |
|---|---|---|
| F1 | 已知相关文件，修复一个失败测试 | Workflow + Kernel 基本闭环 |
| F2 | 未知目标文件，根据错误信息定位逻辑缺陷 | ContextEngine 检索 |
| F3 | 修改两个相关文件以修复接口不一致 | 多轮 ContextPack 与编辑 |
| F4 | 新增小功能并补充测试 | 结果验收与测试执行 |
| F5 | 第一次修改后测试仍失败，再次观察和修复 | Workflow 多轮循环 |

每个 fixture 必须包含初始 commit、用户目标、允许的测试命令、预期行为、禁止路径和验收断言。不能把正确文件名或修复答案直接写进 prompt。

## 9 M1 发布门

以下任一情况阻断 M1：

- 五个 Module 中任一架构插槽缺失，或 UserInteraction、Kernel、Workflow、ContextEngine 在其应参与的关键线路上被绕过；
- CLI 直接创建 WorkflowRun，Workflow 直接调用 ContextEngine/Provider/文件系统，Executor 直接回调 Workflow，或 UserInteraction 直读领域内部状态；
- Agent/Model/Tool/Prompt 定义以散落常量绕过 AgentToolPool，或运行没有固定 DefinitionVersionRef/digest；
- Module Host、Shared Contracts、Persistence、Communication 或 Artifact Store 没有 Port、默认 adapter、装配位或边界测试；
- Protocol Registry 未覆盖目标设计第 6.5 节任一协议族，存在未登记跨模块对象，或 Unsupported handler 会返回假成功/改变状态；
- 模型可以直接执行文件或命令副作用；
- Agent 修改原始 checkout 或 workspace 外文件；
- 无步骤/token/时间上限；
- 测试失败仍报告成功；
- ContextPack 没有来源或 repository revision；
- 模块接口只能通过解析异常字符串或日志协作；
- 固定任务无法生成 diff、测试证据和统一报告；
- 五个 Module 只能整体启动，无法使用 fake/disabled adapter 独立测试。

## 10 降级顺序

工期不足时按以下顺序削减：

1. 从 5 个 fixture 减为 3 个，但必须保留未知文件定位和失败后再修复。
2. 减少命令类型，只保留项目测试必需命令。
3. 暂不实现进程内 cancel UI，只保留预算/超时终止。
4. ContextEngine 暂不做复杂排序，只保留文件树、rg、分块和 token 裁剪。

不得削减：五个 Module 与五项 Infrastructure 的架构插槽、UserInteraction/Kernel/Workflow 权威入口、Kernel Unit 路径、AgentToolPool DefinitionVersion、RuntimeProjection 回路、隔离 worktree、Context provenance、Workflow 步数预算、测试验收和边界 contract tests。可以削减的是这些插槽中的业务能力深度，而不是插槽本身。

## 11 M1 结束时交付物

- 可运行 CLI 和安装/启动说明；
- UserInteraction、Workflow、Kernel、ContextEngine、AgentToolPool 五个 Module；其中 UserInteraction 与 AgentToolPool 为明确受限的 M1 最小实现；
- Module Host、Shared Contracts、Persistence Platform、Communication Fabric、Artifact Store 五项 Infrastructure 的 Port、默认 adapter、fake 与装配测试；
- 版本化 Protocol Registry、全部协议族的 schema/Ref/Port 占位、Unsupported handlers 和兼容性测试报告；
- 一个模型 Provider adapter；
- 本地 workspace/tool executor；
- 路径/rg ContextEngine；
- 3–5 个固定 fixture repository；
- 单元、contract、集成和端到端测试；
- 每个任务的 diff、测试证据、用量和报告；
- 已知限制、M2 backlog 和需要进入 ADR 的问题清单。
- 一份关键数据线路的架构测试报告，证明后续升级可替换 adapter/放宽 capability，而不需要改写模块所有权或主调用方向。
