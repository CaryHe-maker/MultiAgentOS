# 架构讨论会议纪要（2026-09-20）

## 会议概览

- 时长：约 2 小时
- 主题：MultiAgentOS 的总体架构、模块边界、状态恢复、权限隔离、上下文与 Session，以及 V1 的落地方式。
- 目标：从总体愿景进入可拆分、可分工、可实现的设计阶段。

> 本纪要将“已达成共识”“存在分歧”和“待验证设想”分开记录。转写中未能稳定对应每位成员的姓名，因此负责人以模块角色标记，发布前请补充姓名。

## 本次已确定的结论

### 1. 三个核心模块已完成负责人划分

| 模块 | 负责人 | 负责范围 |
|---|---|---|
| Workflow | Workflow 负责人（姓名待补） | WorkflowRun、TaskGraph、Task/Attempt、依赖、状态机、重试、回退、重规划与验收流程 |
| Kernel | Kernel 负责人（姓名待补） | 执行准入、资源调度、生命周期、租约/中断、权限签发与执行隔离 |
| ContextEngine | Context 负责人（姓名待补） | 上下文构建、代码/文档检索、摘要、检索结果组织与 ContextPack |

`AgentToolPool` 暂不作为当前优先实现模块。其本质是 Agent、Tool、Model、Prompt 与 Contract 的版本化定义目录；可以在 Workflow、Kernel、Context 的接口稳定后再细化。

### 2. 总体架构仍采用“四模块 + 独立基础设施”

四个一级模块为：

- Workflow：定义任务语义和因果关系，不直接运行模型或工具。
- Kernel：掌握权限、资源、调度与实际执行入口。
- ContextEngine：按目标、权限和预算构造可用上下文。
- AgentToolPool：保存静态、可版本化的 Agent/Tool 定义，不保存运行中状态或密钥。

独立基础设施为 Module Host、Shared Contracts、Persistence Platform、Communication Fabric 与 Artifact Store。基础设施提供跨模块能力，但不应取代模块对业务状态的所有权。

### 3. V1 应先跑通一条端到端纵切流程

第一版的目标不是实现完整企业级 AgentOS，而是能从创建任务稳定运行到得到结果，并至少验证一次失败/恢复或重试。建议的最小链路为：

```text
用户目标
  → Workflow 创建 Research / Coding Task
  → AgentRun 选择某个 Agent 定义
  → ContextEngine 生成 ContextPack
  → Kernel 鉴权、调度并执行 Unit
  → 结果与证据写入 Artifact Store
  → Kernel 发布执行结果事件
  → Workflow 推进 Task 状态并生成 Run Report
```

并行是后续在任务独立、资源充足、写入范围不重叠时启用的能力，而不是 V1 必须追求的默认行为。

## 讨论议题与主要观点

### A. Workflow、Task、AgentRun 与 Unit 的关系

会议围绕“一个 Agent 内部有多步调用时，最小执行单元是什么”展开讨论。

- 一个 AgentRun 可经历取上下文、生成 prompt、模型调用、工具调用、结果判断等多个步骤。
- Unit 被定位为交给 Kernel 调度和交由运行环境执行的最小受控操作，也是返回执行结果的基本粒度。
- Task 是具有业务目标和验收条件的逻辑工作；一次失败或重试可产生多个 Attempt 与多个 Unit。
- 当工具失败时，系统应记录失败结果，并让 Workflow/AgentRun 根据 checkpoint 产生新的后续 Unit；不应直接修改旧 Unit 的历史。

结论：需要继续在 Contract 中明确 `TaskRun`、`TaskAttempt`、`AgentRun`、`Unit` 与 `UnitAttempt` 的层次和状态归属，避免所有对象混入同一个状态机。

### B. Process Scope Tree（任务监督树）

Process Scope Tree 是当前方案的主要差异化设计之一。

- 它向子 Agent 传递任务来源、父级目标、预算、可见范围、取消边界和能力上限。
- 子 Agent 可感知自己在整体任务中的位置，以及必要的兄弟任务摘要，从而降低并行任务重复劳动的概率。
- 它可成为权限申请范围的依据：Agent 只能在所属 Scope 的能力上限内向 Kernel 请求权限。

共识：Process Scope Tree 不等同于普通的任务依赖图。`TaskGraph` 负责“谁依赖谁”；`ProcessScope` 负责“谁监督谁、谁能看到什么、谁能取消谁、资源与权限边界是什么”。

待验证：兄弟 Scope 默认应只看到经过筛选的任务摘要或公开契约，不应自动共享完整上下文与原始对话。

### C. DBOS 与恢复/回退

会议确认拟使用 DBOS 作为 durable workflow runtime 的实现基础。

- DBOS 用于保存 durable step/checkpoint，使服务崩溃后能从已提交的持久化点恢复控制流。
- checkpoint 可支持失败恢复、用户更改目标后的分支/重规划，以及任务级重试。
- DBOS 不等于“保存任意 API 调用的中间内存”；外部副作用、工具输出、代码改动和大文件仍需显式持久化为事件或 Artifact。

