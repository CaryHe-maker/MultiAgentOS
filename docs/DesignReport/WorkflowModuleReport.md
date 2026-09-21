# Paralleling AgentOS Workflow 模块详细设计报告

> 文档类型：Workflow Module 完整目标详细设计  
> 文档状态：目标设计；当前版本只实现 V1 总体设计明确收录的子集  
> 适用范围：V1 演进、V1.1 至 Beta  
> 目标架构：`docs/DesignReport/TargetArchitecture.md`  
> 当前 M1/V1 范围：`docs/DesignReport/TargetM1.md`  
> 技术栈约束：`docs/TechStack.md`

> 范围说明：本文保留完整领域模型、Checkpoint/Restore、人类在环和后续演进设计。当前 M1/V1 的对象、状态机、接口和测试完成定义仅以 `TargetM1.md` 为准；本文中的额外能力不得成为当前发布阻断项。

## 1 文档目的与模块结论

本文把 Workflow Module 定义为 AgentOS 的任务语义、运行因果链与业务恢复点所有者。模块负责将经 UserInteraction/Kernel 准入的用户目标转化为 TaskGraph，在 MissionScope 监督树内创建 TaskAttempt 与 AgentRun，根据已提交 Event 推进状态，生成 WorkflowCheckpoint 与长期 SessionCheckpoint，并通过 UnitIntent 请求 Kernel 执行需要真实资源、授权或副作用控制的动作。

Workflow **不是用户界面、执行器、权限中心或资源调度器**。它不得直接接收未经 Kernel 准入的用户控制，不得直接调用模型、MCP、文件系统、网络、外部数据库、Sandbox 或 ContextEngine 存储；这些操作必须形成 Unit，由 Kernel 准入并返回 UnitAttempt Event。DBOS 只负责持久控制流、等待、定时器、signal 和内部崩溃恢复，不得替代 AgentOS 领域状态机或 SessionCheckpoint。

本文中的“必须/不得/应/可”含义与总体设计报告一致。内部实现可重构，但不得破坏本文定义的对象语义、状态转换、命令事件契约和不变量。

## 2 职责边界

### 2.1 输入

- Kernel 转发的用户与控制面 Command：create、pause、resume、cancel、replan、fork、rerun、restore-session-checkpoint、create/pin/delete-session-checkpoint、approve-result、inspect。
- Kernel 发布的 UnitAttempt Event、Lease/执行异常通知、HumanReviewOpened Event 与 HumanReviewDecision Signal。
- ContextEngine 经 Kernel 返回的 ContextPackRef 与 provenance。
- AgentToolPool 的版本化 Definition 查询结果。
- UserInteraction 创建、Kernel 准入的 PromptRevisionRef、用户变更、权限请求答复、补充信息等 Signal。

### 2.2 输出

- GraphRevision、Task/MissionScope/Agent 领域 Event 与只读投影。
- 面向 Kernel 的不可变 UnitIntent。
- 面向 Kernel 的 HumanReviewIntent、PermissionRequested、InformationRequested、DecisionRequested、AcceptanceRequested 与 ControlSignal。
- AgentResult、Task Resolution、GraphPatch 与 Compensation Task。
- WorkflowCheckpoint、SessionCheckpoint、ArtifactRef 关联、恢复可用性、最终验收结果和运行报告。

### 2.3 禁止行为

Workflow 不得：

1. 签发 CapabilityGrant、Lease、ExecutionPermit 或 Secret。
2. 选择具体 Worker 进程或绕过 Kernel 指定执行位置。
3. 直接读取其他 Module schema、索引或运行内存。
4. 在 DBOS 可重放 step 内执行模型、工具、Context、文件、网络或外部数据库副作用。
5. 让 AgentRun 直接修改 TaskRun、MissionScope 或其他 AgentRun。
6. 将 READY/BLOCKED 保存为不可推导的第二套权威状态。
7. 用覆盖旧 Attempt、删除 Event 或回滚审计历史的方式实现 retry、replan 或 compensation。
8. 直接写入 `interaction` 或 `dbos` schema，或接受 UserInteraction 对 WorkflowCheckpoint/SessionCheckpoint 的直接数据库修改。
9. 认证审查者、创建权威 HumanReviewDecision、聚合多人审批、签发审核后的 Grant，或把 UserInteraction 的 ReviewResponse 直接解释为授权。

## 3 领域模型

### 3.1 聚合划分

| 聚合 | 聚合根 | 内部对象 | 一致性边界 |
|---|---|---|---|
| 运行聚合 | WorkflowRun | 当前 revision 引用、根 MissionScope、控制状态、最终验收 | 整体控制命令与终态 |
| 图聚合 | GraphRevision | TaskDefinition、TaskEdge、JoinPolicy、ContractRef | 一次 Patch 原子发布 |
| 任务聚合 | TaskRun | TaskAttempt 列表、Resolution | attempt 创建与最终解析 |
| 使命范围聚合 | MissionScope | 父子关系、目标谱系、预算 envelope、ceiling/workspace/context 引用 | 监督、取消、上下文边界、完成条件 |
| Agent 聚合 | AgentRun | Step、WorkflowCheckpoint 引用、Signal、HumanReviewWait、usage、提案 | 一次智能行为的持久循环与人工等待 |
| 集成聚合 | IntegrationAttempt | IntegrationPlan、ordered ChangeSet、集成 workspace、冲突、QualityGateResult、IntegratedRevision | 一次代码变更组合与验收 |
| 恢复点聚合 | WorkflowCheckpoint / SessionCheckpoint | 一致状态 manifest、来源谱系、保留策略、完整性与可用性 | 创建、晋升、验证、恢复与删除 |
| 恢复操作聚合 | RestoreOperation | RestorePlan、RestoreAction 结果、source-to-target ID mapping、诊断 | 跨模块恢复 Saga 的业务编排与完成判定 |

跨聚合长流程不使用分布式事务，默认以“一个事务修改一个主聚合及其 Event Journal/Outbox”推进。但以下操作是显式定义的 Workflow 复合一致性边界，可在同一数据库事务中修改多个 Workflow 内部聚合：创建 Workflow 的 bootstrap 集合、原子发布 GraphRevision、验收 TaskAttempt 并固化 Task Resolution、创建一致 WorkflowCheckpoint，以及创建新运行的 restore bootstrap。每个复合边界必须列出受影响表、锁顺序、expectedVersion 和故障注入测试；未列出的跨聚合变更仍通过 Event/Saga 推进。

### 3.2 WorkflowRun

最小字段：

| 字段 | 类型 | 约束 |
|---|---|---|
| `workflowRunId` | string | 主键，全局唯一 |
| `tenantId/projectId` | string | 必填，资源隔离键 |
| `rootObjective` | JSON | 经 schema 校验，不保存未限制原始附件 |
| `workSessionId` | string | UserInteraction WorkSession 的 opaque 引用，必填 |
| `promptRevisionId` | string | 启动本次运行的不可变 PromptRevisionRef |
| `rootMissionScopeId` | string | 创建后不可变 |
| `currentGraphRevision` | bigint | 单调递增 |
| `controlState` | enum | 见状态机 |
| `createdBy` | IdentityRef | 必填 |
| `parentRunId/parentSessionCheckpointId` | string? | fork/rerun/restore 谱系 |
| `finalArtifactRef` | ArtifactRef? | 仅完成时设置 |
| `version` | bigint | optimistic concurrency |
| `createdAt/updatedAt/completedAt` | timestamptz | UTC |

WorkflowRun 只保存整体控制和终态，不复制 Task、Agent、Unit 的细粒度状态。

### 3.3 GraphRevision 与 TaskGraph

GraphRevision 是不可变图快照，由 `baseRevision + GraphPatch` 产生。图包含：

- TaskRun 的 revision-specific definition：objective、inputs、acceptanceCriteria、required、executionStrategy、consumer。
- TaskEdge：`HARD`、`CONTROL`、`DATA`、`OPTIONAL`。
- JoinPolicy：`ALL`、`ANY`、`QUORUM` 或版本化 custom evaluator。
- 输入输出 ContractRef、目标 MissionScope、预算需求、CapabilityRequirement、EvidenceRef。

GraphPatch 发布前必须校验：baseRevision 等于当前版本；图无环；ID 不重复；无不可达 required 节点；深度和 fan-out 不超策略上限；Edge 两端存在；数据 Contract 兼容；Task 属于合法 MissionScope；预算与 capability ceiling 可容纳；已解析 Task 不被非法重定义；已发生不可逆副作用的 Task 不被静默移除。

READY、BLOCKED、SKIPPED_CANDIDATE 是以当前 GraphRevision、上游 Resolution、JoinPolicy、MissionScope 控制状态和必要 Signal 计算的投影。投影必须携带 `computedFromRevision` 与 `computedAtEventSequence`，过期计算不得创建 Attempt。

### 3.4 TaskRun 与 TaskAttempt

TaskRun 是稳定逻辑身份，字段至少包括 `taskRunId`、`workflowRunId`、`logicalKey`、`objective`、`acceptanceCriteria`、`required`、`consumerRefs`、`resolution`、`version`。同一 logicalKey 在一个有效图版本内唯一。

TaskAttempt 创建时冻结：

- `attemptNo`，从 1 单调增加；
- `graphRevision`、`missionScopeId`、输入 Artifact/值快照；
- `executionStrategy`：`AGENT` 或 `DETERMINISTIC`；
- AgentDefinitionVersion 或 DeterministicExecutorRef；
- outputContractRef、retryPolicy、deadline、idempotencyKey；
- acceptance evaluator 的版本。

retry 必须创建新 TaskAttempt。旧 Attempt 终态不可修改。只有通过 revision、output Contract 和验收规则的 AgentResult/DeterministicResult 才能解析 TaskRun。多个成功 Attempt 竞争时，按首个被领域事务接受的结果解析；其余结果仅作为 Evidence。

### 3.5 MissionScope

MissionScope 是目标或子目标的持久化监督边界，不是任务容器。字段至少包括 `missionScopeId`、`workflowRunId`、`parentMissionScopeId`、`objectiveSummary`、`rootTaskRunId`、`graphRevision`、`budgetEnvelope`、`capabilityCeilingRef`、`workspaceRef`、`cancelPolicy`、`contextRefs`、`controlState`、`version`。

创建规则：

1. 新工作与当前目标、权限、预算、workspace 和生命周期一致时复用当前 MissionScope。
2. 存在独立子目标、权限、workspace 或取消边界时创建子 MissionScope。
3. 同时服务多个兄弟 MissionScope 的工作归属最低公共祖先；Join 和跨分支集成默认属于父 MissionScope。
4. MissionScope 只保存 capability ceiling 引用；Kernel 才能签发实际 Grant。
5. 子 MissionScope 的预算和 capability ceiling 不得超过父级剩余范围。

### 3.6 AgentRun

AgentRun 是固定 AgentDefinitionVersion 在一个 TaskAttempt 内的运行实例。字段至少包括 `agentRunId`、`taskAttemptId`、`missionScopeId`、`definitionVersion`、`state`、`currentStep`、`contextPackRef`、`conversationStateRef`、`pendingSignals`、`pendingHumanReviewRef`、`toolObservationsRef`、`usage`、`checkpointRef`、`proposedActions`、`version`。

AgentRun 只能输出：`UnitIntent`、`Signal`、`SpawnProposal`、`GraphPatchProposal`、`AgentResult`。所有可持久恢复的数据必须在 step 边界写入数据库或 Artifact；不得依赖 Node.js 进程内对象恢复。

### 3.7 ChangeSet 与 IntegrationAttempt

coding 或脚本化 Worker 的结果必须包含不可变 `ChangeSet`，不得仅依靠 AgentResult 的自然语言声明。ChangeSet 至少包含 `changeSetId`、`taskAttemptId`、`baseRevision`、`patchOrCommitRef`、`changedPaths`、rename/delete/binary metadata、`workspaceRef`、`producerDefinitionVersion`、`workerTestEvidenceRefs`、`contentHash` 和 provenance。

