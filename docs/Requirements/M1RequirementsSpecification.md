# MultiAgentOS M1 软件需求规格说明书

> 文件名：`docs/Requirements/M1RequirementsSpecification.md`  
> 文档类型：Software Requirements Specification（SRS）  
> 文档状态：M1 需求基线  
> 需求版本：0.1.0  
> 适用里程碑：M1 / V1 Agent MVP  
> 范围权威：`docs/M1Plan/TargetM1.md`  
> 达成计划：`docs/M1Plan/M1AchievePlan.md`  
> 长期架构：`docs/DesignReport/TargetArchitecture.md`

## 1. 文档目的

本文以可验证的需求条目定义 MultiAgentOS M1 必须交付的产品行为、模块边界、公共协议、基础设施占位、质量属性和验收条件。本文回答“系统必须做到什么”；模块内部如何实现以目标设计和后续 ADR 为准。

当本文与其他文档冲突时：

1. M1 范围、完成定义与当前关键线路以 `TargetM1.md` 为准。
2. 四周排期与人员分工以 `M1AchievePlan.md` 为准。
3. 长期所有权、完整数据线路与演进约束以 `TargetArchitecture.md` 为蓝本，但不自动扩大 M1 功能范围。
4. 需求变更必须先修改权威文档，再同步本文、测试和实现。

## 2. 规范词与需求状态

- **必须**：M1 发布不可省略，必须具有验证证据。
- **不得**：禁止出现的行为；违反即阻断发布。
- **应**：默认要求；偏离时必须有 ADR 和等价保障。
- **可**：不影响 M1 验收的可选实现。

每个需求使用稳定 ID。状态值为 `PROPOSED`、`ACCEPTED`、`IMPLEMENTED`、`VERIFIED` 或 `DEFERRED`。本版所有列入 M1 的需求初始状态为 `ACCEPTED`；实际状态由需求追踪记录更新，不通过修改需求 ID 表达进度。

## 3. 产品范围

### 3.1 M1 产品目标

M1 必须交付一个本地、单用户、单项目、单进程、单 Agent、单活动 Task 的 coding Agent。用户提交简单软件工程目标后，系统必须能够理解小型陌生仓库、调用一个模型 Provider、执行受控工具、在隔离 Git worktree 中修改文件、运行测试，并输出 diff、测试证据和运行报告。

### 3.2 M1 架构目标

M1 必须为以下五个一级 Module 建立可编译、可装配、可独立测试的边界：

1. UserInteraction
2. Workflow
3. Kernel
4. ContextEngine
5. AgentToolPool

M1 必须为以下五项 Infrastructure 建立独立 package、Port、默认 adapter 和 contract test：

1. Module Host
2. Shared Contracts
3. Persistence Platform
4. Communication Fabric
5. Artifact Store

Executor 是受 Kernel 管辖的独立执行面，不是第六个一级 Module。M1 可以把实现部署在同一进程，但不得破坏逻辑边界。

### 3.3 M1 非目标

M1 不要求实现：多 Task/DAG、动态 replan、多 Agent、多 Executor Process 合并、PostgreSQL、DBOS、可靠消息、Lease/fencing、崩溃续跑、Checkpoint/Restore、Human Review、Web UI、MCP、语义检索、生产容器隔离、多租户、远程执行和完整可观测平台。

非目标能力可以具有协议占位和 Unsupported handler，但不得返回假成功或产生领域状态变化。

## 4. 用户与运行场景

### 4.1 主要用户

M1 的主要用户是通过本地 CLI 在已授权 Git 仓库中运行 coding Agent 的开发者。

### 4.2 主成功场景

1. 用户通过 CLI 提交仓库路径和目标。
2. UserInteraction 创建 WorkSession、PromptRevision 和 UserIntent。
3. Kernel 完成最小控制准入并向 Workflow 路由命令。
4. Workflow 创建 WorkflowRun、GraphRevision 0、根 MissionScope、TaskAttempt 和 AgentRun。
5. Workflow 从 AgentToolPool 固定 DefinitionVersion。
6. Workflow 通过 Kernel 请求 Context、模型、文件、命令和测试 Unit。
7. Kernel 调度对应执行面并验证返回结果。
8. Workflow 根据已提交结果继续循环或完成验收。
9. Kernel 生成 RuntimeProjection。
10. UserInteraction 展示最终状态、diff、测试证据、用量和失败原因。

