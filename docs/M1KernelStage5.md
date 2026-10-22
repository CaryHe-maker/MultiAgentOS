# MultiAgentOS M1 Kernel 阶段五实现报告

> 状态：工作文档，2026-10-22 完成阶段五实现验收。
> 依据：[M1-kernel-infra-plan](M1-kernel-infra-plan.md) 第 6.6 节与 `docs/M1/` 下的 M1 规范。
> 本文件不是规范；随本分支进入 `feature/M1/main`，由项目主管人后续归档整理。与 `docs/M1/` 冲突时以规范为准。
> 本文件记录阶段五（5.1–5.6）的实际实现、验证证据、边界与遗留事项。

## 1. 阶段定位与验收结论

阶段五（ModuleHost、Fabric、Persistence、ArtifactStore 的完善与真实联调）的目标是：

1. 使四类基础设施的行为符合 [ModuleHost](M1/Infrastructure/ModuleHost.md)、
   [Fabric](M1/Infrastructure/Fabric.md)、[Persistence](M1/Infrastructure/Persistence.md) 与
   [ArtifactStore](M1/Infrastructure/ArtifactStore.md)；
2. 在真实 Kernel core、Gateway、Supervisor 组合下完成正常与故障联调；
3. 关闭前四个 Stage 留下的跨基础设施预留；
4. 为阶段六的真实启动、panic、退出码与进程级验收提供稳定基础。

阶段五（5.1–5.6）通过验收，四类基础设施、正常路径与故障矩阵均已覆盖。
本阶段不包含真实 Workflow、UserInteraction、ExecutorSet、真实模型 E2E、完整 panic、
启动总期限与进程级退出码；这些属于外部分支或阶段六。

阶段五不重新设计 Kernel 业务逻辑，也不扩展到数据库、持久化 Outbox、崩溃恢复、
跨进程 IPC 或生产级隔离。

## 2. 已确认决策

以下决策已由负责人确认，作为阶段五实施基线：

| 编号 | 决策 |
| --- | --- |
| D1 | M1 产品路径只支持单次启动。ModuleHost 规范允许的干净回滚后再次 `start` 仅作为机制属性保留，产品入口不自动重试引导；Fabric 不新增公共注销或重启 API。 |
| D2 | `<dataDir>/tmp/` 的清理由 Supervisor 唯一负责。Persistence 删除未使用的 `clearTemporaryFiles` 产品入口，只保证自身可用目录；测试使用本地清理。 |
| D3 | ModuleHost 增加 `startTimeoutMs`，建议默认 10000 毫秒，覆盖模块 `start` 与对应 `afterStart` 的合计时间。`bootMs` 总期限仍留阶段六。 |
| D4 | 失败分类按规范确认：Fabric 停止期间的 `NOT_RUNNING` 不等同于契约缺陷；终端事件失败只记录，非终端失败进入 `KERNEL_FAULT`；Persistence 审计失败不使收敛无限等待；Artifact 发布失败形成受控 Unit 失败，不伪造成功。 |
| D5 | 阶段五真实联调使用真实 Fabric、ArtifactStore、Persistence、ModuleHost 与真实 Kernel core、Gateway、Supervisor；Workflow、UserInteraction、ExecutorSet 继续使用 fake，并作为外部依赖登记。 |

### 2.1 交付提交

- 5.1–5.2：`2e6eb15`（ModuleHost 启动期限与 Fabric 停止语义）；
- 5.3–5.4：`7c32942`（Persistence 临时目录职责与 ArtifactStore 完整性）；
- 5.5–5.6 与本报告：`4caa373`（四类基础设施故障联调与阶段验收）。

阶段四报告中的提交哈希由前置提交 `586ea74` 补记，不属于阶段五实现提交。

### 2.2 交付范围与代码结构

阶段五实现与验证集中在：

```text
packages/infrastructure/module-host/src/index.ts
packages/infrastructure/module-host/src/module-host.test.ts
packages/infrastructure/fabric/src/in-process/in-process-fabric.ts
packages/infrastructure/fabric/src/ordered-sender/ordered-sender.ts
packages/infrastructure/fabric/src/fabric.test.ts
packages/infrastructure/persistence/src/index.ts
packages/infrastructure/persistence/src/persistence.test.ts
packages/infrastructure/artifacts/src/artifacts.test.ts
packages/modules/kernel/src/run-actor/egress.test.ts
apps/control-plane/src/bootstrap/compose-system.ts
apps/control-plane/src/bootstrap/compose-system.test.ts
```