IntegrationAttempt 至少包含 `integrationAttemptId`、`workflowRunId`、`graphRevision`、`baseRevision`、`orderedChangeSetRefs`、`integrationPlanHash`、`workspaceRef`、`state`、`conflictRefs`、`qualityGateDefinitionRef`、`qualityGateResultRef`、`integratedRevisionRef`、`version` 和时间字段。IntegrationPlan 一旦开始物化即不可修改；变更顺序或输入必须创建新 IntegrationAttempt。

### 3.8 UnitIntent

```ts
interface UnitIntent {
  unitIntentId: string;
  owner: { workflowRunId: string; missionScopeId: string; taskAttemptId: string; agentRunId?: string };
  executionKind: "MODEL" | "TOOL" | "COMMAND" | "CONTEXT_QUERY" |
    "EMBEDDING" | "RERANK" | "INDEX_BUILD" | "ARTIFACT";
  definitionRef: VersionedRef;
  inputRefs: ArtifactRef[];
  inlineInput?: unknown;
  outputContractRef: VersionedRef;
  priority: number;
  deadline: string;
  retryPolicy: RetryPolicy;
  requiredCapability: CapabilityRequirement;
  resourceHint?: ResourceHint;
  idempotencyKey: string;
  graphRevision: number;
  correlationId: string;
}
```

`inlineInput` 必须受 schema 和大小限制；大型输入使用 ArtifactRef。UnitIntent 不包含真实 Secret、长期 credential、Executor endpoint 或可绕过 Scheduler 的 workerId。

### 3.9 三级 Checkpoint 领域模型

Workflow 必须显式区分三类恢复点：

1. **DBOS Checkpoint**：DBOS runtime 的内部持久控制流记录。Workflow 只通过 Durable Runtime Adapter 触发或查询兼容性，不拥有其表结构，不向用户暴露其 ID，也不得直接删除 `dbos` schema 数据。
2. **WorkflowCheckpoint**：Workflow 在已提交一致边界形成的内部业务恢复点，用于同一 WorkflowRun 的崩溃恢复、pause/resume 与诊断。其生命周期短于 SessionCheckpoint。
3. **SessionCheckpoint**：Workflow 为 WorkSession 生成的用户可见长期恢复点，代表足以在未来验证并派生新 WorkflowRun 的完整业务状态。

`WorkflowCheckpoint` 最小字段：

| 字段 | 说明 |
|---|---|
| `workflowCheckpointId` | 不可变主键 |
| `workflowRunId/workSessionId` | 所属运行与 Session 引用 |
| `eventSequence/graphRevision` | 一致性水位与图版本 |
| `checkpointKind` | `AGENT_STEP`、`TASK_BOUNDARY`、`JOIN_BOUNDARY`、`CONTROL_BOUNDARY`、`REPLAN_BOUNDARY`、`FINAL` |
| `stateManifestRef` | 领域状态、待处理 Signal/Unit、Task/MissionScope/Agent 引用的规范化 manifest |
| `dbosExecutionRef` | opaque runtime identity/version；不是 DBOS 表外键 |
| `artifactRootRefs/workspaceSnapshotRefs/effectLedgerRef` | 恢复所需不可变对象引用 |
| `definitionSetRef` | 固定 DefinitionVersion 集合 |
| `schemaVersion/applicationVersion/integrityHash` | 兼容与完整性验证 |
| `retentionClass/expiresAt` | 内部保留策略 |
| `createdAt` | UTC 提交时间 |

`SessionCheckpoint` 必须位于独立表，并至少包含：

| 字段 | 说明 |
|---|---|
| `sessionCheckpointId` | 用户可见稳定主键 |
| `workSessionId/sourceWorkflowRunId` | WorkSession 引用与来源运行 |
| `sourceWorkflowCheckpointId` | 可空来源信息；不得作为级联删除外键 |
| `parentSessionCheckpointId` | SessionTree 恢复点谱系，可空 |
| `promptRevisionId` | 创建该状态的用户意图版本 |
| `eventSequence/graphRevision/rootMissionScopeId` | 一致性水位、图与监督根 |
| `milestone/title/summary` | 机器生成的里程碑与用户可见摘要；标题可经命令修改 |
| `stateManifestRef/dependencyManifestRef` | Workflow 快照，以及跨 Module dependency 的 owner、版本/digest、hash、保存/恢复策略、retention token、重建配方与验证 Contract |
| `schemaVersion/applicationVersion/integrityHash` | 恢复前强制验证 |
| `restoreMode` | 默认 `FORK_NEW_RUN`；兼容性证明充分时可为 `RESUME_SAME_RUN` |
| `retentionClass` | `AUTO`、`PINNED`、`BRANCH_BASE`、`FINAL`、`LEGAL_HOLD` |
| `availability` | `CREATING`、`PREPARING`、`COMMITTING`、`AVAILABLE`、`FAILED`、`DEGRADED`、`INCOMPATIBLE`、`REVOKED`、`CORRUPTED`、`DELETE_REQUESTED`、`DELETING`、`DELETED` |
| `createdAt/deletedAt/version` | 生命周期与并发控制 |

SessionCheckpoint 不是 WorkflowCheckpoint 行的长期别名。创建时可复用相同 CAS blob，但必须重新物化并校验独立 manifest；`sourceWorkflowCheckpointId` 仅用于 provenance。它不复制其他 Module 的领域行，而是通过 `CheckpointParticipant.prepareRetention/commitRetention` 保存版本化引用、保留证明或重建配方。WorkflowCheckpoint GC 不得依赖回查 SessionCheckpoint 来决定“是否删一行”，而应遵循两个独立集合：内部 checkpoint 可删除，SessionCheckpoint 表和其有效跨 Module retention 不受该操作影响。

`SessionCheckpointPolicy` 必须版本化，至少定义自动创建触发器、每 WorkSession/WorkflowRun 上限、最小间隔、AUTO 轮换规则、强制保留类别、workspace snapshot 策略、最大 manifest/Artifact 预算和不允许保存的敏感数据。默认重大边界包括：Bootstrap 完成、关键 Join/阶段完成、replan 前、用户 pause 达到安全边界、发生不可逆副作用后的已确认状态和最终完成。细粒度 Agent step 不得自动成为 SessionCheckpoint。

### 3.10 RestoreOperation 与 RestorePlan

RestoreOperation 是从 SessionCheckpoint 派生新 WorkflowRun 的持久 Saga。它只用于用户选定 SessionCheckpoint，或原运行无法安全续跑后选定 SessionCheckpoint 重建；普通 DBOS resume、Unit/Task retry、Agent 发现设计错误后的 replan 和 compensation 不创建 RestoreOperation。它保存 source checkpoint、target run、新 PromptRevision、restore mode、RestorePlanRef、source-to-target ID mapping、每个 RestoreAction 的 owner/strategy/status/resultRef、幂等键和诊断。

Workflow 只直接执行对自有领域对象的 `CLONE/REBUILD`。Artifact 验证、DefinitionVersion 解析、ContextPack 重建、workspace 物化、新 Grant/Lease/Secret 签发和副作用 reconciliation 均必须形成面向 Kernel/权威 Module 的 Query、Command 或 UnitIntent。新运行在 required RestoreAction 完成前保持 `RESTORING`；任意必需引用缺失、完整性失败或未知副作用必须进入 `FAILED`/`NEEDS_ATTENTION`，不得部分启动新运行。

## 4 二级组件设计

### 4.1 Workflow Command Gateway

负责验证 Envelope、IdentityContext、idempotencyKey、expectedVersion、目标聚合与参数，然后把命令交给对应 DBOS Workflow 串行处理。Gateway 不直接写领域表。

命令幂等表以 `(tenant_id, command_name, idempotency_key)` 唯一；相同键且请求 hash 相同返回原结果，不同则返回 `IDEMPOTENCY_KEY_REUSED`。expectedVersion 不匹配返回 `VERSION_CONFLICT`，调用者必须刷新状态，不得自动覆盖。

### 4.2 WorkflowRun Manager

创建根运行并处理 pause、resume、cancel 和完成条件。Reducer 必须为纯函数：`state + command/event -> state + domainEvents`。持久层在同一事务写入新版本、Journal 与 Outbox。

### 4.3 TaskGraph Manager

维护不可变 GraphRevision 与 Patch。发布流程固定为加载当前 revision → 校验 baseRevision → 应用 Patch 到内存候选图 → 完整校验 → 持久化新 revision 与差异 → 发布 GraphPatched。任何校验失败均不得产生部分图。

### 4.4 Readiness and Join Evaluator

Evaluator 是确定性、无副作用组件。输入包含 revision、Task Resolution、ArtifactRef、JoinPolicy、MissionScope 状态与 Signal；输出包含候选状态、理由、缺失依赖和输入绑定。相同输入必须产生相同输出。

ALL 要求全部 required 上游成功；ANY 在任一合格结果出现时满足并记录选中分支；QUORUM 要求达到 `k` 个合格结果且满足最小数据 Contract；custom evaluator 必须版本化、确定性、超时受控并保存输入 hash。Join 满足后迟到分支不得改变已固定的输入集合，除非新 revision 明确重新打开 Join。

### 4.5 TaskRun and TaskAttempt Manager

根据 Readiness、retryPolicy、deadline 和输入快照创建 Attempt。创建必须以 `(task_run_id, attempt_no)` 唯一，并记录 readiness event sequence。接收结果时依次校验 owner、revision/barrier、Attempt 非终态、output Contract、Artifact 完整性和 acceptance criteria。

失败分类：

| 类别 | 默认处理 |
|---|---|
| TRANSIENT | 指数退避加抖动，在次数/deadline 内重试 |
| RATE_LIMIT | 使用服务端 retry-after 或 Provider 配额窗口 |
| TIMEOUT | 依据副作用记录决定 retry 或人工确认 |
| CONTRACT | 不盲重试；更换策略或重新规划 |
| POLICY | 等待审批、降级或失败 |
| RESOURCE | 排队、降级资源或超过 deadline 后失败 |
| PERMANENT | 失败传播或重新规划 |
| UNKNOWN_EFFECT | 暂停相关 MissionScope，进入 reconciliation/人工处理 |

### 4.6 MissionScope Supervisor

负责 MissionScope 创建、预算继承、取消传播、影响闭包和完成条件。预算采用 reservation/commit/release：提交 Unit 前请求 Kernel 预留，成功后按实际用量结算，失败或取消释放；Workflow 只维护业务预算 envelope 与已知账目，不成为 Provider 用量事实源。

### 4.7 AgentRun Coordinator

Coordinator 使用 DBOS durable loop：加载 AgentRun checkpoint → 如需上下文则提交 Context Unit 并等待 → 提交 Model Unit 并等待 → 解析结构化输出 → 提交 Tool/Command Unit 或 Proposal → checkpoint → 继续或提交 AgentResult。每次等待使用稳定 correlationId；恢复后不得生成新的逻辑 Unit 幂等键。

### 4.8 Planning and Replanning Coordinator

Bootstrap Planner 查询 AgentToolPool 并固定 DefinitionVersion，通过 Context Unit 获得带 provenance 的事实，生成 GraphPatchProposal。Coordinator 只产生提案；TaskGraph Manager 才能发布。

Replan Proposal 必须包含 baseRevision、targetMissionScopeId、impactClosureRef、保留/失效节点、Edge 变化、Contract 变化、预算、Capability、EvidenceRef 和回滚说明。未受影响分支继续前必须通过输入 Contract、共享 Artifact、workspace ownership 与权限隔离检查。

### 4.9 Integration Coordinator

Integration Coordinator 负责将已验收 TaskAttempt 的 ChangeSet 组织为确定性 IntegrationPlan，创建 IntegrationAttempt，通过 Kernel Unit 物化干净 workspace、按固定顺序应用变更、运行 QualityGate，并提交 IntegratedRevision 或 IntegrationFailed。它不直接调用 Git/文件系统、不修改 Worker workspace，也不把 Worker 自测作为集成验收的替代。