待细化：用户修改目标时，优先采用 revision / fork / compensation 的可追踪方式，而不是抹掉旧历史后任意跳回过去。

### D. 状态机、正常中断与异常

讨论区分了两类情况：

- 正常控制流：用户暂停/改目标、Agent 主动回退、工具失败后的受控重试。这些应由 Workflow 状态机、checkpoint 与重规划处理。
- 运行异常：代码违反不变量、越权调用、执行器崩溃、超时、外部系统失败等。这些应被结构化记录、隔离并转换为可恢复失败或人工介入。

建议状态包括 `pending → ready → running → succeeded / failed / blocked / cancelled`。其中 `ready` 表示依赖与策略满足、可交给 Kernel 调度；不是 `running` 之后的状态。

对于开发期“不可能发生”的编程错误，可使用语言断言或 panic/fail-fast；但不可把所有运行时失败都等同于 panic 后杀死整个系统。

### E. Kernel、Communication Fabric 与权限边界

这是本次最集中的分歧之一。

共同认可的原则：

- Agent 不直接执行任意命令、不直接扩大权限，也不直接篡改其他模块状态。
- Kernel 是执行准入和权限裁决的唯一入口：收到 UnitIntent / PermissionRequest 后，完成策略检查、资源分配、授权和执行。
- Workflow 是任务语义和状态推进的唯一裁决者；Kernel 只能报告事实性结果，不应直接修改 Workflow 的业务状态。

存在的实现分歧：

1. 鉴权能力应作为 Kernel 内部二级组件，还是独立的鉴权服务；
2. 跨模块通信是直接调用、进程内消息总线，还是“邮箱式”异步通信；
3. 系统更接近微内核、混合内核还是模块化单体。

当前工作结论：V1 先采用模块化单体与进程内的结构化 Command / Query / Event / Signal 接口。不要为了模拟操作系统而过早拆出网络鉴权服务器或微服务。将来出现跨机器、跨租户、独立密钥域或独立部署需求时，再评估独立 PolicyAuthority / AuthZ Service。

补充原则：网络端口或 MCP 风格服务本身不构成安全边界；实际隔离仍依赖运行进程身份、rootless sandbox、文件/网络/命令 allowlist、资源限制和短时能力令牌。

### F. ContextEngine 与上下文管理

团队确认上下文管理与并行同样是项目的核心难题，并将在优化阶段成为主要性能和质量投入方向。

- ContextEngine 是一级模块，负责代码/文档检索、结构化索引、自然语言检索、重排、摘要和 token 预算内的 ContextPack 组装。
- 计划技术方向包括 ripgrep、tree-sitter、SCIP、PostgreSQL/pgvector 与 reranker。
- Agent 不应自行读取全部仓库、全部聊天历史或所有其他 Agent 的上下文；它只接收经过权限过滤和任务定向的 ContextPack。
- 长对话与初始提示词被淹没的问题，可以通过阶段性摘要、子任务产物、版本化 Artifact 和明确的 ContextPack 来缓解，而不是让 Agent 间无边界转发完整对话。

待研究：检索排序、代码符号级上下文、摘要更新策略、Session 级记忆与跨任务共享信息的精确模型。

### G. AgentToolPool 与 Researcher 示例

以网络收集 Researcher 为例，讨论明确了“定义”与“运行实例”的区别：

- AgentToolPool 中的 `Researcher@v1` 只描述能力：允许的工具、输入/输出 Schema、Prompt 模板、所需能力、产物格式与版本。
- 当 Workflow 创建某次 AgentRun 时，才会填入具体任务，例如“检索奥克兰大学的相关信息”、允许站点、时限、Scope 与输出要求。
- Researcher 返回的网页快照、引用、长报告应写入 Artifact Store；Workflow 持有摘要与 `ArtifactRef`，而不是把大段原文塞入数据库或跨模块消息中。

待办：为第一批 Agent 定义最小输入输出契约，避免只以自然语言描述能力。

### H. 五项基础设施的边界

| 基础设施 | 会议中的定位 |
|---|---|
| Module Host | 初始化、装配、启动与关闭模块；不拥有工作流语义 |
| Shared Contracts | 存放跨模块 Schema、事件、错误码与版本；不应成为无边界公共类目录 |
| Persistence Platform | 数据库、事务、Outbox/事件日志、checkpoint；事务保证原子写入，事件传递已发生事实 |
| Communication Fabric | 传输 Command、Query、Event、Signal；不替业务模块作决定 |
| Artifact Store | 保存不可变的大对象，如日志、网页快照、diff、测试报告、ContextPack 与代码快照引用 |

补充：代码变更应主要由 Git/worktree 与 commit/diff 管理；Artifact Store 保存可审计证据和引用；数据库保存结构化元数据、状态和索引。

### I. Project、Session、WorkflowRun 与 checkpoint

讨论提出需要为用户工作对象和机器执行对象建立不同的抽象层。