文档变更：`docs/M1-kernel-infra-plan.md`、`docs/M1/Infrastructure/Fabric.md`、
`docs/M1/Infrastructure/Persistence.md` 与本报告。

未修改：`packages/libraries/contracts`、`packages/testing`、根构建、检查与锁文件。

## 3. 规划时现状与已关闭差距

下表记录制定阶段五规划时的差距；5.1–5.5 已全部关闭，5.6 已完成验收。

| 单元 | 已有能力 | 阶段五主要缺口 |
| --- | --- | --- |
| ModuleHost | 依赖排序、启动失败回滚、逆序停止、生命周期账本、`stopTimeoutMs` | 缺少 `startTimeoutMs`；`afterStart` 无期限；启动中收到停止会无限等待当前启动；迟到完成可能仍进入 READY/afterStart；缺少启动代次保护 |
| Fabric | 同进程路由、Schema 校验、producer 固定、`structuredClone`、Inbox、OrderedSender、Gateway 畸形正文处理 | `stop()` 不等待在途投递；`OrderedSender` 注释仍把发送失败统称为契约缺陷；停止期间的 `NOT_RUNNING` 分类未系统验证；不实现公共注销 API |
| Persistence | 文件存储、原子 rename、命名空间隔离、审计追加排队、停止排空、符号链接检查 | `clearTemporaryFiles` 没有产品调用方；Supervisor 又自行清理 tmp；临时目录职责重复；真实审计与写入失败联调不足 |
| ArtifactStore | 内容寻址、写入复验、读取复验、同内容复用、损坏拒绝、停止排空 | Execution 的上下文、报告、RunSummary、缺失/损坏/发布失败的真实链路覆盖不足 |

当前 `apps/control-plane` 的组合根已经使用真实 Fabric、ArtifactStore、Persistence 与 ModuleHost；
阶段五在其上扩展故障测试，不重写组合根。

5.1–5.6 完成后，四类基础设施的代码、正常路径集成、故障矩阵与阶段文档均已覆盖；
阶段五已关闭，后续工作属于阶段六或外部分支。

## 4. 子阶段规划

### 5.1 ModuleHost 启动与停止保护

**状态：已完成（2026-10-21）。** 实现与验证记录见本节末尾。

**目标**：满足 [ModuleHost](M1/Infrastructure/ModuleHost.md) 第 3、4 节与
[M1Interface](M1/M1Interface.md) 14.5 的启动期限要求。

**工作项**

- 增加 `ModuleHostOptions.startTimeoutMs`，默认 10000 毫秒。
- 校验 `startTimeoutMs`、`stopTimeoutMs` 为正安全整数。
- `startTimeoutMs` 覆盖单个模块的 `start()` 与 `afterStart` 合计时间。
- 增加 `START_TIMEOUT` 生命周期错误。
- 为每次启动建立代次或等效保护：
  - 已超时、已停止或已回滚的启动完成不得把模块改回 READY；
  - 迟到完成不得执行 `afterStart`；
  - 迟到拒绝不得成为未处理 Promise 拒绝。
- 停止发生在启动过程中时：
  - 封锁后续模块启动；
  - 最多等待当前启动剩余期限；
  - 随后有期限地回滚；
  - 不无限等待原始启动 Promise。
- 保持并补测：
  - 启动失败回滚；
  - 失败模块本身也被停止；
  - 并发与重复停止共用一次停止；
  - 单模块停止失败不跳过其他模块；
  - 生命周期账本状态与错误保留；
  - 干净回滚后机制层面的再次 `start` 只作为机制属性验证，产品路径仍只启动一次。
- `composeSystem` 传递 `startTimeoutMs`；`bootMs` 仍留阶段六。

**测试重点**

- `start()` 永不完成；
- `afterStart` 永不完成；
- 启动超时后迟到成功与迟到失败；
- 停止发生在启动中；
- 停止超时；
- 回滚后账本为 STOPPED；
- `START_FAILED`、`STOP_FAILED` 与错误保留。