ChangeSet 顺序依次使用 TaskGraph 拓扑序、显式 integrationOrder、Task logicalKey 和 changeSetId 决胜，Event 到达时间不参与排序。集成结果必须绑定 base revision、ordered ChangeSet hash、最终 diff/commit Artifact 和 QualityGateResult。推送、建 PR 和发布另行生成外部副作用 Unit，不是 IntegrationAttempt 的隐式步骤。

### 4.10 Restore Coordinator

Restore Coordinator 实现总体设计的跨模块恢复协议。它只解释恢复业务语义：创建 RestoreOperation，从 checkpoint 生成 RestorePlan和 ID mapping，对 Workflow 自有对象执行 clone/rebuild，向 Kernel/其他 Module 发送幂等恢复动作，消费结果 Event，并在所有 required action 通过后使新运行就绪。

Coordinator 不能从 checkpoint 继承 Grant、Lease、ExecutionPermit、Secret、开放审核或旧 DBOS execution identity。一个 RestoreAction 完成后必须以 `restoreOperationId + actionId` 幂等提交；中途崩溃由 DBOS 恢复等待，不重新创建新运行或第二个 workspace。

### 4.11 Compensation Coordinator

依据 Kernel 返回的 effectRecord 和版本化 compensation policy 创建反向 Task。补偿 Task 必须引用原 UnitAttempt、外部资源标识、已知效果、幂等键和人工验证条件。不可补偿、状态未知或补偿失败进入 `MANUAL_INTERVENTION_REQUIRED`，不得伪报成功。

### 4.12 Durable Runtime Adapter

Adapter 隔离全部 DBOS API，使领域层不导入 DBOS 类型。接口至少包括 `startWorkflow`、`sendSignal`、`sleepUntil`、`awaitCorrelation`、`enqueue`、`getStatus`、`cancelControlFlow`。DBOS workflow version 变化必须使用显式 version adapter；升级前必须验证正在运行实例可继续恢复。

Adapter 还必须提供受约束的 `requestRuntimeCheckpoint`、`verifyResumeCompatibility` 与 `applyRuntimeRetention`。这些接口只操作 DBOS 官方/封装 API，不向领域层暴露内部行或允许任意 SQL 删除。DBOS 保留策略不得早于仍需 `RESUME_SAME_RUN` 的 WorkflowCheckpoint；若内部历史已清理，则相应恢复能力必须降级为从 SessionCheckpoint `FORK_NEW_RUN`。

### 4.13 Checkpoint Manager

Checkpoint Manager 是 WorkflowCheckpoint 与 SessionCheckpoint 的唯一应用服务，分为四个职责：

- **Consistency Barrier**：停止创建受影响范围的新 UnitIntent，等待或隔离运行中 Unit，刷新领域事务与 Outbox 水位，确认没有未记录的副作用，再确定 `eventSequence`。
- **Manifest Builder**：从已提交投影生成 canonical manifest，收集 TaskGraph、MissionScope、Task/Agent、Signal、Artifact、workspace、effect ledger 与 DefinitionVersion 引用，计算 integrity hash。
- **Promotion/Materialization**：依据 SessionCheckpointPolicy 或已准入命令，把一致状态物化为独立 SessionCheckpoint；复用 CAS 内容，但不得依赖源 WorkflowCheckpoint 行继续存在。
- **Restore/Retention**：执行兼容性检查、创建派生 WorkflowRun、管理 availability/retention 状态，并把有效 SessionCheckpoint manifest 注册为 Artifact GC root。

Checkpoint 创建不得跨多个未协调事务伪装成原子操作。推荐状态机：先在 Workflow 事务中插入 `CREATING` 记录与 outbox；上传/确认不可变 Artifact；再以 expectedVersion 事务更新为 `AVAILABLE` 并发布 `SessionCheckpointCreated`。创建失败标记 `DEGRADED` 并记录缺失引用，绝不能向 UserInteraction 宣称可恢复。

自动创建决策由 Workflow 根据已固定的 SessionCheckpointPolicy 做出；UserInteraction 只能请求创建、固定、解除固定、改显示标题或删除。所有请求必须经 Kernel 准入。Checkpoint Manager 返回稳定 operationId，供 Kernel 形成 RuntimeProjection，UserInteraction 只观察最终事件。

### 4.14 Human Review Coordinator

Human Review Coordinator 负责 Workflow 侧的人类在环语义。它把权限许可、信息补充、方案选择和结果验收需求规范化为 HumanReviewIntent，持久化 `human_review_waits`，并通过 Kernel Port 等待权威 HumanReviewDecision。它不得读取 Kernel 审核表、验证审查者身份或自行聚合多人响应。

Coordinator 必须在恢复等待点前校验 reviewId、reviewType、targetRef、graphRevision、requestVersion、decision、constraints 和 expiry。批准只恢复业务控制流，不直接创建 Grant 或执行 Unit；拒绝、修改、信息补充、验收失败和过期分别交给 TaskAttempt Manager、Planning Coordinator、AgentRun Coordinator 或 WorkflowRun Manager 作出确定性业务决策。

## 5 状态机

### 5.1 WorkflowRun 状态机

```text
CREATED -> RESTORING? -> PLANNING -> RUNNING <-> PAUSING -> PAUSED
                                      |                     |
                                      +----> REPLANNING <---+
                                      |
                                      +----> CANCELLING -> CANCELLED
                                      +----> FINALIZING -> SUCCEEDED
                                      +----> FAILED
                                      +----> NEEDS_ATTENTION
```

- `PAUSING` 期间不得创建受影响集合的新 UnitIntent。
- `RESTORING` 只用于从 SessionCheckpoint 派生的新运行；所有 required RestoreAction 完成前不得进入 PLANNING/RUNNING。
- `FINALIZING` 必须执行最终集成验收与 Kernel drain 协议；检查失败返回 RUNNING/REPLANNING、FAILED 或 NEEDS_ATTENTION。
- `NEEDS_ATTENTION` 是持久非终态，用于副作用未知、恢复不完整或补偿失败；只能经明确人工处置命令转入 PAUSED、CANCELLING 或 FAILED，不得自动恢复 RUNNING。
- `SUCCEEDED`、`FAILED`、`CANCELLED` 为终态，不可恢复为 RUNNING；继续工作必须 fork、rerun 或创建新 WorkflowRun。

### 5.2 MissionScope 状态机

`ACTIVE -> PAUSING -> PAUSED -> ACTIVE`；`ACTIVE|PAUSED|NEEDS_ATTENTION -> CANCELLING -> CANCELLED`；`ACTIVE -> COMPLETING -> COMPLETED`；任意非终态可进入 `NEEDS_ATTENTION` 或在不可恢复错误后进入 `FAILED`。父 MissionScope 取消默认向全部子 MissionScope 传播；子 MissionScope 失败是否传播由 required 标记与父级 JoinPolicy 决定。

### 5.3 TaskAttempt 状态机

`CREATED -> WAITING_FOR_ADMISSION -> RUNNING -> VALIDATING -> SUCCEEDED|FAILED`。执行前审核路径为 `WAITING_FOR_ADMISSION -> WAITING_HUMAN_REVIEW -> WAITING_FOR_ADMISSION`；执行中业务等待可为 `RUNNING -> WAITING_HUMAN_REVIEW -> RUNNING`。控制路径可进入 `CANCELLING -> CANCELLED`，Lease 丢失或无法确认效果进入 `ABANDONED`。只有审核直接阻塞整个 Attempt 时才使用 `WAITING_HUMAN_REVIEW`；单个 Agent 步骤等待不得错误提升为整个 Attempt 阻塞。终态不可覆盖。TaskRun 的 Resolution 与 Attempt 状态分离。

### 5.4 AgentRun 状态机

`CREATED -> ASSEMBLING_CONTEXT -> THINKING -> WAITING_UNIT -> THINKING` 循环；也可进入 `WAITING_SIGNAL`、`WAITING_HUMAN_REVIEW`、`CHECKPOINTING`，最终到 `RESULT_SUBMITTED`、`FAILED` 或 `CANCELLED`。WAITING 状态必须有 correlationId、等待类型与 deadline；`WAITING_HUMAN_REVIEW` 还必须保存 reviewId、requestVersion、允许决定集合和恢复位置，避免无法唤醒或将错误类型的人工响应用于当前步骤。

### 5.5 IntegrationAttempt 状态机

`CREATED -> MATERIALIZING -> APPLYING -> VALIDATING -> SUCCEEDED`；任一阶段可进入 `CONFLICTED`、`FAILED` 或 `CANCELLED`。`SUCCEEDED` 必须已提交 IntegratedRevision 和 QualityGateResult；`CONFLICTED` 必须保存冲突类型、路径和 EvidenceRef。重试集成必须创建新 IntegrationAttempt，不覆盖原结果。

### 5.6 状态传播顺序

`UnitAttemptSucceeded` 只说明物理操作成功；AgentRun 消费后决定继续或提交 AgentResult；TaskAttempt Manager 验收后产生 `TaskAttemptSucceeded`；Readiness Evaluator 重算下游；MissionScope 和 WorkflowRun 最后评估终态。任何 handler 不得在单次回调中跳过这些层级直接批量改终态。

## 6 命令、Signal 与事件目录

### 6.1 核心命令

| 命令 | 目标聚合 | 必要字段 | 成功事件 |
|---|---|---|---|
| CreateWorkflow | WorkflowRun | objective、workSessionId、promptRevisionId、createdBy、budget、expectedVersion/creationPrecondition、idempotencyKey | WorkflowCreated |
| PublishGraphPatch | GraphRevision | baseRevision、patch、evidence | GraphPatched |
| CreateTaskAttempt | TaskRun | revision、missionScopeId、input snapshot | TaskAttemptCreated |
| StartAgentRun | AgentRun | attempt、definitionVersion、context policy | AgentRunStarted |
| PauseMissionScope | MissionScope | reason、impact set、grace period | MissionScopePausing/MissionScopePaused |
| ResumeMissionScope | MissionScope | expectedRevision、compatibility evidence | MissionScopeResumed |
| CancelMissionScope | MissionScope | reason、cancel policy | MissionScopeCancelling/MissionScopeCancelled |
| CreateWorkflowCheckpoint | WorkflowRun | checkpointKind、expectedVersion、reason | WorkflowCheckpointCreated |
| CreateSessionCheckpoint | WorkflowRun | workSessionId、milestone、policyVersion、expectedVersion | SessionCheckpointCreated/SessionCheckpointCreationFailed |
| PinSessionCheckpoint | SessionCheckpoint | retentionClass、expectedVersion | SessionCheckpointPinned |
| DeleteSessionCheckpoint | SessionCheckpoint | deletionMode、reason、expectedVersion | SessionCheckpointDeletionRequested/Deleted |
| RestoreSessionCheckpoint | SessionCheckpoint | workSessionId、newPromptRevisionId、restoreMode、idempotencyKey | WorkflowForkedFromSessionCheckpoint |
| AcceptAgentResult | TaskAttempt | resultRef、contractVersion | TaskAttemptSucceeded |
| RejectAgentResult | TaskAttempt | violations、evidence | TaskAttemptFailed |
| StartIntegration | IntegrationAttempt | baseRevision、orderedChangeSetRefs、qualityGateDefinitionRef、idempotencyKey | IntegrationStarted |
| AcceptIntegration | IntegrationAttempt | integratedRevisionRef、qualityGateResultRef、expectedVersion | IntegratedRevisionCreated |
| StartRestore | RestoreOperation | sessionCheckpointId、newPromptRevisionId、restoreMode、idempotencyKey | RestoreStarted |
| CompleteWorkflow | WorkflowRun | finalArtifactRef、completion evidence | WorkflowSucceeded |

### 6.2 核心 Signal