## 5. 功能需求

### 5.1 UserInteraction

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-UI-001 | UserInteraction 必须是所有 M1 用户输入的唯一产品边界。CLI 不得直接调用 Workflow。 | 架构依赖测试、E2E |
| FR-UI-002 | UserInteraction 必须创建单个 WorkSession、首个 SessionTreeNode 和不可变 PromptRevision。 | 单元测试、集成测试 |
| FR-UI-003 | UserInteraction 必须把用户操作转换为经 schema 校验的 UserIntent，并交给 KernelControlPort。 | Contract test |
| FR-UI-004 | UserInteraction 必须只根据 RuntimeProjection 和公开 Query 结果展示运行状态。 | 架构测试、集成测试 |
| FR-UI-005 | M1 未支持的交互命令必须返回结构化 `UNSUPPORTED_CAPABILITY`。 | 负向测试 |

### 5.2 Workflow

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-WF-001 | Workflow 必须拥有 WorkflowRun、TaskGraph、GraphRevision、MissionScope、TaskRun/Attempt、AgentRun/Step 的业务状态。 | 单元测试 |
| FR-WF-002 | M1 TaskGraph 必须包含且只包含一个 Task，且不得包含 Edge。 | Schema/能力测试 |
| FR-WF-003 | Workflow 必须控制 Context → Model → Action → Observation → Final 循环。 | Fake 纵向测试 |
| FR-WF-004 | Workflow 必须执行步数、token、模型调用和时间预算限制。 | 边界测试 |
| FR-WF-005 | Workflow 必须根据测试证据和 workspace diff 决定业务成功，不得仅信任模型 FINAL 文本。 | E2E、负向测试 |
| FR-WF-006 | Workflow 对 Context、模型、工具、文件和命令的所有请求必须形成不可变 UnitIntent 并交给 Kernel。 | 架构测试 |
| FR-WF-007 | Workflow 不得直接导入或调用 ContextEngine、Provider、文件系统、shell 或 Executor 的实现。 | 依赖规则测试 |

### 5.3 Kernel

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-KER-001 | Kernel 必须是用户控制命令和所有真实副作用的准入边界。 | 集成测试 |
| FR-KER-002 | Kernel 必须校验 Unit schema、DefinitionVersion、workspace、路径、命令、预算、deadline 和 output contract。 | 单元/负向测试 |
| FR-KER-003 | Kernel 必须根据 Unit 类型把 Context Unit 路由到 ContextEngine，把 Model/Tool/Workspace Unit 路由到对应执行面。 | Contract test、集成测试 |
| FR-KER-004 | Kernel 必须创建和维护 UnitAttempt，并为每次执行生成审计记录。 | 单元测试、报告检查 |
| FR-KER-005 | Kernel 必须验证 Executor 返回的 attempt identity、结果 schema、大小和 Artifact 完整性后才能发布 UnitResult/Event。 | Contract test、故障测试 |
| FR-KER-006 | Kernel 必须汇总 Workflow Event 与执行状态，形成脱敏 RuntimeProjection。 | 集成测试 |
| FR-KER-007 | Kernel 不得替代 Workflow 判断 Task 是否成功。 | 架构测试、负向测试 |

### 5.4 ContextEngine

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-CTX-001 | ContextEngine 必须生成 RepositorySnapshot，并遵守 ignore 规则和 workspace 边界。 | fixture 测试 |
| FR-CTX-002 | ContextEngine 必须支持文件树、路径、文本和符号名称的最小检索。 | 检索测试 |
| FR-CTX-003 | ContextEngine 必须按 token 预算完成分块、去重、排序和裁剪。 | 单元测试 |
| FR-CTX-004 | ContextPack 必须不可变，并包含 repository revision、来源、token 统计和 provenance。 | Schema/contract test |
| FR-CTX-005 | ContextEngine 只能接受 Kernel 准入后的 Context Unit，不得接受 Workflow 或 Agent 的直接调用。 | 架构测试 |
| FR-CTX-006 | ContextEngine 不得修改 workspace 或判断业务成功。 | 负向测试 |