**退出条件**

- 启动与停止都有界；
- 停止后不会重新 READY；
- 无未处理拒绝；
- ModuleHost 单元测试覆盖上述矩阵。

**完成记录（2026-10-21）**

- `ModuleHostOptions.startTimeoutMs` 已加入，默认 10000 毫秒，并校验 `startTimeoutMs` 与
  `stopTimeoutMs` 为正安全整数。
- 单个模块的 `start()` 与 `afterStart` 共用同一期限；超时记为 `START_FAILED` 并回滚。
- 每次启动使用代次标识，迟到完成不能重新进入 READY 或执行 `afterStart`。
- 停止发生在启动过程中时，等待当前启动期限后回滚；迟到完成不会改变终态。
- `MODULE_START_TIMEOUT_MS = 10000` 已接入 `apps/control-plane` 的组合根。
- 新增测试覆盖：启动超时、`afterStart` 超时、迟到成功与迟到失败、停止中启动、停止有界与期限校验。
- 验证：`pnpm run check` 通过（55 个测试文件、567 项测试）；
  `pnpm run test:coverage` 全仓语句 93.18%、分支 84.07%、行 94.96%。

**依赖**：无，建议最先执行；5.5 的启动与停止故障场景依赖本阶段。

### 5.2 Fabric 生命周期与失败分类

**状态：已完成（2026-10-21）。** 实现与验证记录见本节末尾。

**目标**：补齐 Fabric 在停止与失败分类上的行为，并修正文档与注释。

**工作项**

- 明确 `InProcessFabric.stop()` 语义：
  - 停止后新的 `request`/`send` 返回 `NOT_RUNNING`；
  - 已受理的在途投递允许完成；
  - `stop()` 幂等。
- 验证并补测同一地址的并发投递：
  - 按登记顺序串行；
  - 前一个订阅者失败不阻断后续消息；
  - 不同地址可并行。
- 修正 `OrderedSender` 注释与 Fabric 文档：
  - 发送失败不一律是契约缺陷；
  - 停止期间可能是 `NOT_RUNNING`；
  - 终端事件失败与非终端失败按 `RunEgress` 的规则区分。
- 按 D1 不新增公共 `FabricPort` 注销 API：
  - M1 只保证单次启动；
  - 停止后不再路由；
  - 不实现产品级 Fabric 重启或重新注册流程。
- 验证 Gateway 无效正文处理、未知 Schema、无处理器、无订阅者、请求处理器抛错与
  producer 不符。
- 保留 `structuredClone`、Schema 校验与 `BoundaryContext` 校验边界。

**测试重点**

- 停止前已开始的投递完成；
- 停止后请求/发送返回 `NOT_RUNNING`；
- 同一地址失败后继续；
- 请求/响应不可共享引用；
- 终端与非终端发送失败的分类；
- 重复注册、无处理器、无订阅者；
- 无效正文与非法 `requestId` 的区别。

**退出条件**

- Fabric 第 3、4 节行为可验证；
- 发送失败分类不再被笼统描述为契约缺陷；
- 关闭时 Fabric 最后停止且无未处理拒绝。

**完成记录（2026-10-21）**

- `InProcessFabric.stop()` 停止接收新请求与发送，并等待已受理的 `send` 完成；
  停止后的请求与发送返回 `NOT_RUNNING`，重复停止幂等。
- 补测同一地址串行投递、订阅者失败后继续、不同地址并行、停止后拒绝新工作。
- 补测缺失订阅者、请求处理器失败、无效正文、未知 Schema 与 producer 不符。
- `OrderedSender` 注释与 [Fabric](M1/Infrastructure/Fabric.md) 第 3 节已修正：
  发送失败不一律是契约缺陷，停止期间可能是 `NOT_RUNNING`。
- `RunEgress` 补测终端事件失败标记：`RunClosed`/`RunFinished` 失败的 `terminal = true`，
  其他发送失败为非终端。
- 未新增公共 `FabricPort` 注销 API，M1 保持单次启动语义。
- 验证：`pnpm run check` 通过（55 个测试文件、571 项测试）；
  `pnpm run test:coverage` 全仓语句 93.24%、分支 84.14%、行 94.96%。