- `UserChangeSignal`：PromptRevisionRef、新目标、影响提示、紧急度、Evidence；必须源于 UserInteraction 并经 Kernel 准入。
- `HumanReviewIntent`：reviewType、riskHint、targetRef、requestedAction、alternatives、impactSummary、EvidenceRef、allowedDecisions、deadline。
- `PermissionRequested`：兼容的 APPROVAL 类 HumanReviewIntent，包含 resource、action、duration、purpose、alternatives 和 Evidence。
- `HumanReviewOpened`：reviewId、reviewType、requestVersion、targetRef、deadline；由 Kernel 返回并建立持久等待关联。
- `HumanReviewDecisionSignal`：reviewId、reviewType、decision、constraints、reviewedParametersHash、graphRevision、expiry、policyVersion、decisionRef。
- `InformationRequested/Provided`：兼容的 INFORMATION 类请求与回答，包含问题 Contract、答案 Artifact 和截止时间。
- `ControlSignal`：targetMissionScopeId、requestedAction、reason、revision。

Signal 必须持久化并具有接收确认；不能只依赖内存事件发射器。

### 6.3 事件命名与载荷规则

事件采用过去式，至少包括 aggregateId/version、graphRevision、causationId、correlationId、occurredAt。事件载荷保存做出状态变化所需的事实，不保存可随代码变化重新计算的完整视图。敏感大载荷使用 ArtifactRef。

## 7 持久化设计

### 7.1 逻辑表

`workflow.workflow_runs`、`graph_revisions`、`graph_tasks`、`graph_edges`、`task_runs`、`task_attempts`、`mission_scopes`、`agent_runs`、`change_sets`、`integration_attempts`、`integration_inputs`、`restore_operations`、`restore_actions`、`restore_id_mappings`、`human_review_waits`、`workflow_checkpoints`、`session_checkpoints`、`checkpoint_dependencies`、`checkpoint_retentions`、`checkpoint_artifact_roots`、`checkpoint_operations`、`signals`、`graph_patch_proposals`、`compensations`、`domain_events`、`command_dedup`、`projection_checkpoints`。Outbox/Inbox 与 Artifact metadata 由 `platform` schema 提供，DBOS 使用独立 `dbos` schema。`human_review_waits` 只保存 Kernel reviewId、等待对象、恢复位置、版本绑定、deadline、decisionRef 与处理状态，不复制 HumanReviewRequest/Decision 权威内容。原 `agent_checkpoints` 概念并入具有 owner 类型的 `workflow_checkpoints`，避免形成第四套恢复语义。

关键索引与约束：

- `(tenant_id, workflow_run_id)` 作为所有查询前缀。
- `graph_revisions(workflow_run_id, revision)` 唯一。
- `task_runs(workflow_run_id, logical_key)` 唯一。
- `task_attempts(task_run_id, attempt_no)` 唯一。
- `agent_runs(task_attempt_id)` 对 V1 的 AGENT 策略唯一；未来多 Agent 协作需显式放宽并升级契约。
- `change_sets(task_attempt_id, content_hash)` 唯一；同一 Attempt 重复交付返回原 ChangeSet。
- `integration_attempts(workflow_run_id, integration_plan_hash, attempt_no)` 唯一；`integration_inputs` 保存确定顺序，不按 Event 到达时间重排。
- `restore_operations(tenant_id, idempotency_key)` 唯一；`restore_actions(restore_operation_id, action_id)` 唯一，重放不得产生第二个目标运行或 workspace。
- `signals(workflow_run_id, correlation_id, signal_type)` 支持等待唤醒。
- `workflow_checkpoints(workflow_run_id, event_sequence, checkpoint_kind)` 唯一；`state_manifest_ref`、`integrity_hash` 非空。
- `session_checkpoints(work_session_id, session_checkpoint_id)` 唯一；`source_workflow_checkpoint_id` 可空且不得配置 `ON DELETE CASCADE`。
- `checkpoint_dependencies(session_checkpoint_id, owner, object_type, source_ref)` 唯一；保存 ownerVersion/digest、hash、required、save/restore strategy、rebuild recipe 与 validation Contract。
- `checkpoint_retentions(session_checkpoint_id, owner, retention_token)` 唯一；保存 PREPARED/ACTIVE/RELEASED/FAILED、ownerVersion、resultRef 与最后查询时间，不把 token 当作目标对象所有权。
- `checkpoint_artifact_roots(checkpoint_type, checkpoint_id, artifact_ref)` 唯一；有效 SessionCheckpoint 的 root 行不得被内部 GC 删除。
- `checkpoint_operations(tenant_id, idempotency_key, operation_type)` 唯一，恢复、固定与删除均可安全重放。
- `domain_events(aggregate_id, aggregate_version)` 唯一。
- JSONB 字段配套 schemaVersion；高频筛选字段必须列化，不能全部塞入 JSONB。

数据库权限固定为：`workflow_app` 对 `workflow` schema 为 RW，对 `interaction`、`kernel`、`context` 基表无权限；WorkSession/PromptRevision 通过 Kernel 转发的版本化引用验证，必要内容使用 Query。`workflow_app` 不得拥有 `dbos` schema 权限；只有 DBOS adapter 使用独立最小权限 role。Workflow 对 `platform` 的访问只通过事务 Outbox/Inbox 与 Artifact Port 所需的受控函数或最小表权限。

### 7.2 事务模板

```text
BEGIN
  SELECT aggregate ... FOR UPDATE / 或按 version 条件更新
  validate domain invariants
  UPDATE aggregate SET ..., version = version + 1 WHERE version = expected
  INSERT domain_events(...)
  INSERT platform.outbox(...)
COMMIT
```

若更新行数为零，返回版本冲突。任何外部 I/O 必须发生在事务外；事务内只执行确定性领域计算与数据库写入。

### 7.3 投影与重建

运行摘要、图视图和 UI 时间线均是投影。Projector 使用 Inbox/eventId 幂等，保存最后 event sequence。重建时创建新投影版本、从 Journal 回放、校验计数/hash 后原子切换；不得在不清空旧 checkpoint 的情况下混合新旧投影。

### 7.4 Checkpoint 写入事务

WorkflowCheckpoint 的领域行、`checkpoint_artifact_roots`、`WorkflowCheckpointCreated` 与 Outbox 必须在同一事务提交。manifest 对应 CAS 对象应先写临时区并验证 hash，再提交引用；事务失败时由孤儿 GC 清理临时对象。

SessionCheckpoint 使用可恢复的 prepare/commit 应用协议，而非数据库分布式事务：

1. Workflow 在本地事务验证一致边界与 policy，写入 `CREATING/PREPARING`、operation 幂等记录、候选 manifest、dependency rows、Event 与 Outbox。
2. Checkpoint Manager 按 owner 调用 `CheckpointParticipant.prepareRetention`。不可变对象返回版本/hash/retention token，可重建对象返回 source refs/rebuild recipe，要求精确重现的状态先经 Kernel Unit 物化为 Artifact；Grant、Lease、Secret、Executor 会话和未完成审批仅记录不得继承。
3. 任一 required dependency 无法验证、保留或重建时，操作失败并幂等调用所有已准备 owner 的 `abortRetention`；只有可选 dependency 失败时才可按 Policy 进入 `DEGRADED`。
4. 全部 required dependency 准备成功后，Workflow 事务写入最终 manifest/integrity hash、dependency、retention token、全部本地 GC roots、Event 与 Outbox，并转为 `COMMITTING`。
5. 各 owner 幂等执行 `commitRetention`；Workflow 通过 `queryRetention` 确认全部 required token 为 ACTIVE 后，才以 `sessionCheckpointId + expectedVersion` 更新为 `AVAILABLE`。
6. 任何中断由 reconciliation 使用相同 operationId/idempotency key 继续 commit 或 abort，不重复物化对象。required owner 永久提交失败时释放已激活 token 并进入 `FAILED/INCOMPATIBLE`，不得发布 `AVAILABLE`。普通删除在 ACTIVE token 存在时必须被 owner 拒绝；强制安全/法规删除必须返回墓碑并使保存点进入 `REVOKED/INCOMPATIBLE/CORRUPTED`。

只有 `AVAILABLE` 的 SessionCheckpoint 可被恢复。UserInteraction 展示的可恢复状态必须来自该字段及最近一次 Workflow 验证结果，不能根据“数据库存在一行”推断。

### 7.5 保留、删除与 Artifact GC

保留任务必须分别处理三层数据：DBOS 数据通过 Durable Runtime Adapter 的官方 retention 接口清理；WorkflowCheckpoint 根据 `retentionClass/expiresAt` 清理；SessionCheckpoint 仅按 SessionCheckpointPolicy 或经 Kernel 准入的用户删除命令处理。通用 WorkflowCheckpoint GC 的 SQL 目标集合不得包含 `session_checkpoints`。

SessionCheckpoint 删除流程为：写入 `DELETE_REQUESTED` 并发布事件 → 校验非 LEGAL_HOLD、非仍被活动分支要求的唯一基点且调用者有权限 → 标记 `DELETING` 并建立短期 deletion lease → 对每个 owner 幂等调用 `releaseRetention` → 确认全部 required token 已 RELEASED 后，在 Workflow 事务写入 `DELETED` 墓碑并解除本地 GC-root 注册。CAS/Artifact Store 只能在 deletion lease/grace period 结束后执行全局 mark-and-sweep；只有不存在任何 WorkflowCheckpoint、SessionCheckpoint、运行中 Unit、审计保留或其他领域引用时才物理删除对象。

用户“从 SessionTree 隐藏节点”只修改 UserInteraction 的展示状态，不调用上述物理删除。`PINNED`、`BRANCH_BASE`、`FINAL` 和 `LEGAL_HOLD` 默认不参与自动轮换；AUTO 点可按版本化 policy 轮换，但必须保证至少保留规定的最近里程碑数量。

### 7.6 SessionCheckpoint 恢复事务

恢复是跨模块可恢复 Saga，不是一个能覆盖其他 Module 的数据库事务。它只接受 SessionCheckpoint 作为来源；同一运行的崩溃续跑、Unit/Task retry、replan 和 compensation 不进入本事务。恢复前 Workflow 先验证自己拥有的 checkpoint 为 `AVAILABLE`、integrity hash、schema/application 兼容、required retention token 为 ACTIVE 和领域不变量，然后创建 RestoreOperation/RestorePlan。Artifact 可读性、DefinitionVersion 安全状态、Context 来源、workspace snapshot、当前权限/预算和 effect ledger 由各权威 Module 经 Kernel 准入后验证并返回结构化 Result。

默认恢复以一个 Workflow 复合事务幂等创建新 WorkflowRun、`parentRunId`、`parentSessionCheckpointId`、新 `promptRevisionId`、`RESTORING` 状态、新 DBOS execution identity 所需的启动意图、RestoreOperation、初始 ID mapping、领域 Event 与 Outbox。实际 DBOS execution 在该事务提交后幂等启动。新运行不得覆盖父运行、父 PromptRevision 或原 SessionCheckpoint；重复恢复请求返回同一 RestoreOperation 和 target run。

Restore Coordinator 按 action 依赖发送 Query/Command/UnitIntent，每个结果在 Workflow 事务中以 `restoreOperationId + actionId` 幂等提交。全部 required action 成功后，Workflow 验证 ID mapping、发布新 GraphRevision，再将 run 转为 PLANNING/RUNNING。必需引用不可用、安全定义已撤销或副作用未知时进入 FAILED/NEEDS_ATTENTION；已物化的临时 workspace 和预留资源由显式幂等清理 action 回收。

## 8 DBOS 编排映射

### 8.1 映射原则

- 一个 WorkflowRun 对应一个顶层 DBOS durable workflow identity。
- DBOS step 可执行领域事务、确定性校验、发出 Outbox 意图、等待 Event/Signal 与 timer。
- UnitIntent 提交后，workflow 以稳定 correlationId 等待 Kernel Event；恢复时继续等待同一逻辑结果。
- DBOS Queue 只承载执行唤醒或后台工作，不决定 Task 权威状态。
- DBOS retry 只重试幂等领域 step；Kernel retry 才负责 UnitAttempt。两者不得同时重试同一外部副作用。
- DBOS Checkpoint 不进入 SessionTree，DBOS execution identity 不得作为公开恢复 API；WorkflowCheckpoint/SessionCheckpoint 只保存 opaque runtime reference。
- 删除 WorkflowCheckpoint 或 SessionCheckpoint 不得通过 SQL 级联删除 DBOS 记录；DBOS retention 独立执行，并把可恢复模式变化反馈给 Workflow。

