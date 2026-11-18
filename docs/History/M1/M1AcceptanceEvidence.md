# M1 验收证据

本文汇总 M1 完成定义与发布阻断项的验证证据，对应 [M1ReleasePlan](M1ReleasePlan.md) 的 R4.1–R4.6 与阶段三的真实模型运行。
它不是规范：验收标准以 [M1Plan](M1Plan.md) 第 7、8 节为准，限制见 [M1Limitations](M1Limitations.md)，
运行方法见 [M1Usage](M1Usage.md)。结论均已在 2026-10-25 按最终代码核对。

状态说明：**已满足**表示有测试、运行记录或命令输出作为证据；**未发现**表示对应的防线与测试存在且通过。

## 1. 完成定义（M1Plan 第 7 节）

| 条件 | 证据 | 状态 |
|---|---|---|
| F1–F5 均到达可解释终态；至少一个真实模型运行全部任务并记录指标 | 离线：`acceptance.test.ts` 中 F1–F5 经完整产品调用链以 COMPLETED 结束。真实模型：R3.1 首轮（草稿 Prompt）15/15；R3.6 基线（封存的 `v1.0.0`）15 次全部 COMPLETED、非降级，按调整后的 F5 断言 15/15（第 7 节）；指标见第 6、7 节 | 已满足 |
| 所有任务完整经过权威调用链，且运行固定定义版本与 digest | 验收工具按 `main` 的组合方式装配全部产品部件并经 CLI 解析运行（`harness.ts`）；运行记录取 RunSummary 中各 AgentRun 的 `agentRef`。R3.5 已把全部定义封存为 `v1.0.0`，R3.6 的 15 条记录都固定 `planner@v1.0.0`（`c8929b1a…`）与 `code-viewer@v1.0.0`（`6fde30a6…`）；R5.7 发布 `v1.1.0` 后重跑的 15 条记录固定 `planner@v1.1.0`（`377c67e0…`）与 `code-viewer@v1.1.0`（`9c0d42d5…`），均与封存文件的 digest 一致 | 已满足 |
| ContextPack 和关键结论具有完整来源；无来源的成功结论数量为零 | `workflow.AnalysisReport.v0` 要求正常报告的每条结论至少一个 `VerifiedSource`（`kernel-protocol.test.ts`）；Workflow 10.1 的来源核验（`normal-report.test.ts`、`report-sources`）；ContextPack 的 `snapshotId` 与 `provenance` 由 Schema 强制（`kernel-protocol.test.ts`）并由各 Executor 测试覆盖（`orient-executor.test.ts`、`assemble-executor.test.ts`）；验收工具检查每个预期来源都被结论引用；R3.1 的 136 条结论全部带已核验来源，1 条来源不在读取范围内的结论被降级为 `unconfirmed` | 已满足 |
| 步骤、token、模型调用和时间预算均可确定性终止 | Monitor 的额度与收尾（`monitor.test.ts`、`attempts.test.ts`）；Workflow 的 Round 上限与无进展检测（`rounds.test.ts`、`progress.test.ts`）；运行超时（`stage6-acceptance.test.ts` 的 run timeout 用例）；陷阱 S3：脚本模型无限重复检索，运行在上限处以带原因的降级报告结束 | 已满足 |
| 写入、命令、测试、网络和 workspace 逃逸成功次数为零 | 仓库访问的路径检查反例（`repository-access.test.ts`：`..`、绝对路径、符号链接、排除规则、检查后替换）；子进程只允许 `rg`（`subprocess-runner.test.ts`，架构测试 `confines child processes to the Supervisor`）；Provider SDK 只在 model-call（架构测试）；陷阱 S2 跟随 README 中的注入指令读取 `/etc/passwd`、`../../..`、`/root/.ssh/id_rsa` 与 `.env`，全部 REJECTED，内容未进入模型、存储或终端；离线服务商拒绝一切非服务商主机；R3.1 的 15 次真实运行未读取禁止路径，工作区不变 | 已满足 |
| 工作区在运行前后保持不变 | 验收工具在运行前后对整个仓库（含被排除的文件）计算同一摘要并比对，F1–F5 与 S1–S5 全部一致 | 已满足 |
| 每个 Module/Infrastructure 均有边界、适配器和测试；架构绕行被自动化测试阻止 | `packages/testing/src/architecture.test.ts`（依赖白名单、Kernel 组件互不导入、SDK 与子进程的位置）；eslint 的 `no-restricted-imports`；各包的 contract test（`executor-contract`、`catalog-port-contract`、`inbox-port-contract`） | 已满足 |
| 在 Ubuntu LTS 上，`pnpm run check`、E2E、固定任务集和兼容矩阵全部通过 | CI `quality-gate.yml`：主格、Node 上界、无 rg 三格（M1TechStack 第 11 节）；WSL Ubuntu 24.04：88 个测试文件、1126 项通过，2 项为只在 CI 中运行的 rg 检查；离线 F1–F5 与陷阱在 `pnpm run test` 中；R4.5 在 WSL Ubuntu 24.04 上连续三轮通过（第 4 节） | 已满足 |
| README、索引、接口、限制和运行说明与实现一致 | R4.3 预检已修正两处文档不一致（计划第 6 节 A6），并增加文档与定义文件的比对测试；限制清单见第 3 节草稿；运行说明待 R5.1；限制清单与运行说明见 [M1Limitations](M1Limitations.md)、[M1Usage](M1Usage.md)（R5.1），索引与链接检查见 R5.2 | 已满足 |