### 5.5 AgentToolPool

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-ATP-001 | AgentToolPool 必须通过 CatalogPort 提供 Agent、Model、Tool、Prompt 和 Contract 的 DefinitionVersion。 | Contract test |
| FR-ATP-002 | M1 可以使用内置只读目录，但 DefinitionVersion 必须具有稳定 ID、version、digest 和输入输出 Contract。 | 单元测试 |
| FR-ATP-003 | WorkflowRun 开始后必须固定所使用的 DefinitionVersionRef；目录变化不得静默改变既有运行。 | 集成测试 |
| FR-ATP-004 | AgentToolPool 不得执行 Unit、保存运行实例、持有真实 Secret 或作出授权结论。 | 架构测试 |
| FR-ATP-005 | 未支持的目录发布和兼容查询必须返回结构化 Unsupported 结果。 | 负向测试 |

### 5.6 Executor

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-EXE-001 | `apps/executor` 必须作为独立可执行应用与 Kernel 的领域实现分离，并实现 Shared Contracts 中的 kernel-unit 执行协议。 | 依赖规则测试 |
| FR-EXE-002 | Executor 只能接受 Kernel 发出的执行请求，不得接受 Workflow、Agent 或 UserInteraction 的直接请求。 | 架构测试 |
| FR-EXE-003 | Executor 必须在指定 workspace、超时、输出限制和命令约束内执行动作。 | 安全测试 |
| FR-EXE-004 | Executor 必须只向 Kernel 返回结构化 ExecutionResult、usage、diagnosticsRef 和 ArtifactRef。 | Contract test |
| FR-EXE-005 | Executor 不得判断 Task/Workflow 成功，不得自行扩大权限或执行范围。 | 负向测试 |

## 6. Infrastructure 需求

### 6.1 Module Host

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-HOST-001 | Module Host 必须作为独立 package 提供 Module/Adapter 注册表、生命周期、启动顺序和 health 接口。 | Contract test |
| FR-HOST-002 | `apps/control-plane` 必须是最终 composition root，只选择实现、组装依赖并调用 Module Host。 | 架构测试 |
| FR-HOST-003 | Module Host 不得决定 Task readiness、Unit 授权或业务成功。 | 负向测试 |

### 6.2 Shared Contracts

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-CON-001 | 所有跨边界消息必须由 TypeBox/JSON Schema 或等价单一 schema 工具定义并进行运行时校验。 | Schema tests |
| FR-CON-002 | Contracts 必须提供 Envelope、typed ID/Ref、ModuleError、ArtifactRef、WorkspaceRef 和 capability 协议。 | Contract coverage |
| FR-CON-003 | Protocol Registry 必须记录 schemaName、owner、version、capability 和 handler。 | Registry test |
| FR-CON-004 | Contracts 不得包含 Reducer、Policy 结论、调度、检索或业务执行实现。 | 依赖规则测试 |

### 6.3 Persistence Platform

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-PER-001 | M1 运行记录必须通过 Repository/Persistence Port 保存，领域层不得直接绑定文件路径格式。 | Contract test |
| FR-PER-002 | M1 文件 adapter 必须使用临时写入后原子替换或等价方式，避免公开半写入记录。 | 故障测试 |
| FR-PER-003 | PostgreSQL、事务、migration、Journal 和 Outbox/Inbox 能力在 M1 必须显式声明为 unsupported，而不是假实现。 | Capability test |

### 6.4 Communication Fabric

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-COM-001 | 所有跨 Module Command、Query、Event、Signal 和 Result 必须经过 Communication Port。 | 架构测试 |
| FR-COM-002 | M1 必须提供进程内 Router，并保留与异步 transport 相同的 Envelope 和 handler 语义。 | Contract test |
| FR-COM-003 | 可靠投递、去重和消费水位在 M1 未实现时必须明确报告 unsupported。 | Capability test |