### 8.2 Durable loop 伪代码

```ts
async function runWorkflow(workflowRunId: string) {
  await ensureBootstrapState(workflowRunId);
  while (true) {
    const snapshot = await loadCommittedSnapshot(workflowRunId);
    if (snapshot.controlState === "PAUSED") {
      await awaitControlSignal(workflowRunId);
      continue;
    }
    if (isTerminal(snapshot.controlState)) return snapshot.finalArtifactRef;

    const actions = await computeNextDomainActions(snapshot);
    for (const action of actions) {
      const outcome = await executeDomainActionIdempotently(action);
      if (outcome.unitIntent) {
        await publishUnitIntent(outcome.unitIntent);
        await awaitUnitEvent(outcome.unitIntent.correlationId);
      }
    }
  }
}
```

伪代码不表示并行 Unit 必须串行等待。实现应批量发布彼此独立的 UnitIntent，再以 correlation 集合等待并逐个消费完成事件。

## 9 关键算法

### 9.1 Readiness

对每个当前 revision 中未解析 Task：过滤失效 Edge；读取 required 上游 Resolution；验证 Data Edge 的 Artifact/Contract；计算 JoinPolicy；检查 MissionScope ACTIVE、deadline、必要 Signal 和 barrier；生成 `READY(reason,inputBindings)` 或 `BLOCKED(missingReasons)`。创建 Attempt 前在事务中再次确认 revision 与输入 hash，防止 TOCTOU。

### 9.2 GraphPatch

复制 base 图到候选结构，应用 add/update/invalidate 操作；进行结构、MissionScope、Contract、预算、权限和副作用约束校验；计算 canonical graph hash；以 expected currentRevision 原子提交新版本。Patch 冲突不自动三方合并；Planner 必须基于最新 revision 重算提案。

### 9.3 影响闭包与 Revision Barrier

影响集合初始包含用户指定 Task/MissionScope；随后迭代加入 MissionScope 子树、DAG 下游、依赖受影响 Join、消费受影响 Artifact 的 Task、共享 workspace 路径冲突者、依赖变更权限者以及不可逆副作用相关补偿。直至集合不再增长。

范围不能可靠判定时先保守冻结候选集合的新 Lease 和不可逆副作用。受影响 MissionScope 进入 PAUSING；安全 checkpoint 后发布 barrier 与新 revision。结果准入条件为 `attempt.revision == currentRevision` 或明确属于 barrier 允许的兼容分支，否则仅存 Evidence。

### 9.4 完成判定

Workflow 使用两阶段完成协议，避免 Workflow 等待 Kernel 回收资源、Kernel 又等待 Workflow 终态的循环依赖：

1. **Completion candidate**：当前 revision 的 required Task/Join/MissionScope 均完成，最终 IntegrationAttempt 和 QualityGate 成功，必需 Signal/HumanReviewWait 已处理，最终 Artifact 已提交，副作用已记录且必需补偿完成。Workflow 以 expectedVersion 进入 `FINALIZING` 并发布 `WorkflowCompletionProposed`，停止新 UnitIntent。
2. **Execution drain**：Kernel 收到提案后停止相关新准入，结算用量，关闭或回收必需 Lease/Grant/ExecutionPermit，处理仍在运行或效果未知的 Unit，并发布 `ExecutionScopeDrained` 或 `ExecutionDrainFailed`。
3. **Final commit**：Workflow 只在收到与 completion proposal version 绑定的 `ExecutionScopeDrained`、重新验证最终 Artifact/hash 与 final acceptance evaluator 后提交 `SUCCEEDED`。drain 发现未知副作用或无法回收的必需资源时进入 `NEEDS_ATTENTION`，不得报告成功。

## 10 与其他模块的协议

### 10.1 Kernel

Workflow 只提交 UnitIntent、运行控制结果以及 WorkflowCheckpoint/SessionCheckpoint 事件。Kernel 返回规范化 UnitAttempt Event，至少包含 unit/attempt ID、owner、state、leaseId、fencingToken、graphRevision、resultRef、usage、effectRecord、diagnosticsRef。Workflow 必须验证 owner 与 revision，但不得重复解释底层 Executor 状态。

所有来自 UserInteraction 的 create/pause/resume/cancel/replan/fork/restore/checkpoint pin/delete 请求必须先由 Kernel 校验 IdentityContext、tenant/project、目标 WorkSession/WorkflowRun、Policy、expectedVersion、幂等键和审计原因。Kernel 向 Workflow 传递的是已准入命令，不得替 Workflow 决定 Checkpoint 是否一致或可恢复。对于紧急 cancel，Kernel 可立即撤销 Lease/ExecutionPermit，但仍须发送持久命令并等待 Workflow 提交业务终态。

Workflow 需要人工参与时只提交 HumanReviewIntent；Kernel 负责创建 HumanReviewRequest、验证审查者、聚合多人响应并发布 HumanReviewDecision。Workflow 只持久化 reviewId、等待对象、恢复位置和决定引用，不复制 Kernel 请求正文，不把 UserInteraction ReviewResponse 直接作为授权。批准后仍由 Kernel 独立签发 Grant/ExecutionPermit。

Workflow 通过领域事件向 Kernel 提供 SessionCheckpoint operation 与 availability；Kernel 将其与 Lease、UnitAttempt、成本、审批和 Worker 状态组合为脱敏 RuntimeProjection。Workflow 不向 UserInteraction 推送未经 Kernel 投影的底层运行细节。

### 10.2 ContextEngine

所有检索、装配、embedding、rerank 和 index build 均形成 Context Unit。ExecutionPermit 绑定 allowedDataScope、artifactScope、tokenBudget、revision、leaseId 和 policyVersion。Workflow 只持久化 ContextPackRef、provenance 摘要和验收关系。

### 10.3 AgentToolPool

Planner 使用只读 Query 按 CapabilityRequirement、Contract 与运行需求查询兼容组合。返回值只含 DefinitionRef/Version、digest、静态能力和兼容性；不得含 Secret、动态配额或授权结论。TaskAttempt 和 AgentRun 创建时固定版本。

### 10.4 UserInteraction

Workflow 与 UserInteraction 不直接互调或共享数据库。标准写路径固定为：

```text
UserInteraction UserIntent
  -> Kernel admission/audit
  -> Workflow Command
  -> Workflow transaction + Event/Outbox
  -> Kernel RuntimeProjection
  -> UserInteraction view
```

UserInteraction 向 Workflow 提供的只有 opaque `workSessionId`、不可变 `promptRevisionId`、用户标签/原因和目标引用；Prompt 正文由受 ACL 保护的 ArtifactRef 或经 Kernel 过滤的 payload 传递。Workflow 返回 SessionCheckpoint 的 ID、里程碑、摘要、谱系、retentionClass、availability 与 incompatibility reason，不暴露完整 manifest、effect ledger 或内部 DBOS reference。

从 SessionCheckpoint 修改 Prompt 并分支时，交互顺序必须为：UserInteraction 创建 PromptRevision → Kernel 校验恢复权限与新意图 → Workflow 验证 SessionCheckpoint 并幂等创建新 WorkflowRun → Workflow 发布 `WorkflowForkedFromSessionCheckpoint` → Kernel 更新 RuntimeProjection → UserInteraction 把新 run 节点挂入 SessionTree。若 Workflow 创建失败，UserInteraction 不得先行产生“运行中”的权威节点，只能展示待处理 operation。

UserInteraction 的隐藏、重命名显示标签和布局修改不影响 Workflow；固定、解除固定、创建、物理删除和恢复属于 Workflow 命令。Workflow 不得读取 `interaction` 基表来推断用户选择，而应只信任 Kernel 准入后的版本化命令。

人类在环路径同样不得直接互调：UserInteraction 从 Kernel ReviewProjection 构建审核工作台，将 ReviewResponse 交给 Kernel；Workflow 只接收 Kernel 已提交的 HumanReviewOpened/HumanReviewDecision。INFORMATION 类型回答中的用户正文由 PromptRevisionRef 或受 ACL 保护的 ArtifactRef 传入，不得嵌入未限制的大载荷。

### 10.5 Infrastructure

Persistence 提供事务和版本控制；Communication 提供至少一次投递；Artifact Store 保存不可变大对象；Shared Contracts 提供 schema；Module Host 负责生命周期。Workflow 不得依据具体 adapter 的内部对象扩展公共领域契约。

## 11 关键运行路径中的 Workflow 行为

本章细化 `TargetArchitecture.md` 第 7 章定义的目标运行路径，只描述 Workflow 拥有的状态、组件调用和事务边界。当前 M1/V1 只实现 `TargetM1.md` 明确收录的单 Agent 子集。UserInteraction、Kernel、ContextEngine 与 AgentToolPool 的权威职责不在本模块内重复实现。

### 11.1 新 Session 与初始 WorkflowRun

```text
Kernel CreateWorkflow
  -> Workflow Command Gateway
  -> WorkflowRun Manager 建立运行与初始恢复边界
  -> Planning Coordinator 固定定义并请求 Context
  -> TaskGraph Manager 发布 GraphRevision
  -> Readiness Evaluator 创建首批 Attempt
```

1. Workflow Command Gateway 只接收 Kernel 已准入的 `CreateWorkflow`，校验 message schema、幂等键、workSessionId、promptRevisionId 和 expectedVersion；它不读取 PromptRevision 基表或重新认证用户。
2. WorkflowRun Manager 在单个领域事务中创建 WorkflowRun、根 MissionScope、revision 0、Bootstrap Planning TaskRun/TaskAttempt、初始 WorkflowCheckpoint、Event Journal 与 Outbox。相同幂等键返回原 operation，不创建第二个运行。
3. Planning Coordinator 使用 MissionScope 的目标、预算、Capability ceiling 和 PromptRevisionRef 查询兼容 DefinitionVersion；AgentToolPool 返回值作为不可变规划输入快照保存。
4. 需要项目事实时，AgentRun Coordinator 生成 Context UnitIntent 并持久化等待 correlation。Kernel 返回 ContextPackRef Event 后，Workflow 验证 owner、missionScopeId、graphRevision 和 provenance 摘要，再恢复 Planner。
5. TaskGraph Manager 对 Planner 提案执行 DAG、Contract、MissionScope、预算和权限需求校验，按 expected currentRevision 原子发布 GraphRevision 1。Readiness Evaluator 随后计算 READY/BLOCKED 原因并创建第一批 TaskAttempt。
6. 首个 GraphRevision、运行状态与 Outbox 成功提交后，Workflow 才发布可供 Kernel 投影和 UserInteraction 展示的创建完成事实。

### 11.2 活跃运行的 Task、Agent 与 Unit 循环

```text
Readiness Evaluator
  -> TaskAttempt Manager
  -> AgentRun Coordinator
  -> UnitIntent + durable wait
  -> Kernel UnitAttempt Event
  -> AgentRun continuation / AgentResult
  -> acceptance + Resolution + downstream readiness
```

1. Readiness Evaluator 基于当前 GraphRevision、required Edge、JoinPolicy、输入 Artifact、MissionScope 状态和 barrier 生成确定性结论；TaskAttempt Manager 在同一事务重新校验输入 hash 与 revision 后创建 Attempt。
2. AgentRun Coordinator 固定 Agent/Model/Tool/Prompt DefinitionVersion 和 ContextPackRef，驱动 Agent 产生 UnitIntent。每个逻辑动作使用稳定 idempotencyKey 与 correlationId，并在发布前写入 Outbox 和等待记录。
3. Durable Runtime Adapter 只持久等待 Kernel Event，不直接运行模型、工具、Context 或 Sandbox。DBOS 重放时继续等待同一 correlation，不生成新的逻辑 Unit。
4. Workflow Command Gateway 通过 Inbox 接收 UnitAttempt Event；TaskAttempt Manager 校验 owner、attempt、graphRevision、Lease/fencing 摘要与结果引用。重复事件返回原消费结果，迟到或失效结果只登记 Evidence。
5. AgentRun 可继续请求 Unit、提出 GraphPatch、请求用户信息或提交 AgentResult。TaskAttempt Manager 使用 Contract 和 acceptance criteria 验收结果，提交 Resolution 后触发 Join 与下游 readiness 重算。
6. WorkflowRun Manager 只有在所有完成条件成立时提交 SUCCEEDED 和最终 Artifact；Kernel 的 Unit 成功、Agent 的自然语言声明或 DBOS workflow 返回均不能单独结束 WorkflowRun。

