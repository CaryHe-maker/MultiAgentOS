# MultiAgentOS Context Engine

## 1. 定义与边界

ContextEngine 决定模型在每一轮能够看到的内容。它生成仓库概览、检索相关代码，并将任务、历史观察和运行状态组装为不超过 token 预算且来源可追踪的 ContextPack。

ContextEngine 负责：

- 读取仓库快照、文件树、ignore 规则和 repository revision；
- 执行路径、文本和符号名称检索；
- 分块、去重、确定性排序和预算裁剪；
- 生成不可变 ContextPack、诊断信息和 provenance；
- 组装稳定前缀、历史观察和状态栏；
- 维护 AgentRun 范围内的检索台账。

ContextEngine 不修改工作区，不执行项目命令，不直接调用模型，不决定业务成功，不拥有系统提示词或工具定义，也不把输入渲染为供应商专用消息格式。

ContextEngine 为 CONTEXT 类 Unit 提供执行能力，但不拥有 UnitDefinitionVersion 或 ExecutorDefinitionVersion。相关静态定义由 AgentToolPool 发布；ContextEngine 只实现这些定义声明的 capability 与 Contract。

## 2. 调用关系

```text
Workflow -> CONTEXT UnitIntent -> Gateway 验证租约 / Core 必要裁决
-> Execution 幂等创建 UnitAttempt -> Scheduler 调度 / Monitor 预留额度
-> Execution 经受控执行契约协调 ContextEngine -> ContextPack / ArtifactRef
-> 候选 UnitResult -> Kernel 确认与结算 -> Workflow
```

CONTEXT 能力在模块内执行；ContextEngine 是满足 CONTEXT capability 的运行时执行目标，Execution 维护 UnitAttempt 与 Tool 步骤，Kernel Gateway/Core 负责准入，Scheduler 选择运行时实例，Supervisor 监管执行环境。ContextEngine 必须校验执行关联、固定定义、deadline 和数据范围；Permit 是适用 Lease 对本次执行的受限投影，不由 ContextEngine 签发，也不在模块内另建授权政策。有效租约不免除执行记录、资源限制和结果确认。需要模型或外部重计算的上下文操作必须交由 Workflow 形成相应 UnitIntent 并经 Kernel 准入；模型调用通过 Execution 的模型网关执行，不得由 ContextEngine 直接访问模型服务。

## 3. 操作

| operation | 触发条件 | 输入 | 输出 |
|---|---|---|---|
| ORIENT | 运行开始 | objective、workspace、预算 | 仓库概览 Pack |
| SEARCH | 模型请求检索 | query、mode、maxItems | 排序后的检索 Pack |
| ASSEMBLE | 每次模型调用前 | 指令、工具、ORIENT、步骤历史、状态 | 有序模型输入 Pack |

典型序列：

```text
ORIENT -> ASSEMBLE -> MODEL
       -> (SEARCH -> ASSEMBLE -> MODEL)*
       -> (FILE_READ -> ASSEMBLE -> MODEL)*
       -> FINAL
```

### 3.1 ORIENT

ORIENT 按以下顺序组装内容，默认不超过 2,500 token：

1. 根目录 `AGENTS.md` 或 `CLAUDE.md`，最多 800 token；
2. 深度不超过 3 的目录树摘要；
3. 项目清单文件的名称、脚本和主要依赖；
4. README 前 60 行；
5. 与 objective 相关的顶层符号大纲；
6. 测试目录和测试文件命名模式。

同一 AgentRun 只生成一次 ORIENT，其内容作为稳定前缀的一部分复用。

### 3.2 SEARCH

搜索模式为 `AUTO | TEXT | PATH | SYMBOL`，默认最多返回 8 项，上限 20 项。处理顺序固定为：

```text
查询规范化 -> 多路召回 -> 命中分块 -> 确定性排序 -> 台账去重 -> 预算裁剪 -> 发布
```

AUTO 根据查询形态选择路径、文本和符号检索。零结果必须返回空 items 与建议，不得通过加入无关结果伪造召回。

### 3.3 ASSEMBLE

输出分段固定为：

| segment | 内容 | 稳定性 |
|---|---|---|
| PREFIX | 指令、工具、任务、ORIENT | AgentRun 内字节级稳定 |
| HISTORY | 动作和 Observation | 只追加；批量压缩时改写旧段 |
| STATUS | 步骤、预算、已读文件、未确认项和错误 | 每轮更新且始终位于末尾 |