### 6.5 Artifact Store

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-ART-001 | Artifact Store 必须保存不可变大对象，并生成包含 sha256、size 和 mediaType 的 ArtifactRef。 | Contract test |
| FR-ART-002 | 读取 Artifact 时必须验证内容 hash 和大小。 | 完整性测试 |
| FR-ART-003 | 跨模块消息不得内嵌超过限制的大对象，必须传递 ArtifactRef。 | Schema/负向测试 |
| FR-ART-004 | Retention、远程对象存储和 GC 在 M1 未实现时必须显式报告 capability 状态。 | Capability test |

## 7. 公共协议兼容需求

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-PRO-001 | Envelope 必须包含 schemaName、schemaVersion、messageType、messageId、producer、occurredAt、tenantId、projectId 和 correlationId。 | Schema test |
| FR-PRO-002 | 适用的 Envelope 必须携带 causationId、WorkSession、WorkflowRun、MissionScope、aggregate version 和 graphRevision。 | Schema/E2E |
| FR-PRO-003 | Command 必须携带 idempotencyKey；修改既有聚合时必须携带 expectedVersion。 | Schema test |
| FR-PRO-004 | Query result 必须携带 sourceVersion。 | Schema test |
| FR-PRO-005 | 消费方必须拒绝未知 major schema 和不合法 payload。 | 兼容性测试 |
| FR-PRO-006 | 向后兼容版本只能新增具有明确语义的可选字段；破坏性变化必须创建新 major schema。 | Fixture compatibility test |
| FR-PRO-007 | 未实现协议必须提供 typed opaque Ref、Port、capability 与 Unsupported handler。 | Registry test |
| FR-PRO-008 | 不得使用 `any`、无约束 metadata/extensions 或空成功响应规避协议版本治理。 | Schema lint |
| FR-PRO-009 | Unsupported handler 不得产生领域状态、副作用或假成功 Event。 | 负向测试 |

## 8. 数据与身份需求

| ID | 需求 | 验证方式 |
|---|---|---|
| FR-DATA-001 | M1 必须从创建时保留 WorkSession、PromptRevision、WorkflowRun、GraphRevision、根 MissionScope、TaskRun/Attempt、AgentRun/Step 和 Unit/Attempt 身份。 | E2E trace assertion |
| FR-DATA-002 | GraphRevision 在 M1 固定为 0，但必须作为协议字段存在。 | Schema/E2E |
| FR-DATA-003 | MissionScope 在 M1 只有根节点，但必须绑定 objective、预算、workspace 和执行谱系引用。 | Domain test |
| FR-DATA-004 | ContextPack、UnitIntent、UnitResult、DefinitionVersion 和 Artifact 发布后不得原地修改。 | 不变量测试 |
| FR-DATA-005 | 一个 Module 可以保存其他 owner 对象的 opaque Ref，但不得据此读取或修改 owner 内部状态。 | 架构/权限测试 |

## 9. 外部接口需求

### 9.1 CLI

M1 CLI 至少必须支持：

```text
multiagent run --repo <path> --prompt <text>
multiagent inspect <run-id>
multiagent report <run-id>
```

CLI 必须返回非零退出码表示确定性失败，并不得在普通输出中打印 Secret、完整 prompt、未脱敏模型原始输出或 workspace 外绝对路径。

### 9.2 Git workspace

- 所有修改必须发生在隔离 worktree。
- 原始 checkout 必须保持不变。
- 系统不得自动 commit、push、merge、部署或创建外部变更请求。
- 最终结果必须包含可验证 diff 和 base revision。

### 9.3 模型 Provider

- M1 只要求接入一个 Provider。
- 模型输出必须经过结构化 schema 校验。
- 模型输出只能是动作提案，不构成执行许可。
- Provider 错误必须映射为统一 ModuleError，不得把 SDK 异常字符串作为跨模块协议。

## 10. 非功能需求

### 10.1 安全