**依赖**：可与 5.1、5.3、5.4 并行。

### 5.3 Persistence 临时目录职责与写入排空

**状态：已完成（2026-10-21）。** 实现与验证记录见本节末尾。

**目标**：按 D2 统一 `<dataDir>/tmp/` 清理责任，补齐真实审计与写入失败联调。

**工作项**

- 临时目录清理统一给 Supervisor：
  - Supervisor 启动时清理并建立 `<dataDir>/tmp/`；
  - Persistence 删除未使用的 `clearTemporaryFiles` 产品入口；
  - 更新过时注释与测试，测试使用本地清理。
- 确认 `FilePersistence.start()` 只保证自身可用目录，不重复清理 tmp。
- 验证：
  - repository 原子 rename；
  - audit 追加跨 Port 实例排队；
  - 一次写入失败不阻断后续追加；
  - `stop()` 等待已受理写入并拒绝新写入；
  - 命名空间隔离；
  - 运行 ID、路径与符号链接检查；
  - `<dataDir>/runs` 在重启后保留。
- 真实联调：
  - Core 审计写入 `kernel-core/audit.jsonl`；
  - Workflow 运行记录写入 `workflow/`；
  - 审计写入失败在请求路径与收敛路径的处理不同，分别验证。
- 检查仓库与 `dataDir` 边界不因基础设施实现变化而失效。

**测试重点**

- 并发写入与审计顺序；
- 停止期间排空；
- 写入失败后恢复；
- 符号链接与非法 ID；
- tmp 清理唯一责任；
- 真实 Core 审计记录。

**退出条件**

- tmp 清理只有 Supervisor 一处产品责任；
- Persistence 写入、追加、停止与失败路径均有测试；
- 无重复的 `clearTemporaryFiles` 产品入口。

**完成记录（2026-10-21）**

- 删除 Persistence 的 `clearTemporaryFiles` 产品入口；`FilePersistence.start()` 只确保
  `<dataDir>/tmp/` 可用，不删除已有内容。
- Supervisor 继续唯一负责启动时清理并建立 `<dataDir>/tmp/`。
- 补测：
  - `start()` 不清理 tmp；
  - repository 写入失败；
  - audit 失败后继续追加；
  - 停止时排空已受理审计写入并拒绝新写入；
  - 命名空间隔离、非法运行 ID 与符号链接路径。
- 真实联调：真实 Kernel core + Gateway + Supervisor + fake 外部模块下验证
  `kernel-core/audit.jsonl` 的 `RUN_STARTED`、`UNIT_ACCEPTED`、`UNIT_REPORTED`、`RUN_CLOSED`。
- Workflow 运行记录仍依赖外部分支的真实 Workflow；当前以 fake Workflow 替代，
  不宣称该部分已完成。
- 验证：`pnpm run check` 通过（55 个测试文件、572 项测试）；
  `pnpm run test:coverage` 全仓语句 93.25%、分支 84.16%、行 94.95%。

**依赖**：5.1 的生命周期测试可复用；与 5.2、5.4 可并行。

### 5.4 ArtifactStore 完整性与 Execution 集成

**状态：已完成（2026-10-21）。** 实现与验证记录见本节末尾。

**目标**：补齐 ArtifactStore 在真实执行链中的发布、读取、完整性与失败路径。

**工作项**

- 保留并核对已有能力：
  - 内容寻址与 `artifactId = art_ + sha256`；
  - 写入临时文件后复验 SHA-256 与 size；
  - 同内容复用；
  - 已有内容损坏时拒绝覆盖；
  - `get` 复验；
  - 停止拒绝新写入并排空。
- 真实联调：
  - `context-assemble` 的 ContextPack；
  - `report-publish` 的 AnalysisReport；
  - RunSummary；
  - Execution 的归属索引与 `readArtifact`；
  - 运行关闭后读取报告与摘要。
- 故障路径：
  - `put` 失败（tmp 不可用、写入失败）；
  - `get` 缺失；
  - 内容损坏；
  - 引用不属于本运行；
  - 发布失败时 Core 的 `UnitReport` 与 RunClosed 行为。
- 确认 ArtifactStore 不判断业务访问权限，权限检查仍由 Execution 完成。