### 11.3 Git 集成与最终验收

1. 每个需要产生文件变更的 TaskAttempt 通过 ChangeSet Contract 交付 base revision、patch/commit Artifact、变更路径和 worker 测试证据。TaskAttempt Manager 验证契约和 Artifact 完整性，但不因 Worker 自测成功就宣布整体完成。
2. required coding Task 的 ChangeSet 齐备后，Integration Coordinator 按拓扑序和稳定决胜键创建 IntegrationPlan/IntegrationAttempt，通过 Kernel 物化独立干净 workspace。
3. 每次 apply、Git 检查、build 和 test 都是独立 Unit；Kernel 返回规范化 result/diagnostics/effect record，Workflow 不直接执行 Git 或 shell。
4. 任一 ChangeSet 冲突时提交结构化 ConflictRef，IntegrationAttempt 进入 CONFLICTED。不得丢弃某个变更、改写原 ChangeSet 或隐式三方合并。
5. QualityGate 全部通过后，Workflow 提交 IntegratedRevision；WorkflowRun Manager 随后进入 FINALIZING，发布 WorkflowCompletionProposed，等待 Kernel 返回 ExecutionScopeDrained 后才能提交 SUCCEEDED。

### 11.4 Pause、SessionCheckpoint 与新 Prompt 分支

```text
Kernel Pause Command
  -> WorkflowRun/MissionScope PAUSING
  -> Checkpoint Manager 提交一致边界
  -> SessionCheckpoint AVAILABLE
  -> Kernel Fork/Restore Command + 新 PromptRevisionRef
  -> 新 WorkflowRun 重新规划并执行
```

1. Workflow 接收 Kernel 已准入的 pause Command 后，以 expectedVersion 把 WorkflowRun 转为 PAUSING，并标记受影响 MissionScope；重复命令复用原 operation。
2. Workflow 停止创建新 UnitIntent，等待已运行 Attempt 到达安全边界或接收 Kernel 的 CANCELLED/ABANDONED Event。Checkpoint Manager 在领域状态、事件序号、effect record 和 ArtifactRef 一致后创建 WorkflowCheckpoint。
3. 策略或用户请求要求长期恢复点时，Checkpoint Manager 按第 7.4 节事务创建 SessionCheckpoint operation，物化并校验自包含 manifest，最终提交 AVAILABLE；UserInteraction 只能在该事件提交后展示保存点。
4. 用户选择保存点并提交新 Prompt 后，Workflow 接收含 checkpointId 与 promptRevisionId 的 fork/restore Command。Checkpoint Manager 只验证 availability、manifest hash 和 Workflow 内部一致性；Restore Coordinator 创建 RestoreOperation/RestorePlan，将 Artifact、DefinitionVersion、Context、workspace、权限/预算和 effect ledger 验证分派给对应权威 Module。
5. 默认恢复模式以复合事务创建 `RESTORING` 的新 WorkflowRun、RestoreOperation、新 DBOS execution 启动意图、根或派生 MissionScope 的 ID mapping，并记录 parentRunId、parentSessionCheckpointId 和新 PromptRevisionRef。来源 WorkflowRun 保持 PAUSED，来源 Checkpoint 与历史事实不变。
6. Kernel 对每个真实恢复动作重新准入，各 Module 返回幂等 Result/Event。Restore Coordinator 在全部 required action 通过后验证 source-to-target mapping，根据 manifest 重建允许继承的 Task/Artifact/决策引用，将新 Prompt 作为分支输入，发布新 GraphRevision 后才进入 11.2 的执行循环。失败时不得发布可运行的分支节点事件。

### 11.5 运行中变更与重新规划

```text
Kernel UserChangeSignal/Replan Command
  -> Planning Coordinator 计算影响闭包
  -> MissionScope PAUSING + Kernel revision barrier
  -> Checkpoint Manager 提交安全边界
  -> TaskGraph Manager 发布新 GraphRevision
  -> 兼容分支继续，受影响分支重建 Attempt
```

1. Workflow Command Gateway 校验 Kernel 已准入的 replan/UserChangeSignal、PromptRevisionRef、expectedVersion 和幂等键，并把同一变更的重复投递映射到原 operation。
2. Planning Coordinator 以当前 revision 计算 MissionScope 子树、DAG 下游、Join、Artifact、workspace、权限和副作用影响闭包；范围不能可靠判定时返回保守候选集合。
3. WorkflowRun Manager 将受影响 MissionScope 转为 PAUSING，并请求 Kernel 建立 revision barrier；在 barrier 生效前不得为该集合创建新 UnitIntent。
4. Checkpoint Manager 等待安全边界并提交 WorkflowCheckpoint/effect ledger 后，TaskGraph Manager 才能基于最新 baseRevision 校验并发布新 GraphRevision。
5. 未受影响分支重新验证 Contract、workspace 和 Artifact 兼容性后继续；受影响 Task 创建新的 Attempt。旧 revision 结果只登记 Evidence。

### 11.6 人类审核等待与恢复

```text
Workflow 产生 HumanReviewIntent
  -> Kernel HumanReviewOpened
  -> Human Review Coordinator 持久等待
  -> Kernel HumanReviewDecisionSignal
  -> 校验决定与当前 revision
  -> 继续 / 返工 / 重规划 / 取消 / NEEDS_ATTENTION
```

1. AgentRun、TaskAttempt Manager、Planning Coordinator 或 WorkflowRun Manager 识别权限许可、信息补充、方案选择或结果验收需求，生成包含 targetRef、allowedDecisions、EvidenceRef 和 deadline 的 HumanReviewIntent。
2. Kernel 返回 HumanReviewOpened 后，Human Review Coordinator 在单个事务写入 `human_review_waits`、目标对象的 `WAITING_HUMAN_REVIEW`/等价阻塞状态、Event Journal 与 Outbox。相同 reviewId 不得建立第二个等待点。
3. 审核期间只冻结依赖该决定的 AgentRun、TaskAttempt 或 MissionScope；无数据、权限、workspace 或 Join 依赖的其他分支可继续执行。Workflow 不轮询 UserInteraction，也不读取 Kernel 审核表。
4. 收到 HumanReviewDecisionSignal 后，Coordinator 校验 reviewId、requestVersion、reviewType、targetRef、graphRevision、reviewedParametersHash、policyVersion、expiry 和允许决定集合。重复决定返回原处理结果；失效、过期或不匹配决定不恢复控制流。
5. APPROVAL 批准使 Workflow 重新检查目标状态后等待 Kernel 的 Grant/Unit 结果；拒绝或 request-changes 触发替代方案或 replan。INFORMATION 将回答引用交给 AgentRun；DECISION 固定选中方案；ACCEPTANCE 决定完成、返工或失败。
6. 业务状态、参数、revision 或来源 PromptRevision/Checkpoint 已变化时，Workflow 关闭当前等待并提交 ReviewNoLongerApplicable/ReviewRenewalRequired，必要时产生新的 HumanReviewIntent。原决定保留审计但不得复用。

### 11.7 取消与补偿

```text
Kernel Cancel Command
  -> WorkflowRun/MissionScope CANCELLING
  -> 停止新 UnitIntent 并等待撤销结果
  -> Compensation Coordinator 处理 effect ledger
  -> CANCELLED 或 NEEDS_ATTENTION
```

1. cancel Command 使 WorkflowRun 和目标 MissionScope 进入 CANCELLING，停止产生新 UnitIntent，并取消仍可取消的人工等待；已提交 HumanReviewDecision 保留为审计事实。
2. Workflow 等待 Kernel 对相关 Lease、Grant 和 UnitAttempt 的撤销/终止 Event，不以 Worker 进程终止直接推断业务结果。
3. Compensation Coordinator 根据 effect ledger 创建显式 Compensation Task；外部效果未知时请求 reconciliation，并可产生 UNKNOWN_EFFECT 类型的人类审核。
4. Workflow 结算 Task/Agent 状态，在补偿完成后提交 CANCELLED；无法安全确认或补偿时提交 NEEDS_ATTENTION，不得伪报取消完成。

### 11.8 崩溃恢复与消息重放

```text
DBOS 恢复等待控制流
  -> Repository 加载已提交聚合
  -> Outbox 重发、Inbox 去重
  -> 恢复 Unit/HumanReview correlation 等待
  -> 接收 Kernel reconciliation 结果
  -> 从一致边界继续
```

1. Workflow 进程重启后，Durable Runtime Adapter 从 DBOS 恢复等待点，Repository 从领域表和 Event Journal 加载最新聚合版本。
2. Outbox dispatcher 重发未确认消息，Inbox 保证重复 Command、Unit Event 和 HumanReviewDecision 不产生第二次状态变化。
3. `human_review_waits` 中未完成请求继续等待相同 reviewId；已完成决定通过 decisionRef 幂等恢复，不重新请求用户审核。
4. 若 Kernel 已回收 Lease，Workflow 等待规范化超时/废弃 Event，再按策略创建新 TaskAttempt 或 UnitIntent；不得依据 Worker 存活状态自行推断结果。
5. DBOS 历史不兼容时禁止同运行 resume，但完整 SessionCheckpoint 仍可用于创建新运行；恢复后仍需重新验证未决审核的 requestVersion、revision 与有效期。

## 12 控制操作语义

### 12.1 Pause 与 Resume

Pause 是可恢复控制：停止新 UnitIntent，请 Kernel 停止发放相关 Lease，等待运行中 Attempt 到安全边界并提交 WorkflowCheckpoint；达到 policy 规定的重大边界时再生成 SessionCheckpoint。超过 grace period 按 cancelPolicy 处理。Resume 必须校验当前 revision、DefinitionVersion、输入 Artifact、workspace 与 DBOS runtime 是否仍兼容。

### 12.2 Cancel

Cancel 表示不再追求目标，不代表删除事实。Workflow 进入 CANCELLING，传播子 MissionScope，Kernel 撤销 Lease/Grant，运行中副作用按 effectRecord 判断是否补偿。最终保留 Event、Artifact、费用和审计。

### 12.3 Retry、Resume、Rerun 与 Fork

| 操作 | 身份 | 起点 | 适用场景 |
|---|---|---|---|
| retry | 同一 TaskRun，新 TaskAttempt | 原输入或显式新快照 | 暂时性失败 |
| resume | 同一 WorkflowRun | 兼容的 WorkflowCheckpoint + DBOS 状态 | 暂停或短期崩溃恢复 |
| rerun | 新 WorkflowRun | 原始目标/配置 | 独立重新执行 |
| fork/restore | 新 WorkflowRun + parentRunId + parentSessionCheckpointId | AVAILABLE SessionCheckpoint + 新 PromptRevision | 长期恢复、用户回退与探索替代路径 |

### 12.4 SessionCheckpoint 用户操作

- `create`：请求只能指定目标里程碑和用户说明，不能提交自造 manifest；Workflow 在下一个安全一致边界生成。
- `pin/unpin`：只改变允许的 retentionClass，不改变状态内容；LEGAL_HOLD 不能由普通用户解除。
- `rename`：若只是 SessionTree 显示名，由 UserInteraction 维护；若修改 Workflow 发布的 checkpoint title，必须走版本化命令并保留审计。
- `restore/fork`：默认创建新 WorkflowRun 与新 DBOS execution，不修改来源运行；新 PromptRevision 是分支点。
- `delete`：隐藏与物理删除分离；物理删除异步、可审计，删除完成前不得报告 Artifact 已回收。

## 13 人类在环的 Workflow 设计

### 13.1 领域边界