| ID | 需求 |
|---|---|
| NFR-SEC-001 | 必须拒绝绝对路径、`..`、symlink/junction 逃逸和 workspace 外访问。 |
| NFR-SEC-002 | 命令必须受 allowlist/denylist、参数长度、执行时间和输出大小限制。 |
| NFR-SEC-003 | 默认禁止外部网络和用户目录访问。 |
| NFR-SEC-004 | M1 subprocess 必须明确标记为非生产安全边界。 |
| NFR-SEC-005 | Secret 不得进入 prompt、日志、Artifact、错误消息或持久化明文字段。 |

### 10.2 兼容性与可演进性

| ID | 需求 |
|---|---|
| NFR-COMP-001 | 五个 Module 与五项 Infrastructure 必须分别拥有 package、公开 Port 和测试边界。 |
| NFR-COMP-002 | 后续能力必须通过增加 adapter、放宽 capability 或增加 schema 版本接入，不得改写关键调用方向。 |
| NFR-COMP-003 | `apps/*` 可以依赖 `packages/*`；领域 packages 不得依赖任何 app。`apps/executor` 不得依赖 Kernel 内部实现。 |
| NFR-COMP-004 | Workflow、Kernel、ContextEngine、AgentToolPool 和 UserInteraction 不得导入彼此的内部目录。 |
| NFR-COMP-005 | 所有 adapter 必须通过对应 Port 的共享 contract test。 |

### 10.3 可靠性

| ID | 需求 |
|---|---|
| NFR-REL-001 | M1 必须在步数、token、时间或模型调用预算达到上限时确定性停止。 |
| NFR-REL-002 | 进程崩溃可以使当前运行失败，但不得宣称已自动恢复或 exactly-once。 |
| NFR-REL-003 | 文件清理失败、工具超时和模型格式错误必须产生结构化失败报告。 |
| NFR-REL-004 | 测试失败时不得将 WorkflowRun 报告为成功。 |

### 10.4 可观测性

| ID | 需求 |
|---|---|
| NFR-OBS-001 | 每次模型和工具执行必须具有 correlationId、causationId、开始/结束时间和结构化状态。 |
| NFR-OBS-002 | 报告必须包含步骤、工具调用、模型用量、测试、diff、耗时和失败分类。 |
| NFR-OBS-003 | 日志不得作为跨模块事实源；大诊断内容必须通过受控 ArtifactRef 表达。 |

### 10.5 工程与可移植性

| ID | 需求 |
|---|---|
| NFR-ENG-001 | 项目必须使用 Node.js LTS、TypeScript strict 和 pnpm workspace。 |
| NFR-ENG-002 | 根 lockfile 必须提交到版本控制，所有开发者和 CI 使用同一包管理器版本。 |
| NFR-ENG-003 | Windows 路径、symlink/junction、进程树终止和 Git worktree 行为必须具有专项测试。 |
| NFR-ENG-004 | M1 必须至少在受支持的 Windows 开发环境完成固定任务集验证。 |

## 11. 运行与开发依赖

### 11.1 系统依赖

| 依赖 | 最低/约束 | 用途 |
|---|---|---|
| Node.js | `>=22.13.0`，推荐当前 LTS | 主运行时 |
| pnpm | 根 `packageManager` 固定版本 | Monorepo 与 lockfile |
| Git | 支持 worktree 的受支持版本 | 隔离 workspace、diff |
| ripgrep | 支持 PCRE2 的受支持版本 | M1 文本检索 |

### 11.2 M1 npm 依赖类别

- 工具链：TypeScript、tsx、Vitest、fast-check、ESLint、Prettier。
- 契约：TypeBox、Ajv、ajv-formats。
- CLI：Commander。
- 模型：AI SDK、dotenv 和一个 Provider adapter。

PostgreSQL、DBOS、Kysely、Testcontainers、MCP、Playwright、OpenTelemetry、React 和容器 SDK 不属于 M1 初始依赖。

## 12. 固定任务集与验收

### 12.1 固定任务集

| ID | 场景 | 主要验证 |
|---|---|---|
| F1 | 已知相关文件，修复失败测试 | 基本 Agent 闭环 |
| F2 | 未知目标文件，根据错误定位缺陷 | Context 检索 |
| F3 | 修改两个相关文件解决接口不一致 | 多轮上下文与编辑 |
| F4 | 新增小功能并补充测试 | 结果验收 |
| F5 | 首次修改失败，再次观察并修复 | 多轮循环与失败处理 |