## 2. 发布阻断项（M1Plan 第 8 节）

| 阻断项 | 防线与证据 | 状态 |
|---|---|---|
| 绕过 UserInteraction、Kernel、Workflow | 组合根是唯一知道具体实现的地方，各主体只有自己的 Fabric 客户端；CLI 只调用 UserInteraction（`run-cli.ts`）；验收工具经 CLI 运行 | 未发现 |
| Workflow 直连执行组件 | Workflow 只依赖 contracts 与 fabric，只持有 `WorkflowGatewayPort`（架构测试 `declares only the allowed internal dependencies`） | 未发现 |
| 模型直接调用工具 | model-call Executor 只返回工具调用；Workflow 校验后经 `submitUnit` 交给 Kernel，Kernel 再派给 Supervisor（M1Interface 6.6 的性质测试 `unit-cycle.test.ts`） | 未发现 |
| 定义版本未固定 | Workflow 在运行开始时 `pinAgent` 一次并只使用返回的闭包；Kernel 核对 `agentRef` 与单元的 digest（`request-handler.test.ts`）；草稿在加载时计算 digest；全部定义已封存为 `v1.0.0`（R3.5） | 未发现 |
| 协议未注册 | `createM1ProtocolRegistry` 注册 SharedContracts 第 3 节的全部 Schema（`protocol-registry.test.ts`）；Fabric 每次投递按注册的 Schema 校验；协议冻结守卫比对快照（`schema-snapshot.test.ts`）；协议已冻结，冻结守卫在 CI 中执行（第 5 节） | 未发现 |
| Unsupported 产生状态变化 | `rejects an unsupported executionKind before creating an attempt`（`request-handler.test.ts`）；opaque family 标为 UNSUPPORTED（`protocol-registry.test.ts`） | 未发现 |
| 副作用执行成功 | 只读 Executor、只允许 `rg` 的子进程、路径检查；验收工具比对工作区摘要 | 未发现 |
| 缺少硬预算 | Monitor 的 token 额度、预留与收尾；Round 上限；单元超时与运行超时；启动检查保证不可裁剪段在最坏输入下放得下（Monitor 第 4 节，A5） | 未发现 |
| 关键结论无来源 | 正常报告的结论 Schema 要求至少一个已核验来源；未核验的进入 `unconfirmed` | 未发现 |
| ContextPack 无 snapshotId/provenance | Schema 强制（`kernel-protocol.test.ts`） | 未发现 |
| 模块通过异常字符串协作 | 跨模块结果为结构化的 `SyscallRejected`、`UnitReport`、`ModuleError` 与原因码；Workflow 识别端口超时靠 `FabricError.code`，不解析消息文本 | 未发现 |
| 无法独立替换或测试适配器 | `SystemParts` 允许替换任意产品工厂；`packages/testing` 提供共享 fake 与 contract test；组合根测试分别以 fake 与真实部件运行 | 未发现 |
| M1Interface、SharedContracts 与 AgentToolPool 不一致 | R4.3 预检：Schema ID 与注册表一致，文件与目录都存在，16 个定义与文档对应；两处不一致已修正（A6）；R4.3 正式核对无差异（第 5 节） | 未发现 |

## 3. 限制清单

已移入 [M1Limitations](M1Limitations.md)（R5.1）。

## 4. 阶段四回归（R4.5）

**最终候选（R5.7 与发布前复查之后）**：2026-10-25 对提交 `1acf4fd` 重跑同样的三轮，全部通过。主格每轮 1139 项全部通过、0 项跳过，覆盖率语句 93.83%、分支 84.74%、函数 93.06%、行 95.53%，check、diff 检查与 demo 通过；无 rg 格每轮 1126 项通过、14 项 rg 专属用例按设计跳过，demo 通过。