PREFIX 的顺序为 `INSTRUCTIONS -> TOOLS -> TASK -> MEMORY -> TREE -> MANIFEST -> OUTLINE`。PREFIX 不得包含时间戳、随机 ID 或外部不可信内容；每次输出 `prefixSha256`。

## 4. 快照、检索与排序

- `repositoryRevision` 取自 WorkspaceRef，并在运行内保持不变。
- `snapshotId = sha256(排序后的 [相对路径, 大小, 修改时间] 列表)`。
- 命中窗口默认向上 12 行、向下 24 行；重叠或相距少于 5 行的窗口合并。
- 单块最多 120 行；输出为带行号文本。
- 同分按 path 字典序和 startLine 升序，保证结果可复现。
- 单文件不得占用超过 SEARCH 预算的 40%。

排序使用可解释的确定性信号：符号定义、精确标识符、路径相关性、实现/测试关联和词项覆盖率；已出现内容与生成文件降低排序。每个 ContextItem 的 `reason` 必须说明主要得分来源。

## 5. 检索台账与去重

每个 AgentRun 拥有独立 RetrievalLedger，记录 snapshotId、查询和已发布内容的 hash/行范围。以下任一条件视为重复：

- `contentSha256` 相同；
- 与已发布块的行范围重叠超过 70%。

重复块不再次发布全文，只返回首次出现的步骤、路径和行范围。

## 6. token 预算

默认 ASSEMBLE 预算为 64,000 token，并应用 0.9 安全系数。STATUS 最多 400 token；单条 Observation 最多 3,000 token。

- 最近 6 步保留完整内容，但仍受单条 Observation 上限约束。
- HISTORY 使用量超过可用预算的 85% 时触发批量压缩，目标降至 60%。
- 每批默认压缩 8 个最旧步骤，生成确定性的 DIGEST。
- 最近一步 Observation 不得压缩。
- PREFIX、最近一步和 STATUS 无法装入时返回 `CONTEXT_BUDGET_INSUFFICIENT`。

TokenEstimator 使用可替换接口。默认估算：ASCII 约 4 字符/token，CJK 约 1 字符/token，其他字符约 2 字符/token。模型调用后记录估算值与实际用量的偏差。

## 7. 安全规则

1. 遵守 `.gitignore`，固定排除 `.git`、`node_modules`、`dist`、`build`、`coverage` 和 `.multiagent`。
2. 排除 lock、minified、source map、二进制和超过 256 KiB 的文件。
3. `.env*`、私钥、证书、credentials 和 secrets 文件永不进入 Pack。
4. 路径必须在 `realpath` 后仍位于工作区根目录内；symlink 或 junction 越界返回 `WORKSPACE_ESCAPE`。
5. 搜索命令使用参数数组，不拼接 Shell 字符串；默认超时 3,000 ms。
6. 搜索后端不可用时使用内置扫描并标记 `DEGRADED_SEARCH`；两种后端通过同一套契约测试。

## 8. 默认配置

| key | value |
|---|---:|
| `orientBudget` | 2,500 |
| `searchMaxItems` | 8 |
| `observationMaxTokens` | 3,000 |
| `recentStepsFull` | 6 |
| `compactTriggerRatio` / `compactTargetRatio` | 0.85 / 0.60 |
| `compactBatchSize` | 8 |
| `statusMaxTokens` | 400 |
| `contextBefore` / `contextAfter` / `chunkMaxLines` | 12 / 24 / 120 |
| `perFileShareMax` | 0.4 |
| `maxFileBytes` | 262,144 |
| `searchTimeoutMs` | 3,000 |
| `estimatorSafetyFactor` | 0.9 |

## 9. 错误与验证

| code | category | retryable |
|---|---|---:|
| `CONTEXT_REQUEST_INVALID` | VALIDATION | false |
| `WORKSPACE_ESCAPE` | POLICY | false |
| `WORKSPACE_UNAVAILABLE` | RESOURCE | false |
| `CONTEXT_BUDGET_INSUFFICIENT` | RESOURCE | false |
| `SEARCH_TIMEOUT` | TIMEOUT | true |
| `SEARCH_BACKEND_UNAVAILABLE` | DEPENDENCY | false |
| `ARTIFACT_UNREADABLE` | INTEGRITY | false |
| `CONTEXT_INTERNAL` | INTERNAL | false |

测试至少覆盖 Schema 正反例、Unit/Executor 定义与 Permit 匹配、无 Permit 调用拒绝、路径逃逸、敏感文件、检索排序、分块、去重、预算、稳定前缀、批量压缩、不可变输出和后端降级。检索评测使用 Recall@k 与 MRR；端到端评测记录来源召回率、准确率、结论命中、token、成本、耗时和稳定性。