**测试重点**

- 发布、读取、损坏、缺失；
- 多生产者同内容；
- 停止排空；
- 路径与符号链接；
- 真实 Kernel 的 ContextPack、报告、RunSummary；
- `readArtifact` 在 CLOSED 后仍可用。

**退出条件**

- ArtifactStore 第 2–4 节行为完整；
- Execution 的产物发布与读取路径有真实集成证据；
- 发布失败不会伪装成完整交付。

**完成记录（2026-10-21）**

- 补测 `get` 缺失产物返回 `ArtifactIntegrityError`。
- 真实组合链验证：
  - 三个 ContextPack（ORIENT、SEARCH、ASSEMBLE）均可读取并通过 Schema；
  - `reportRef` 的 mediaType 为 AnalysisReport；
  - `runSummaryRef` 的 mediaType 为 RunSummary；
  - 报告与 RunSummary 正文可读取并通过 Schema；
  - 7 个产物文件与 Execution 归属、报告读取路径一致。
- 发布失败路径由已有覆盖保持：
  - `LocalArtifactStore` 的 tmp 不可用与写入失败；
  - Execution 的产物写入失败转为 `FAILED(INTERNAL)`；
  - RunSummary 发布失败使用 `finalizationError`，不伪造引用。
- 归属检查继续由 Execution 完成，ArtifactStore 不判断业务访问权限。
- 验证：`pnpm run check` 通过（55 个测试文件、573 项测试）；
  `pnpm run test:coverage` 全仓语句 93.25%、分支 84.16%、行 94.95%。

**依赖**：可与 5.1–5.3 并行；5.5 依赖本阶段。

### 5.5 四类基础设施真实联调与故障矩阵

**状态：已完成（2026-10-22）。** 实现与验证记录见本节末尾。

**目标**：在真实四类基础设施与真实 Kernel core、Gateway、Supervisor 下验证正常和故障路径。

**组合方式**

```text
真实 Fabric
真实 LocalArtifactStore
真实 FilePersistence
真实 ModuleHost
真实 Kernel core
真实 Gateway
真实 Supervisor
fake Workflow / UserInteraction / ExecutorSet
```

真实 Workflow、UserInteraction、ExecutorSet 仍是外部分支占位；阶段五继续用 fake 替代，
并在报告中登记外部依赖。

**场景**

1. **正常启动与关闭**
   - 启动顺序：fabric → artifact-store → persistence → kernel-core → gateway → workflow →
     user-interaction；
   - 全部 READY 后才接受业务；
   - 运行结束、Outbox 排空、`SupervisorPort.shutdown`、逆序停止；
   - 运行目录、审计、产物保留。

2. **启动失败与回滚**
   - 某个模块启动失败；
   - 已启动模块逆序停止；
   - 失败模块本身也被停止；
   - Gateway 不开放；
   - 启动超时与迟到完成。

3. **停止失败**
   - 单模块停止失败不阻断其他模块；
   - `STOP_FAILED` 进入账本；
   - 不重试失败停止；
   - 组合根仍能获得停止报告。

4. **Fabric 停止与发送失败**
   - 停止后请求/发送得到 `NOT_RUNNING`；
   - 非终端发送失败进入 `KERNEL_FAULT`；
   - 终端事件失败只记录，不递归触发故障；
   - 关闭时排空。

5. **Persistence 写入失败**
   - 审计写入失败不使收敛无限等待；
   - repository 写入失败不产生可用运行记录；
   - 后续写入仍可继续；
   - 停止时已受理写入排空。

6. **ArtifactStore 发布与读取失败**
   - 发布失败导致受控 Unit 失败；
   - 缺失或损坏引用返回完整性错误；
   - 报告或 RunSummary 失败不伪造引用；
   - 关闭后读取仍受归属检查。

7. **边界与安全**
   - 仓库与 `dataDir` 不互相包含；
   - 运行 ID、路径与符号链接检查；
   - 不产生未授权文件写入；
   - 不越过 Execution 直接访问 ArtifactStore。

**测试位置**

- `packages/infrastructure/*/src/*.test.ts`：单元与故障注入；
- `apps/control-plane/src/bootstrap/stage5-infrastructure.test.ts` 或扩展
  `compose-system.test.ts`：真实组合链路；