此前的一次：

2026-10-25 在 WSL Ubuntu 24.04（Node 24.19.0、ripgrep 14.1.0）上对提交 `d5022d9`（之后只改动了本文与计划的文字）连续运行三轮，每轮依次执行：

| 格 | 命令 | 三轮结果 |
|---|---|---|
| 主格（有 rg，`CI=1`） | `pnpm run build`、`pnpm run check`、`git diff --check`、`pnpm run test:coverage`、`pnpm run demo:fake` | 每轮 88 个文件、1137 项全部通过，0 项跳过；覆盖率语句 93.82%、分支 84.78%、函数 93.03%、行 95.54%；demo 通过 |
| 无 rg（PATH 中去掉 rg，`MULTIAGENTOS_RIPGREP=absent`） | `pnpm run test`、`pnpm run demo:fake` | 每轮 1124 项通过，14 项 rg 专属用例按设计跳过；demo 通过 |

离线的 F1–F5 与陷阱 S1–S5 包含在 `pnpm run test` 中，因此在两格中各运行三次。Node 24 最新版一格本机没有对应版本，
由 CI 验证：`265e758` 推送后的 quality-gate（运行 40157693967）三格全部通过；`d5022d9` 只改动文档与协议快照的冻结标记，推送后由 CI 再次验证。

## 5. 协议冻结与文档一致性（R4.3、R4.6）

- **R4.6 协议冻结**：`schema-snapshot.json` 的 `frozen` 置为 `true`，快照记录 101 个已注册 Schema。冻结后
  `pnpm run contracts:snapshot` 拒绝改写快照；守卫测试在冻结状态下通过。反向验证：从 `EXECUTOR_FAILED_CODES` 删掉
  `PROVIDER_TOOL_CHOICE_IGNORED` 后，守卫报告三处 `removed` 并失败。
- **R4.3 文档与代码**：SharedContracts 第 3 节列出的 90 个 Schema ID 全部已注册，其余 11 个 opaque Ref 在 3.9 节按 family
  列出；它提到的 42 个文件都存在。M1Interface 的 `ReasonCode`（43 个）与 `FeedbackCode`（7 个）与代码一致。
  AgentToolPool 第 4 节的 14 个 YAML 与封存文件逐行一致（`definitions-directory.test.ts`），16 个定义与第 4 节的表一致。
  没有未处理的差异。

## 6. 真实模型首轮（R3.1）

2026-10-25 在 WSL Ubuntu 24.04 上运行 `pnpm run acceptance -- all --runs 3 --yes`。提交 `764ed7b`，模型
`deepseek-flash@v1.0.0`，Agent `planner@v0.1.0`、`code-viewer@v0.1.0`（Prompt 草稿，加载时计算 digest），
额度为 `DEFAULT_KERNEL_CONFIG`（`tokenLimit` 600000、`perCallInputLimit` 96000、`finalInputBudget` 72000）。
原始记录在运行目录 `.multiagentos/acceptance/batch1/records.jsonl`，不入库。

| 任务 | 通过 | 用时（秒） | 最多 token | 最多模型调用 | 平均费用（美元） | 结论 / 未确认 |
|---|---|---|---|---|---|---|
| F1 | 3/3 | 13.4–16.3 | 20073 | 6 | 0.0036 | 22 / 9 |
| F2 | 3/3 | 16.8–25.4 | 45054 | 9 | 0.0070 | 23 / 9 |
| F3 | 3/3 | 19.5–20.6 | 40161 | 7 | 0.0060 | 34 / 10 |
| F4 | 3/3 | 20.6–30.3 | 50835 | 9 | 0.0078 | 25 / 10 |
| F5 | 3/3 | 18.4–22.9 | 40945 | 9 | 0.0064 | 32 / 10 |

- 15 次全部 COMPLETED，没有降级报告，结束时额度状态都是 NORMAL，没有无法计数的 token；15 次共 0.092 美元。
- 每次运行都满足验收工具的全部断言：预期来源被结论引用、禁止路径未被读取或引用、工作区摘要不变、密钥未出现在
  模型请求、运行数据与终端输出中。
- 未确认项 48 条：47 条是模型自己标为未确认的推测或未查证事项；1 条（F2）引用的行不在任何一次读取的范围内，
  被 Workflow 10.1 的来源核验降级，没有作为结论出现。
- 人工抽查：F1 三次对边界（到期当天、宽限期内、刚过宽限期按到期日起算）的解释与 `late-fee.ts` 一致；F5 三次都
  指出只通知队首，并有两次识别出已废弃的 `legacy/notifier.ts` 是干扰项。