本章落实 `TargetArchitecture.md` 第 10 章的人类在环目标模型。Workflow 的职责是提出业务需求、持久等待和解释决定，不是管理审查者或授权。Kernel 拥有 HumanReviewRequest、ReviewPolicy、审查者资格、多人数聚合和 HumanReviewDecision；UserInteraction 拥有用户提交的 ReviewResponse 与交互视图；Workflow 仅拥有 HumanReviewIntent、HumanReviewWait 以及决定对 TaskGraph、MissionScope、TaskAttempt 和 AgentRun 的业务影响。当前 M1/V1 不实现本章能力。

Workflow 不得直接接收浏览器或 CLI 的批准，不得从 UserInteraction 查询“是否已点击”，不得自行将超时解释为批准，也不得把人工批准转换为 CapabilityGrant。所有决定必须以 Kernel 签名或可验证来源的 HumanReviewDecisionSignal 到达。

### 13.2 HumanReviewWait

`human_review_waits` 至少包含：

| 字段 | 说明 |
|---|---|
| `humanReviewWaitId/reviewId` | Workflow 本地等待 ID 与 Kernel 权威请求引用；均唯一 |
| `reviewType` | `APPROVAL`、`INFORMATION`、`DECISION`、`ACCEPTANCE` |
| `workflowRunId/missionScopeId/taskAttemptId/agentRunId/unitIntentId` | 等待对象引用；按类型允许为空 |
| `requestVersion/graphRevision/policyVersion` | 决定消费时必须匹配的版本绑定 |
| `parametersHash/promptRevisionId/checkpointId` | 防止把决定用于已变化的输入或恢复分支 |
| `allowedDecisions` | 当前业务状态能够接受的决定集合 |
| `resumeTokenRef` | Durable Runtime Adapter 的 opaque 恢复引用 |
| `deadline/status/decisionRef` | 超时、处理状态与 Kernel 决定引用 |
| `createdAt/resolvedAt/version` | 审计与并发控制 |

状态固定为 `INTENT_RECORDED -> REQUEST_OPEN -> DECISION_RECEIVED -> APPLIED`，旁路终态为 `EXPIRED`、`INVALIDATED`、`CANCELLED`、`NO_LONGER_APPLICABLE`。`DECISION_RECEIVED` 与领域变更必须在同一 Workflow 事务或可幂等恢复的两步事务中完成，避免决定已消费但业务状态未推进。

### 13.3 四类审核的业务语义

| reviewType | 产生位置 | Workflow 等待范围 | 决定后的处理 |
|---|---|---|---|
| APPROVAL | Unit 所需权限、高风险副作用或预算突破 | 默认阻塞目标 Unit/AgentRun；共享能力变化可阻塞 MissionScope | APPROVE 后等待 Kernel 准入结果；REJECT/REQUEST_CHANGES 后替代、replan 或失败 |
| INFORMATION | Planner/Agent 缺少必要事实 | 阻塞依赖答案的 AgentRun 或 TaskAttempt | 将答案 PromptRevisionRef/ArtifactRef 固定为新输入快照，再继续或 replan |
| DECISION | 多个合法方案需要业务选择 | 阻塞消费该选择的图分支 | 固定 optionId 与 Evidence，必要时发布 GraphPatch；未选分支按图规则失效 |
| ACCEPTANCE | 阶段结果或最终结果需要人工验收 | 阻塞 Task Resolution、MissionScope 完成或 Workflow 完成 | ACCEPT 提交验收事实；REJECT/REQUEST_REWORK 创建返工 Attempt 或重新规划 |

同一请求只能表达一种 reviewType。需要先补充信息再审批时，必须先完成 INFORMATION，再基于新输入创建独立 APPROVAL，避免旧参数 hash 下的批准被复用。

### 13.4 决定准入与状态推进

Human Review Coordinator 消费决定时依次验证：Inbox 去重 → reviewId/requestVersion → 目标 owner → wait 非终态 → reviewType/decision 合法 → graphRevision/policyVersion/parametersHash → deadline → 当前聚合仍允许该转换。任一步失败均不得恢复 AgentRun 或 TaskAttempt。

有效决定的应用顺序为：锁定 HumanReviewWait 和目标聚合 → 写入 decisionRef → 执行业务 reducer → 更新等待状态为 APPLIED → 写入领域 Event 与 Outbox → 提交事务 → 由 DBOS 恢复后续控制流。APPROVAL 的 APPLIED 仅表示 Workflow 已接受审核事实；Unit 仍需等待 Kernel 发放 ExecutionPermit。

### 13.5 失效、超时、取消与重新审核

参数、目标资源、GraphRevision、DefinitionVersion、policyVersion、PromptRevision、Checkpoint、预算或业务状态变化时，Workflow 必须关闭不再适用的 HumanReviewWait，并通知 Kernel 失效或续审。若动作仍必要，创建新的 HumanReviewIntent 和新 correlation；不得修改旧等待记录的绑定条件。

超时默认进入 EXPIRED，不得自动批准。Workflow 可依据 required、deadline 和替代方案继续等待、选择低风险替代路径、重新规划、失败或进入 NEEDS_ATTENTION。取消传播到等待对象时，本地 wait 转为 CANCELLED，并请求 Kernel 撤销仍开放的 HumanReviewRequest；并发到达的决定依据 aggregateVersion 和事件发生顺序处理，不能使已取消目标恢复运行。

### 13.6 Checkpoint 与恢复

WorkflowCheckpoint manifest 必须包含未决 HumanReviewWait 的 reviewId、类型、版本绑定、deadline 和 resumeTokenRef，不包含审查者身份、完整请求正文或尚未提交的用户响应。SessionCheckpoint 可保留审查谱系和已提交 DecisionRef，但从其 fork 新运行时不得继承短期批准、开放请求或 Grant；新运行按当前参数、Policy 和风险重新判断是否需要审核。

恢复时，Workflow 先从本地等待记录恢复 correlation，再通过 Kernel Query 确认请求当前状态。Kernel 返回已有决定时按幂等规则消费；请求过期、撤销或不存在时关闭等待并执行相应业务策略，不得重新创建同一个逻辑请求造成重复人工操作。

## 14 错误处理与边界场景

### 14.1 Workflow 的错误处理职责

Workflow 只负责业务语义错误及外部错误对业务状态的影响。它必须识别非法状态转换、GraphPatch/Join/Contract 失败、revision 冲突、结果验收失败、Checkpoint 不一致、完成条件不满足和补偿失败；身份、Policy、Lease、Executor、Context 检索和 Definition 解析的原始错误分别由其权威 Module 分类，Workflow 仅消费规范化结果。目标系统错误责任矩阵见 `TargetArchitecture.md` 第 15 章；当前 M1/V1 只实现 `TargetM1.md` 列出的错误类别与发布门。

错误处理必须在拥有目标聚合的事务中提交失败事实、projection、Event Journal 和 Outbox。处理失败不得覆盖已有终态，不得删除原始 Event，也不得因 DBOS 重放而重复创建 Attempt、GraphRevision、Checkpoint 或补偿任务。

### 14.2 分类与决策

| 输入错误类别 | Workflow 判断 | 允许的动作 |
|---|---|---|
| VALIDATION / CONTRACT | 输入、GraphPatch 或 AgentResult 不满足 schema/验收条件 | 拒绝提交；保存证据；修复提示、替代 Agent/Model、创建新 TaskAttempt 或失败 Resolution |
| CONFLICT | aggregateVersion、graphRevision、Checkpoint version 或并发结果冲突 | 读取最新事实并重新计算；不得隐式覆盖或自动合并 GraphPatch |
| POLICY | Kernel 拒绝权限、审批或数据范围 | 选择无需该能力的计划、等待用户决定或结束目标；不得降低策略要求 |
| RESOURCE / TIMEOUT | Unit 资源不足、限流、Lease 过期或超时 | 在 retry policy、deadline、预算和幂等条件允许时重试；否则 fallback、replan 或失败 |
| DEPENDENCY | Context、Definition、Provider 或 Artifact 依赖不可用 | 等待、使用显式兼容替代项、标记 DEGRADED/INCOMPATIBLE 或请求人工处理 |
| EXECUTION | Executor、Sandbox、模型或工具执行失败 | 消费 Kernel Event；创建新 UnitAttempt 的决定留给 Kernel，Workflow 只决定 TaskAttempt 级 retry/replan |
| INTEGRITY | Checkpoint、Artifact、事件序列或引用校验失败 | 停止相关恢复或结果提交，进入 reconciliation/NEEDS_ATTENTION；不得部分恢复 |
| INTERNAL | 未分类的 Workflow 缺陷或不可恢复异常 | 保持最后提交状态，记录受控诊断并告警，等待人工处理或修复后从一致边界恢复 |

### 14.3 边界场景

- **重复 Unit Event**：Inbox 去重；已消费 correlation 返回原处理结果。
- **迟到成功结果**：若 Attempt 已终态、Lease/fencing 过期或 revision 被 barrier 隔离，仅保存 Evidence。
- **step 提交后崩溃**：幂等命令和 aggregate version 防止重复领域变化。
- **Outbox 发布前崩溃**：事务内 Outbox 保留，dispatcher 恢复发布。
- **发布成功但 ack 丢失**：重复投递由 Inbox 去重。
- **Artifact 已写但事务失败**：引用不成立，延迟 GC 清理孤儿。
- **Provider 状态未知**：不得自动假定失败；进入 effect reconciliation，必要时人工确认。
- **GraphPatch 与用户变更并发**：expected currentRevision 决胜，失败提案基于最新版本重算。
- **审批期间参数变化**：原审批失效，重新发起请求。
- **Agent 输出无法解析**：记录原始输出 Artifact，按 CONTRACT 错误进入修复提示、替代模型或重新规划，不无限重试。
- **SessionCheckpoint 创建中崩溃**：reconciliation 复用 operationId 补齐或标记 DEGRADED，不创建第二个逻辑保存点。
- **源 WorkflowCheckpoint 已删除**：使用 SessionCheckpoint 自包含 manifest 恢复；不得因 provenance 行缺失判定不可恢复。
- **Artifact 或 DefinitionVersion 缺失**：将 SessionCheckpoint 标记 DEGRADED/INCOMPATIBLE 并返回缺失清单，不启动部分运行。
- **恢复与删除并发**：以 SessionCheckpoint expectedVersion 和行锁决胜；已接受恢复 operation 的根引用在新运行创建完成前保持有效。
- **DBOS 历史已清理**：禁止 RESUME_SAME_RUN；若长期 manifest 完整则降级为 FORK_NEW_RUN。

## 15 安全与数据保护

Workflow 只处理 CapabilityRef 和 SecretRef，不读取 Secret 值。Agent 输入中的 ToolSchemaProjection 必须按任务裁剪，避免暴露完整目录。目标、用户内容、工具输出和 Artifact metadata 均视为不可信输入，必须执行 schema、大小、媒体类型和注入风险检查。

所有查询带 tenant/project 范围；`workflow_app` 数据库角色只写 workflow schema，不能读取 interaction/kernel/context 基表或 DBOS 内部表；Artifact 访问使用 Kernel 短期许可。审计记录 Command 发起者、Policy/HumanReviewDecision 引用、revision、before/after aggregate version、Checkpoint operation 和结果，但对 prompt、源代码、个人数据与 Secret 执行分级和脱敏。SessionCheckpoint manifest 不得内嵌 Secret、短期 credential、不受保留策略约束的原始 prompt 或完整 HumanReviewRequest/Response。

## 16 可观测性

每个领域事务创建或关联 span，属性包含 workflowRunId、missionScopeId、taskRunId、taskAttemptId、agentRunId、graphRevision、aggregateVersion、correlationId。禁止把完整 prompt 或结果作为 span attribute。

模块必须暴露：