- 不修改 `packages/testing`；需要 fixture 时放在测试本地或基础设施包内。

**退出条件**

- 正常与故障联调均有证据；
- 前四个 Stage 的跨基础设施预留关闭；
- 未完成的外部模块依赖单独列出；
- 没有把 fake 通过当作整机验收。

**完成记录（2026-10-22）**

- 正常组合链继续由 `compose-system.test.ts` 覆盖：
  - 真实 Fabric、ArtifactStore、Persistence、ModuleHost、Kernel core、Gateway 与 Supervisor；
  - fake Workflow、UserInteraction、ExecutorSet；
  - createRun → 授权 → 六类 Unit → 报告 → RunSummary → RunFinished；
  - 运行目录、审计、ContextPack、报告与 RunSummary 保留。
- 新增组合根故障场景：
  - 外部模块启动失败：真实基础设施按逆序回滚，`system.start()` 拒绝，
    `whenStopped()` 完成，`<dataDir>/tmp` 被 Supervisor 清理；
  - 外部模块停止失败：ModuleHost 记录 `STOP_FAILED`，继续停止其余模块，
    组合根仍返回 `StopReport`。
- 组件级故障证据沿用前序子阶段：
  - ModuleHost 启动/停止超时、迟到完成与停止中启动（5.1）；
  - Fabric 停止排空、`NOT_RUNNING`、订阅者与处理器失败（5.2）；
  - Persistence 写入失败、审计恢复、停止排空（5.3）；
  - ArtifactStore 缺失/损坏、发布失败与 Execution 归属（5.4）。
- 未把 fake Workflow、UserInteraction、ExecutorSet 通过视为整机验收；
  真实 Workflow 运行记录、真实 ExecutorSet 与真实模型 E2E 仍为外部依赖。
- 验证：`pnpm run check` 通过（55 个测试文件、575 项测试）；
  `pnpm run test:coverage` 全仓语句 93.43%、分支 84.38%、行 95.13%。

**依赖**：5.1–5.4 全部完成。

### 5.6 文档、覆盖率与阶段验收

**状态：已完成（2026-10-22）。**

**工作项**

- 将本文件补充为阶段五实现报告，记录：
  - 5.1–5.5 实现内容；
  - 测试矩阵；
  - 故障注入证据；
  - 未完成的外部依赖；
  - 已知实现边界。
- 更新 [M1-kernel-infra-plan](M1-kernel-infra-plan.md)：
  - 阶段五标记完成；
  - 基线、实现状态、偏差、预留表、C07 进度与进度记录同步。
- 更新基础设施文档中需要明确的行为：
  - ModuleHost `startTimeoutMs`；
  - Fabric 停止与发送失败分类；
  - Persistence tmp 清理责任；
  - ArtifactStore 失败路径。
- 运行：
  - `pnpm install --frozen-lockfile`
  - `pnpm run build`
  - `pnpm run check`
  - `pnpm run test:coverage`
  - `pnpm run demo:fake`
  - `git diff --check`
- 最终在 Ubuntu LTS 上复核。
- 不修改 `contracts`、`testing` 或根构建配置；如确需接缝变更，单独评审。

**退出条件**

- 阶段五报告与计划状态一致；
- 全仓质量门与覆盖率通过；
- 阶段六可以直接开始真实启动、panic、退出码与进程级验收。

**完成记录（2026-10-22）**

- 本文件已整理为阶段五实现报告，记录 5.1–5.5 的实现、测试矩阵、故障矩阵、边界与外部依赖。
- [M1-kernel-infra-plan](M1-kernel-infra-plan.md) 已同步：
  - 阶段五标记完成；
  - 基线更新至 575 项测试与最终覆盖率；
  - 实现状态、偏差、预留表、C07 与进度记录更新。
- 已确认 [ModuleHost](M1/Infrastructure/ModuleHost.md) 与实现一致；更新
  [Fabric](M1/Infrastructure/Fabric.md) 与 [Persistence](M1/Infrastructure/Persistence.md)
  中需要明确的实现行为；[ArtifactStore](M1/Infrastructure/ArtifactStore.md) 已覆盖失败路径，无需变更。
