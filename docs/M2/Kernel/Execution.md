# MultiAgentOS M2 Kernel.Execution

> 状态：草稿（阶段 1）。

## 1. 定位

Execution 负责 UnitAttempt、执行队列、产物与内建 Unit；阶段 2 起还负责工作区快照、快照索引与改动检测。
组件间交互见 [Interaction](Interaction.md)，长期规划见 [Execution 架构](../../Architecture/Kernel/Execution.md)。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 | 阶段 |
|---|---|---|---|
| 产物归属按运行登记，引用只能在本运行内使用 | 按 Session 登记（Session 级状态），写入 `artifact-owners.jsonl`；引用在本 Session 内有效 | M2Design 第 10.1 节 | 1 |
| 正文只有执行产物、报告与运行摘要 | 增加用户输入的正文（`storeUserInput`）与发布的消息（`message-publish`） | M2Design 第 4.2、8.1 节 | 1 |
| 只有内建 Unit `report-publish` | 增加 `message-publish` | M2Design 第 8.1 节 | 1 |
| 不读取项目文件 | `readProjectFile`：按白名单读取 `AGENTS.md` 与模板文件，正文存为产物 | M2Design 第 7.5 节 | 1 |
| 启动时不回收产物 | 启动时回收无人拥有的正文 | [ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节 | 1 |
| 唯一的 FIFO | 阶段 1 不变；阶段 4 改为按 AgentRun 分队列与并发类别 | M2Design 第 7.1 节 | 4 |
| 不做快照 | 工作区快照、快照索引、改动检测、回退 | M2Design 第 4.6、7.1 节 | 2 |

UnitAttempt 的状态机、技术重试、`ExecutionRequest` 的构建与上下文构建记录与 M1 相同，见归档的 [M1 Execution](../../History/M1/Kernel/Execution.md) 第 3、6–8 节。

## 3. 产物归属

- 每写入一个产物，Execution 追加一行 `ArtifactOwnerLine`（Interface/Persistence 第 4.3 节），并更新内存中的归属索引。
- 打开 Session 时从 `artifact-owners.jsonl` 读入归属索引。
- 需要解析的引用（M1 Execution 第 4 节列出的位置，加上 `HumanAnswered.contentRef`、`MessagePublishInput` 中的引用、`readArtifact` 的引用）
  必须在本 Session 的归属索引中，且 `sha256`、`size` 一致，否则返回 `INVALID_ARTIFACT_REF`，不说明是不存在还是不属于本 Session。
- 授权仍按运行：能引用旧产物，不等于能重新读取仓库（M2Design 第 10.1 节）。

## 4. 用户输入与项目文件

- `storeUserInput({ inputId, text })`：把正文以 `text/plain; charset=utf-8` 存为产物，登记归属；同一 `inputId` 再次调用返回同一引用。
- `readProjectFile(path, scope)`：只接受 Interface/WorkflowKernel 第 2.2 节的白名单路径；经 `RepositoryAccess` 读取（与 `file-read` 共用路径检查与排除规则），
  不跟随符号链接；文件不存在时返回 `exists: false`；存在时把正文存为产物并返回 SHA-256。不计入任何 AgentRun 的额度。

## 5. 内建 Unit：`message-publish`

与 `report-publish` 相同，不派发给 Supervisor，由 Execution 在 Session actor 的处理中完成：

```text
取到 message-publish 尝试
  → 输入已在受理时按 Schema 校验：{ kind: 'REPLY' | 'RUN_RESULT', contentRef: ArtifactRef, agentLabel }
  → contentRef 必须属于本 Session（第 3 节）
  → 不复制正文；登记一条发布记录
  → submitResultCheck(COMPLETED, output = { kind }, outputRef = contentRef)
Core 在结果检查后向 UserInteraction 发出 MessagePublished
```

回复与运行结果的正文由 `model-call` 的输出或 Workflow 生成的确定性报告产生；后者经 Kernel 存为产物后再发布（M2Design 第 7.3 节"必有报告"）。

## 6. 启动时的产物回收

Kernel 核心启动时、开放服务之前，Execution 读取全部 Session 的 `artifact-owners.jsonl`，汇总为拥有集合，调用 `ArtifactStorePort.sweep`
（[ArtifactStore](../Infrastructure/ArtifactStore.md) 第 4 节）。回收失败只写诊断，不阻止启动。

## 7. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `executionLimits.MESSAGE_PUBLISH`、`REPOSITORY_LIST` | Execution | 前者为内建，不设截止时间；后者 `timeoutMs` 30000、`maxOutputBytes` 1048576 |
| 其余 | Execution | 与 M1 Execution 第 10 节相同 |

## 8. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 15：ArtifactStore 只由 Execution 写入；日志中只有引用 | 架构测试：只有 Execution 持有 `ArtifactStorePort` |
| 产物引用只在本 Session 内有效 | 单元测试：另一 Session 的引用返回 `INVALID_ARTIFACT_REF`；重开 Session 后旧引用仍然有效 |

## 9. 阶段

| 阶段 | 本文增加的内容 |
|---|---|
| 1 | 第 3–8 节 |
| 2 | 影子 git 快照、快照索引、改动检测、`/undo`、`/undo all`、`/diff` 的六个步骤、Fork 时继承产物、打开 Session 时比较工作区 |
| 3 | 敏感文件列表、受保护路径的新建检查与隔离、EXEC 互斥 |
| 4 | 按 AgentRun 分队列、并发类别与屏障、全局上限、等待调用机会、改动归属 |
| 5 | 按并发类别处理暂停、按执行取消、中止时排队中的尝试也交付 |