- 用户/Agent 面向的工作对象可包括 Project、Session、WorkflowRun、Task、Attempt 等。
- 系统内部执行对象包括 ProcessScope、AgentRun、Unit、Lease、ExecutionPermit 等。
- 需要避免把 Project、Session、一次 WorkflowRun 与 checkpoint 混为同一概念：一个 Project 可以有多个 Session；一个 Session 可有一次或多次 Run；一个 Run 会有多个 checkpoint。

待办：补充 Session / Project 的最小数据模型和用户可见的恢复入口，但不将多 Session 协作列为 V1 阻塞项。

### J. Git 工作日志与审计

提出“是否建立单独工作日志仓库”的问题。

当前倾向：不为 V1 新建独立日志 Git 仓库。

- Git 负责源代码、worktree、commit、PR 与 diff。
- Persistence Platform 的 event journal 负责状态变化与审计时间线。
- Artifact Store 负责命令输出、测试报告、网页证据与大对象。
- Run Report 汇总执行过程、失败、重试、批准和最终验收结果。

## 主要争议汇总

| 议题 | 一方关注点 | 另一方关注点 | 当前处理方式 |
|---|---|---|---|
| Kernel 与 Fabric | 权限与通信应尽量收进 Kernel，以减少越权面 | 跨模块通信是公共基础设施，不应被 Kernel 垄断 | Kernel 管执行准入；Fabric 只提供受控传输 |
| 微内核/混合内核 | 高内聚、通信效率与较少组件 | 动态替换、模块独立与未来演进 | V1 用模块化单体，不提前承诺 OS 式内核形态 |
| 独立鉴权服务 | 希望借助进程/网络边界实现更强隔离 | 早拆服务会增加复杂度且不天然安全 | V1 内置 PolicyAuthority + PEP；未来按部署需要拆分 |
| Scope Tree 与共享信息 | Agent 需要感知整体任务以避免重复 | 不可暴露所有任务与上下文 | 传播受筛选摘要、契约与 ArtifactRef；默认最小可见 |
| 并行与上下文的优先级 | 并行是项目亮点 | 上下文质量决定 Agent 是否真正可用 | V1 只做受限并行；ContextEngine 是核心投入 |
| Session 间协作 | 希望支持 Project 下多个工作会话共享信息 | 原始 prompt fork 不能自动保证一致性 | 以版本化 contract/artifact/context catalog 解决，延后完整协作功能 |

## 范围、投入与里程碑

- 团队成员预计每周可投入约 10–20 小时；个别成员在近期可投入更多时间。
- 曾提出在 11 月初前完成第一版“可创建项目、运行工作流并产出结果”的目标。
- 该目标应收缩为可重复演示的纵切版本，而非完整实现所有四模块、五项 infrastructure 和高级多 Agent 协作。

建议 V1 验收标准：

1. CLI 能创建一个 `WorkflowRun`；
2. 能接收并校验结构化 Plan；
3. 能调度至少两个无写入冲突的任务；
4. 能在受限 worktree / subprocess 中执行任务并收集结果；
5. 能保存状态、日志、diff 与测试证据；
6. 能在一次模拟失败后重试或恢复；
7. 能输出可读的 Run Report。

明确延后：独立鉴权服务器、跨 Session 自动协作、复杂动态重规划、完整 ProcessScope 权限继承、生产多租户、远程 Worker、微虚拟机隔离与完整 UI。

## 后续行动项

| 行动 | 产出 | 负责人 | 优先级 |
|---|---|---|---|
| 固化核心对象与状态归属 | `WorkflowRun`、Task/Attempt、AgentRun、Unit/UnitAttempt、ArtifactRef 的 Schema 草案 | Workflow 负责人 | P0 |
| 定义 Kernel 执行入口 | `UnitIntent`、`ExecutionPermit`、执行结果、失败/取消/超时契约 | Kernel 负责人 | P0 |
| 设计最小 ContextPack | 输入来源、权限过滤、token 预算、检索结果与 ArtifactRef 输出 | Context 负责人 | P0 |
| 选定首个纵切 demo | 一个固定任务及成功/失败验收条件 | 全体 | P0 |
| 定义第一批 Researcher/Worker 契约 | 输入 Schema、输出 Schema、允许工具、产物形式 | Workflow + Context | P1 |
| 明确通信语义 | Command / Query / Event / Signal 的最小集合与消息所有者 | Workflow + Kernel | P1 |
| 补充权限模型 | Scope 能力上限、工具 allowlist、审批与 capability token 生命周期 | Kernel | P1 |
| 编写 Session/Project 草案 | Project、Session、Run 与 checkpoint 的关系图和最小接口 | Context + Workflow | P2 |

## 下次会议建议议程

1. 展示三份模块边界与最小接口草案；
2. 共同审阅第一个纵切场景的时序与失败路径；
3. 锁定 V1 的验收用例、任务拆分和一周内可交付物；
4. 仅对影响接口的议题做决策，其余架构设想进入设计备忘录，不阻塞编码。