ContextRequest 与 ContextPack 的字段必须通过共享 Contract 发布并执行运行时校验。

## 10. 长期领域模型

| 对象 | 语义 |
|---|---|
| ContextRecord | 规范化来源、内容 hash、ACL、revision、数据等级和生命周期 |
| RepositorySnapshot | 仓库在明确 revision 下的文件与结构事实 |
| IndexRevision | 一次完整可查询索引的不可变版本 |
| RetrievalResult | 查询、候选、得分、过滤和丢弃原因 |
| ContextPack | 面向一次 Agent/Review/Task 的不可变上下文发布物 |
| RetrievalLedger | AgentRun 内已检索、已展示和诊断记录 |
| MemoryRecord | 经策略允许的项目、运行或用户记忆；带来源、有效期和删除传播 |

索引、缓存和 RetrievalResult 均为可重建派生数据；来源 Artifact、Repository revision 和 Owner 记录才是事实依据。ContextEngine 不得以索引结果反向覆盖来源。

## 11. MissionScope 与任务感知

ContextPack 的主定位键为 `missionScopeId + graphRevision`。Goal Lineage Materializer 沿 MissionScope 父链构造根目标、祖先决策、当前子目标和验收条件；Task Awareness 只装配当前 Scope 内及存在数据依赖的最小 TaskGraph 切片，包括 READY/BLOCKED 原因、上游 Artifact 和下游输出要求。

检索完成后必须再次按 MissionScope 数据范围、Artifact ACL、repository/index revision 和 token 预算过滤。兄弟 Scope、旧 GraphRevision、已撤销 Artifact 或无权来源不得进入 Pack，即使它们在共享索引中命中。

## 12. 混合检索与索引生命周期

检索管线可以组合 keyword、path、symbol、vector、graph 和 rerank Adapter，但必须保持：

1. 多路召回结果先规范化为统一候选；
2. ACL 和 revision 在召回后再次过滤；
3. 排序配置、模型、索引版本和查询规范化规则可追踪；
4. rerank 不得移除 provenance 或引入未授权正文；
5. 同一输入与确定性 Adapter 的结果稳定；非确定性 Adapter 记录模型和 seed/配置；
6. 新索引构建完成并验证后原子切换，查询不得看到半构建版本；
7. 来源删除、权限变化或 revision 失效必须传播到索引和缓存。

IndexRevision 至少绑定数据源水位、分块版本、embedding/symbol 工具版本、ACL 策略版本和构建 hash。索引失败时继续使用明确标记为 stale 的兼容版本或返回 DEGRADED，不得混合未知版本。

## 13. 记忆

记忆分为运行观察、项目事实和用户偏好。写入记忆前必须明确 Owner、来源、适用范围、数据等级、有效期和删除策略；模型生成摘要不能覆盖原始来源。跨 WorkSession 记忆必须经明确策略和 ACL，禁止把临时 Prompt、Secret 或未经确认的推断自动升级为长期事实。

## 14. 人类审核证据

审核所需证据由 Kernel 授权的 Context Unit 请求。ContextEngine 只在审查者 ACL、ReviewRequest 数据范围和 token 预算内生成 EvidenceRef/摘要；不得因审核角色自动扩大访问范围。证据必须绑定 requestVersion、parametersHash、revision 和 provenance，参数变化后重新生成。

## 15. Checkpoint 与恢复

SessionCheckpoint 若要求精确重现 ContextPack，应将 Pack 物化为不可变 Artifact 并保留；否则保存来源引用、ACL 范围、IndexRevision 和 rebuild recipe。ContextEngine 不回滚共享索引。

恢复动作返回 `REUSED`、`REBUILT`、`STALE` 或 `INCOMPATIBLE`，并附来源和诊断。即使复用历史 Pack，恢复时仍需按当前身份、ACL、DefinitionVersion 和数据撤销状态重新验证；不得从 checkpoint 复活旧 Lease、Permit 或执行会话，当前资格由 Kernel 重新确认。

## 16. 可观测性

记录查询类型、IndexRevision、召回数量、ACL/revision 过滤数量、排名理由、去重、预算丢弃、prefix hash、token 估算偏差、缓存命中、搜索耗时和降级原因。日志不得包含完整源码、Prompt、Secret 或敏感路径正文；诊断使用受控 Artifact。