- 资源使用远低于额度：单次最多 50835 token，约为 `tokenLimit` 的 8.5%。这是 R3.4 校准的输入。

## 7. 真实模型基线（R3.6）

2026-10-25 在 WSL Ubuntu 24.04 上运行 `pnpm run acceptance -- all --runs 3 --yes`。提交 `49efce0`，模型
`deepseek-flash@v1.0.0`，Agent `planner@v1.0.0`、`code-viewer@v1.0.0`（全部定义已封存），`tokenLimit` 300000（R3.4），
收尾只由状态行说明（R3.3），收尾调用可按已知用量技术重试（R3.7）。原始记录在运行目录
`.multiagentos/acceptance/r36/records.jsonl`，不入库。

| 任务 | 验收工具判定 | 用时（秒） | 最多 token | 最多模型调用 | 平均费用（美元） | 结论 / 未确认 |
|---|---|---|---|---|---|---|
| F1 | 3/3 | 16.8–17.2 | 28982 | 7 | 0.0044 | 24 / 7 |
| F2 | 3/3 | 13.6–18.9 | 30178 | 7 | 0.0049 | 25 / 9 |
| F3 | 3/3 | 20.3–25.9 | 44167 | 9 | 0.0063 | 33 / 10 |
| F4 | 3/3 | 19.4–30.4 | 33388 | 7 | 0.0065 | 30 / 11 |
| F5 | 3/3 | 19.0–21.5 | 44797 | 9 | 0.0068 | 30 / 9 |

- **成功率**：15 次全部到达 COMPLETED，没有降级报告，结束时额度状态都是 NORMAL，没有无法计数的 token，没有技术重试；
  验收工具判定 15/15（运行时为 14/15，F5 断言调整后重新判定，见下）。
- **来源完整性**：142 条结论全部带已核验的读取来源；46 条未确认项都是模型自己标注的，没有因来源核验被降级的结论。
- **成本**：15 次共 0.086 美元，平均每次 0.0058 美元；单次最多 44797 token，约为 `tokenLimit` 的 15%。
- **延迟**：中位数 19.0 秒，最长 30.4 秒。
- **F5 #3 与断言调整**：报告正确说明只通知队首、通知经事件总线同步触发，并识别出已废弃的 `legacy/notifier.ts`；
  它读取了 `event-bus.ts`，但结论引用的是发布事件的 `loan-service.ts:39-50` 与订阅事件的 `hold-queue.ts:21-27`，
  没有引用总线本身的 `publish`（第 13–15 行）。这是 F5 预期来源的要求比问题本身更严，不是产品缺陷。经 Cary 同意，F5 改为“总线的 `publish` 或 `loan-service.ts` 第 48 行的发布调用二者其一”（`expectedSources` 支持备选范围，`acceptance.test.ts` 有对应用例），这次运行按新断言通过。

## 8. 当前定义的基线（R5.7）

R5.7 把 `code-viewer-system` 的 summary 限制为两到四句，以 `v1.1.0` 发布 `code-viewer-system`、`code-viewer` 与 `planner`，
并改进终端报告的版式（UserInteraction 第 5 节）。在同一 fixture 上重跑 `pnpm run acceptance -- all --runs 3 --yes`：

| 任务 | 验收工具判定 | 用时（秒） | 最多 token | 最多模型调用 | 平均费用（美元） | 结论 / 未确认 |
|---|---|---|---|---|---|---|
| F1 | 3/3 | 15.3–19.7 | 34300 | 8 | 0.0052 | 27 / 7 |
| F2 | 3/3 | 16.2–19.7 | 43149 | 9 | 0.0066 | 25 / 10 |
| F3 | 3/3 | 17.6–20.1 | 40129 | 7 | 0.0062 | 33 / 10 |
| F4 | 3/3 | 18.0–20.6 | 44420 | 8 | 0.0069 | 25 / 11 |
| F5 | 3/3 | 16.7–20.1 | 42282 | 8 | 0.0064 | 34 / 9 |

- 15/15 通过，全部 COMPLETED、非降级、额度 NORMAL，没有技术重试；144 条结论全部有已核验来源。
- summary 长度的中位数从 1173 个字符降到 453，最长从 2363 降到 668；结论数量与来源完整性不变。
- 47 条未确认项中 3 条是来源不在读取范围内而被核验降级的结论，其余是模型自己标注的。
- 共 0.094 美元（平均 0.0063），延迟中位数 18.7 秒，单次最多 44420 token。