- 验证：
  - `pnpm install --frozen-lockfile`：已是最新；
  - `pnpm run build`、`pnpm run check` 通过；
  - 55 个测试文件、575 项测试通过；
  - 全仓语句 93.43%、分支 84.38%、函数 89.20%、行 95.13%；
  - `pnpm run demo:fake` 退出码 0；
  - `git diff --check` 通过。
- Stage5 工作闭合；阶段六仍需真实组合根启动、panic 五步、退出码与进程级验收。
- 真实 Workflow、UserInteraction、ExecutorSet 与真实模型 E2E 仍为外部依赖，不因 Stage5 关闭而视为完成。

## 5. 执行顺序

```text
5.1 ModuleHost
5.2 Fabric        ┐
5.3 Persistence   ├─ 可与 5.1 并行
5.4 ArtifactStore ┘
        ↓
5.5 四类基础设施真实联调与故障矩阵
        ↓
5.6 阶段五报告、文档与质量门
```

建议先完成 5.1，因为 5.5 的启动与停止故障场景依赖 ModuleHost 的期限与迟到完成语义。
5.2–5.4 相互独立，可以并行。

## 6. 边界与非目标

阶段五不包含：

- `bootMs` 总期限与完整 panic 五步；
- 进程退出码、Ctrl+C、`uncaughtException` 的进程级验收；
- 真实 Workflow、UserInteraction、ExecutorSet；
- 真实模型 E2E、F1–F5 与 M1 整机验收；
- 数据库、持久化 Outbox/Inbox、事务、恢复、跨进程 IPC、分片或生产级隔离；
- Fabric 公共注销 API、产品级重启或重新注册流程。

## 7. 风险与关注点

| 风险 | 关注点 |
| --- | --- |
| ModuleHost 启动超时 | 必须忽略迟到完成，避免 READY 或 `afterStart` 在停止后执行 |
| 停止期间的在途投递 | 终端事件失败只记录，不得形成故障循环 |
| Persistence 写入失败 | 区分请求路径与收敛路径，收敛不得无限等待 |
| Artifact 发布失败 | 必须形成受控失败，不伪造 `reportRef` 或 `runSummaryRef` |
| 真实联调的 fake 外部模块 | fake 只证明 Kernel 与基础设施接线，不代表整机验收 |
| 单次启动决策 | 不为产品路径实现 Fabric 重启或模块重新注册 |

## 8. 完成定义

阶段五完成必须同时满足：

- 5.1–5.5 的实现与测试证据完整；
- 四类基础设施的正常路径与故障路径均有测试；
- 真实 Kernel core、Gateway、Supervisor 与四类基础设施组合链路通过；
- 启动、停止、发送、写入、发布失败均进入规范规定的处理路径；
- 前四个 Stage 的跨基础设施预留关闭；
- 外部 Workflow、UserInteraction、ExecutorSet 依赖明确登记；
- `pnpm run check`、`pnpm run test:coverage`、`pnpm run demo:fake` 与
  `git diff --check` 通过；
- 阶段五报告与计划状态同步；
- 阶段六可以直接开始真实启动与 panic 验收。

上述条件已在 2026-10-22 的阶段五验收中核对满足。

## 9. 阶段验收结论

| 条件 | 结果 |
| --- | --- |
| 5.1–5.5 实现与测试证据完整 | 满足 |
| 四类基础设施正常与故障路径均有测试 | 满足 |
| 真实 Kernel core、Gateway、Supervisor 与四类基础设施组合链路 | 满足 |
| 启动、停止、发送、写入、发布失败进入规范处理路径 | 满足 |
| 前四个 Stage 的跨基础设施预留关闭 | 满足 |
| 外部 Workflow、UserInteraction、ExecutorSet 依赖登记 | 满足 |
| 质量门与覆盖率通过 | 满足 |
| 阶段五报告与计划状态同步 | 满足 |
| 阶段六可开始真实启动与 panic 验收 | 满足 |

阶段五工作已闭合，不表示 M1 整机完成。真实 Workflow、UserInteraction、ExecutorSet、
真实模型 E2E 与 F1–F5 仍为外部阻塞；M1 验收以
[M1Plan](M1/M1Plan.md) 第 7 节和第 8 节为准。