### 12.2 M1 接受标准

| ID | 接受标准 |
|---|---|
| AC-001 | 至少一个真实模型完成至少一种固定简单编码任务。 |
| AC-002 | 任务完整经过 UserInteraction → Kernel → Workflow，并通过 Kernel Unit 路径使用 ContextEngine/Executor。 |
| AC-003 | 运行使用 AgentToolPool 返回并固定的 DefinitionVersionRef/digest。 |
| AC-004 | 五个 Module、五项 Infrastructure 与 Executor 均具有公开边界和对应测试。 |
| AC-005 | 原始 checkout 未改变，最终交付 diff 和测试证据。 |
| AC-006 | ContextPack 包含来源、revision、token 统计和 provenance。 |
| AC-007 | Protocol Registry 覆盖目标设计规定的全部协议族。 |
| AC-008 | 架构测试可以阻止已定义的绕过路径和非法依赖。 |
| AC-009 | 所有未实现协议确定性返回 Unsupported，且不产生状态变化。 |
| AC-010 | 统一报告包含步骤、调用、用量、测试、diff、耗时和失败分类。 |

## 13. 发布阻断条件

以下任一情况阻断 M1：

- 任一一级 Module 或 Infrastructure 架构插槽缺失。
- CLI 绕过 UserInteraction/Kernel 直接创建 WorkflowRun。
- Workflow 直连 ContextEngine、Provider、文件系统、shell 或 Executor。
- Executor 接受非 Kernel 请求或直接向 Workflow 回调。
- AgentToolPool 定义被散落常量绕过，或运行未固定 DefinitionVersion。
- 模型可以直接执行工具副作用。
- Agent 修改原始 checkout 或 workspace 外文件。
- 测试失败但报告成功。
- ContextPack 缺少 provenance 或 repository revision。
- Protocol Registry 存在未登记跨模块对象。
- Unsupported handler 返回假成功或产生状态变化。
- 模块只能整体启动，无法使用 fake/disabled adapter 独立测试。

## 14. 需求追踪矩阵

| 需求范围 | 权威设计 | 主要验证资产 |
|---|---|---|
| FR-UI-* | `TargetM1.md` 第 4、6、7 节 | UserInteraction contract/E2E |
| FR-WF-* | `TargetM1.md` 第 5、7 节 | Workflow unit/fake loop |
| FR-KER-* | `TargetM1.md` 第 6–8 节 | Kernel contract/security |
| FR-CTX-* | `TargetM1.md` 第 4、6、11 节 | Context fixture/regression |
| FR-ATP-* | `TargetM1.md` 第 4、6 节 | Catalog contract tests |
| FR-EXE-* | `TargetM1.md` 第 4、8、9 节 | Executor contract/security |
| FR-HOST/CON/PER/COM/ART-* | `TargetM1.md` 第 4、6、9 节 | Infrastructure contracts |
| FR-PRO-* | `TargetM1.md` 第 6、10 节 | Protocol compatibility suite |
| NFR-* | `TargetM1.md` 第 8–11 节 | Security/architecture/E2E |
| AC-* | `TargetM1.md` 第 11 节 | M1 release report |

每个自动化测试应在名称、tag 或测试 metadata 中引用至少一个需求 ID。每个 `AC-*` 在发布报告中必须链接到测试运行、Artifact、diff 或审查结论；仅写“通过”不构成验证证据。

## 15. 需求变更控制

1. 已接受需求的语义变化必须提交变更说明、影响分析和对应测试修改。
2. 需求删除必须说明替代保障或明确移出 M1，并同步 `TargetM1.md`。
3. 新跨模块对象必须先登记 Protocol Registry、owner、schemaName 和兼容策略。
4. 新 package 必须说明其独立所有权、依赖重量、运行边界或发布理由；不得只为整理文件而拆包。
5. M1 验收前需求版本保持 `0.x`；达到固定任务集和兼容性验证后再评估稳定 `1.0`。