- Workflow 数量与各状态时长；计划、重规划、完成和取消率。
- READY 到 Attempt 创建延迟；Attempt/AgentRun 周期；Join 等待时间。
- GraphPatch 校验失败原因；optimistic conflict；重复 Event；迟到结果。
- DBOS 恢复次数与恢复延迟；Outbox backlog；Signal 等待超时。
- HumanReviewWait 数量、类型、等待时长、过期/失效/取消率、决定重复率、决定到业务恢复延迟和 NEEDS_ATTENTION 数量。
- 按 DBOS/Workflow/Session 分类的 Checkpoint 数量、大小、创建频率、创建失败、可恢复验证、GC 延迟和 Artifact roots；预算预留与结算偏差。

关键告警包括 Workflow 长期无进展、PAUSING 超时、Outbox 积压、等待 correlation 无对应 Unit、MissionScope 已终态仍有 Lease、current revision 中 required Task 不可达。

## 17 测试设计

### 17.1 单元与属性测试

- 各状态机所有合法/非法转换和终态不可逆。
- DAG 无环、Reachability、fan-out/depth、Join ALL/ANY/QUORUM。
- GraphPatch canonical hash、版本冲突和 Contract 不兼容。
- MissionScope 继承、最低公共祖先、预算与 ceiling 不越界。
- 相同 evaluator 输入输出确定性；Event 重复不改变结果。
- attemptNo、aggregateVersion、graphRevision 单调递增。
- 完成判定缺一条件必不成功。
- HumanReviewWait 状态转换、终态不可逆、绑定变化必失效、重复决定幂等，以及 APPROVAL 不直接产生 Grant。

### 17.2 集成测试

- PostgreSQL 事务同时写 projection、Journal、Outbox；注入每个提交点崩溃。
- DBOS 在等待 Unit/Signal、timer 和版本升级时恢复。
- Kernel stub 返回成功、失败、重复、乱序、迟到与错误 owner/revision Event。
- ContextPack revision/ACL/token 超限被拒绝。
- Artifact 写入成功但 DB 失败，以及 DB 引用不存在对象。
- 两个并发 GraphPatch、两个并发结果验收、pause/cancel 与结果同时到达。
- WorkflowCheckpoint 创建与事务提交点逐点崩溃；恢复后 manifest/eventSequence 一致。
- SessionCheckpoint `CREATING -> PREPARING -> COMMITTING -> AVAILABLE` 各阶段崩溃、重复命令与 reconciliation；部分 owner prepare/commit 成功后崩溃不会泄漏保留或错误发布 AVAILABLE。
- CheckpointParticipant 返回 required 不可保留、可选依赖失败、重复 token、强制删除墓碑和永久 commit 失败时，Workflow 正确 abort/release 并更新 availability。
- 删除 WorkflowCheckpoint/DBOS 历史后，仍可从 SessionCheckpoint 创建新 WorkflowRun。
- SessionCheckpoint 删除与恢复并发、PINNED/LEGAL_HOLD 拒绝删除、共享 Artifact 不被误 GC。
- `workflow_app` 对 interaction/kernel/context/dbos 越权 SQL 被数据库拒绝。
- HumanReviewDecision 重复、乱序、过期、错误 reviewType、错误参数 hash、旧 revision、并发取消和 DBOS 恢复等待均不能错误推进业务状态。

### 17.3 E2E 场景

1. 静态 TaskGraph 驱动单个确定性 Worker，结构化结果通过 Contract 与 `ALL` Join 验收。
2. 两个脚本 Worker 在隔离 workspace 交付 ChangeSet，按固定 IntegrationPlan 在干净 workspace 集成并通过 QualityGate。
3. 路径预检冲突、patch 应用冲突、base mismatch 和 QualityGate 失败均停止完成，且保留可定位 Evidence。
4. Worker 崩溃、Lease 过期和新 Attempt 接管后，旧 fencing 结果被拒绝。
5. Control Plane 在领域事务、Outbox 发布和 DBOS 等待点附近被 kill，重启后不丢状态也不重复提交结果。
6. 高风险命令进入单人 APPROVAL；合法决定后重新准入，参数或 revision 变化使旧批准失效。
7. cancel 与结果同时到达时，只有符合版本与 fencing 的一方按状态机生效；完成候选必须等待 Kernel drain。
8. 创建 SessionCheckpoint 时，Kernel、ContextEngine、AgentToolPool、UserInteraction 与 Artifact Store fake 返回准备/提交结果；只有 required retention 全部 ACTIVE 后保存点才 AVAILABLE，WorkflowCheckpoint/DBOS 历史删除不破坏它。
9. 从 SessionCheckpoint 创建 RestoreOperation，由上述 owner fake 返回版本化 RestoreActionResult，最终派生新 WorkflowRun。
10. 恢复分支不继承旧 Grant、Lease、Secret、审批或 Executor 会话；任一必需 RestoreAction 失败时不得进入 READY。普通崩溃 resume、retry 和 replan 均不创建 RestoreOperation。
11. 上述 V1 场景按第 11 章的事务与状态顺序完成；动态 replan、模型限流、自动 Checkpoint 轮换、四类完整 HITL 和多人审核属于后续阶段。

### 17.4 性能目标

V1 不承诺大规模生产 SLO。在记录 CPU、内存、磁盘、PostgreSQL 和执行环境版本的固定开发环境中，基准至少覆盖 10 个并发 Workflow、每个 10 个 Task/不少于 100 个 Event：Command 接收 P95 小于 300 ms（不含执行）、readiness 批次计算 P95 小于 500 ms、Event 到 CLI 投影可见 P95 小于 2 s、崩溃后控制流恢复 P95 小于 30 s。更大并发、公平性和 SSE 连接基准属于 Beta。

## 18 实现包结构与接口

```text
packages/workflow/
  domain/          聚合、值对象、状态机、领域错误
  application/     command/query handlers、use cases
  graph/           patch、validation、readiness、join
  mission-scopes/  supervision、impact closure、completion
  agents/          durable agent loop、result handling
  integration/     ChangeSet、IntegrationPlan、冲突分类、QualityGate 与 IntegratedRevision
  human-review/    intent、wait state、decision handling、invalidation
  checkpoints/     Workflow/Session checkpoint、manifest、restore、retention、GC roots
  restore/         RestoreOperation、RestorePlan、ID mapping 与跨模块恢复 Saga
  compensation/    effect reconciliation 与反向任务
  ports/           Kernel、Context、Catalog、Persistence、Artifact
  adapters/dbos/   DBOS durable runtime adapter
  adapters/pg/     Kysely repositories 与 migrations
  projections/     UI/read model projectors
  contracts/       模块拥有的 payload schema
  testing/         builders、fakes、fault injection fixtures
```

领域层不得导入 Fastify、DBOS、Kysely、MCP 或模型 SDK。Application 层只依赖 Port；Adapter 负责技术映射。公共 Contract 从 `packages/contracts` 引用基础 Envelope，在 Workflow 包内拥有具体 payload schema。

## 19 实施顺序

V1 按以下顺序实现，不以真实 LLM/Agent 作为前置条件：

1. 定义 ID、值对象、状态枚举、Error、Envelope、Command/Event/Result、TaskGraph、UnitIntent、ChangeSet、IntegrationPlan 和 RestorePlan schema，并建立 reducer/兼容测试。
2. 建立 workflow schema、Kysely migration、Repository、Journal/Outbox/Inbox 事务模板，验证 DBOS transaction/checkpoint 与领域提交的原子或幂等桥接。
3. 实现 WorkflowRun、TaskRun/Attempt、MissionScope、静态 GraphRevision、WorkflowCheckpoint，以及无副作用 Readiness/ALL Join/完成候选判定。
4. 建立 DBOS Adapter 和 Kernel Unit Port，使用脚本化/确定性 Worker 完成单 Worker 闭环，验证重复 Event、迟到结果、cancel、有限 retry 和进程 kill 后 resume。
5. 实现最多双 Worker 并行、独立 workspace 和 ChangeSet 交付；实现 Integration Coordinator，在干净 workspace 顺序应用 patch、分类冲突、运行固定 QualityGate 并提交 IntegratedRevision。
6. 实现 FINALIZING 两阶段完成协议、最小 Lease/fencing、单人 APPROVAL 等待和高风险命令准入。
7. 实现用户显式 SessionCheckpoint 的 dependency manifest、CheckpointParticipant prepare/commit/abort/query/release、RestoreOperation/RestorePlan 和 `FORK_NEW_RUN`；使用 fake 其他 Module 验证跨模块保留与恢复结果、新 Grant/Lease 要求、workspace 物化和失败清理。
8. 实现 CLI 需要的投影、结构化报告和固定 fixture E2E，覆盖单 Worker、双 Worker、冲突、测试门失败、重复消息、崩溃恢复和 checkpoint fork。

V1.1 再实现 AgentRun 的真实模型循环、Bootstrap Planner、Context 装配、token/成本结算和 coding-agent 评测。动态 replan、ANY/QUORUM Join、四类完整 HITL、自动 SessionCheckpoint 轮换、Artifact GC、通用 compensation 和 Web/SSE 属于后续 Beta。

每一步必须包含 schema、migration、自动化测试、指标和回滚/兼容策略。不得先实现 DBOS 流程再倒推领域模型。

## 20 模块验收标准

Workflow Module 可进入 V1 发布必须满足：

1. 输入静态 TaskGraph 后，创建、单/双确定性 Worker 执行、ALL Join、Git 集成、QualityGate、FINALIZING drain 和最终完成形成可恢复闭环。
2. TaskGraph 与 MissionScope 语义分离，GraphRevision 发布原子且历史不可变。
3. 所有副作用通过 UnitIntent；DBOS step 不直接运行外部操作。
4. 重复、乱序、迟到 Event、版本冲突和旧 fencing 均有自动化测试且不能破坏当前状态。
5. resume、cancel、retry 和 checkpoint fork 的身份与状态语义互不混淆；V1 不暴露动态 replan/rerun 语义。
6. ChangeSet 必须绑定 base revision，IntegrationPlan 顺序确定，冲突不被静默解决，Worker 自测不替代集成 QualityGate。
7. DeterministicResult/ChangeSet 必须通过 Contract 与 acceptance criteria；TaskAttempt 和 IntegrationAttempt 终态不可覆盖。
8. Workflow 使用 CompletionProposed/ExecutionScopeDrained 两阶段协议，不存在 Workflow 与 Kernel 互相等待的完成死锁。
9. 所有状态变化可由 Event Journal 审计，投影可重建，DBOS/Telemetry 不成为第二事实源。
10. DBOS Checkpoint、WorkflowCheckpoint、SessionCheckpoint 的所有权和恢复路径分离；SessionCheckpoint 保存使用 CheckpointParticipant 和 ACTIVE retention token 保证 required dependency，fork 使用 RestoreOperation/RestorePlan，其他 Module 只保留或恢复自己的权威状态。
11. UserInteraction 只能经 Kernel 请求 Checkpoint 操作，Workflow 不直接读取 interaction schema，数据库 role 能阻止跨模块写入。
12. fixture 驱动的双 Worker E2E、patch 冲突、QualityGate 失败、进程 kill 恢复、跨 Module checkpoint 保存/fork、单人 APPROVAL 和数据库越权拒绝测试全部通过。
13. Workflow 不接管其他 Module 的身份、授权、审查者、资源、检索或定义权威；Restore Coordinator 只消费其他 Module 返回的版本化结果。

## 21 后续演进约束

V1 完成后先进入 V1.1，在不改变 Task/Unit/ChangeSet/Integration/Restore 契约的前提下接入真实 Planner 和 coding Agent。随后才可增加动态 GraphPatch、ANY/QUORUM/自定义 Join、协作式多 Agent TaskAttempt、完整 HITL、远程 Worker 和 NATS，且必须通过新 schemaVersion 或显式能力标志演进。引入 LangGraph 仅可作为单 Agent 内部无副作用推理辅助，不得拥有外层 Task 状态或独立恢复语义。替换 DBOS 为 Restate/Temporal 时，领域对象、Event 和 Port 保持稳定，并以迁移演练证明现有运行可完成或安全封存。

任何演进都不得改变三项基本结论：Workflow 决定业务可执行性，Kernel 决定执行准入与物理运行，DBOS/替代 runtime 只负责持久控制流恢复。
