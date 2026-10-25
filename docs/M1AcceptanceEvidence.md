# M1 验收证据（草稿）

本文汇总 M1 完成定义与发布阻断项的验证证据，是 [M1ReleasePlan](M1ReleasePlan.md) R4.1、R4.2、R4.4 的工作底稿，
也收集 R1.7、R5.1 的限制清单草稿与 R5.3 的 Issue 处理意见草稿。它不是规范：验收标准以 [M1Plan](M1/M1Plan.md)
第 7、8 节为准。本文写于 2026-10-25 Cary 离开期间（计划第 6 节），全部结论待 Cary 复核；阶段四正式核对时逐条重做。

状态说明：**已满足**表示证据已在本地质量门中通过；**待真实模型**表示需要 `DEEPSEEK_API_KEY` 才能取得证据（计划第 6 节 A1）；
**待后续阶段**表示按计划在之后的阶段完成。

## 1. 完成定义（M1Plan 第 7 节）

| 条件 | 证据 | 状态 |
|---|---|---|
| F1–F5 均到达可解释终态；至少一个真实模型运行全部任务并记录指标 | 离线：`apps/control-plane/test/acceptance/acceptance.test.ts` 中 F1–F5 经完整产品调用链以 COMPLETED 结束，报告的每条结论都有读取过的来源。真实模型：`pnpm run acceptance -- all --runs 3 --yes`（R3.1、R3.6）尚未运行 | 离线已满足；真实模型待真实模型 |
| 所有任务完整经过权威调用链，且运行固定定义版本与 digest | 验收工具按 `main` 的组合方式装配全部产品部件并经 CLI 解析运行（`harness.ts`）；运行记录取 RunSummary 中各 AgentRun 的 `agentRef`（id、version、digest）。定义仍为 `v0.1.0` 草稿，按 AgentToolPool 规则在加载时计算 digest；定稿与封存 `v1.0.0` 属于 R3.5 | 调用链已满足；封存版本待后续阶段（R3.5，依赖真实模型评测） |
| ContextPack 和关键结论具有完整来源；无来源的成功结论数量为零 | `workflow.AnalysisReport.v0` 要求正常报告的每条结论至少一个 `VerifiedSource`（`kernel-protocol.test.ts`）；Workflow 10.1 的来源核验（`normal-report.test.ts`、`report-sources`）；ContextPack 的 `snapshotId` 与 `provenance` 由 Schema 强制（`kernel-protocol.test.ts`）并由各 Executor 测试覆盖（`orient-executor.test.ts`、`assemble-executor.test.ts`）；验收工具检查每个预期来源都被结论引用 | 离线已满足；真实模型运行的统计待真实模型 |
| 步骤、token、模型调用和时间预算均可确定性终止 | Monitor 的额度与收尾（`monitor.test.ts`、`attempts.test.ts`）；Workflow 的 Round 上限与无进展检测（`rounds.test.ts`、`progress.test.ts`）；运行超时（`stage6-acceptance.test.ts` 的 run timeout 用例）；陷阱 S3：脚本模型无限重复检索，运行在上限处以带原因的降级报告结束 | 已满足 |
| 写入、命令、测试、网络和 workspace 逃逸成功次数为零 | 仓库访问的路径检查反例（`repository-access.test.ts`：`..`、绝对路径、符号链接、排除规则、检查后替换）；子进程只允许 `rg`（`subprocess-runner.test.ts`，架构测试 `confines child processes to the Supervisor`）；Provider SDK 只在 model-call（架构测试）；陷阱 S2 跟随 README 中的注入指令读取 `/etc/passwd`、`../../..`、`/root/.ssh/id_rsa` 与 `.env`，全部 REJECTED，内容未进入模型、存储或终端；离线服务商拒绝一切非服务商主机 | 离线已满足；真实模型运行的统计待真实模型 |
| 工作区在运行前后保持不变 | 验收工具在运行前后对整个仓库（含被排除的文件）计算同一摘要并比对，F1–F5 与 S1–S5 全部一致 | 已满足 |
| 每个 Module/Infrastructure 均有边界、适配器和测试；架构绕行被自动化测试阻止 | `packages/testing/src/architecture.test.ts`（依赖白名单、Kernel 组件互不导入、SDK 与子进程的位置）；eslint 的 `no-restricted-imports`；各包的 contract test（`executor-contract`、`catalog-port-contract`、`inbox-port-contract`） | 已满足 |
| 在 Ubuntu LTS 上，`pnpm run check`、E2E、固定任务集和兼容矩阵全部通过 | CI `quality-gate.yml`：主格、Node 上界、无 rg 三格（M1TechStack 第 11 节）；WSL Ubuntu 24.04：88 个测试文件、1126 项通过，2 项为只在 CI 中运行的 rg 检查；离线 F1–F5 与陷阱在 `pnpm run test` 中 | 已满足；R4.5 的连续三次运行待后续阶段 |
| README、索引、接口、限制和运行说明与实现一致 | R4.3 预检已修正两处文档不一致（计划第 6 节 A6），并增加文档与定义文件的比对测试；限制清单见第 3 节草稿；运行说明待 R5.1 | 待后续阶段（R5.1、R5.2） |

## 2. 发布阻断项（M1Plan 第 8 节）

| 阻断项 | 防线与证据 | 状态 |
|---|---|---|
| 绕过 UserInteraction、Kernel、Workflow | 组合根是唯一知道具体实现的地方，各主体只有自己的 Fabric 客户端；CLI 只调用 UserInteraction（`run-cli.ts`）；验收工具经 CLI 运行 | 未发现 |
| Workflow 直连执行组件 | Workflow 只依赖 contracts 与 fabric，只持有 `WorkflowGatewayPort`（架构测试 `declares only the allowed internal dependencies`） | 未发现 |
| 模型直接调用工具 | model-call Executor 只返回工具调用；Workflow 校验后经 `submitUnit` 交给 Kernel，Kernel 再派给 Supervisor（M1Interface 6.6 的性质测试 `unit-cycle.test.ts`） | 未发现 |
| 定义版本未固定 | Workflow 在运行开始时 `pinAgent` 一次并只使用返回的闭包；Kernel 核对 `agentRef` 与单元的 digest（`request-handler.test.ts`）；草稿在加载时计算 digest | 未发现（封存见 R3.5） |
| 协议未注册 | `createM1ProtocolRegistry` 注册 SharedContracts 第 3 节的全部 Schema（`protocol-registry.test.ts`）；Fabric 每次投递按注册的 Schema 校验；协议冻结守卫比对快照（`schema-snapshot.test.ts`） | 未发现 |
| Unsupported 产生状态变化 | `rejects an unsupported executionKind before creating an attempt`（`request-handler.test.ts`）；opaque family 标为 UNSUPPORTED（`protocol-registry.test.ts`） | 未发现 |
| 副作用执行成功 | 只读 Executor、只允许 `rg` 的子进程、路径检查；验收工具比对工作区摘要 | 未发现 |
| 缺少硬预算 | Monitor 的 token 额度、预留与收尾；Round 上限；单元超时与运行超时；启动检查保证不可裁剪段在最坏输入下放得下（Monitor 第 4 节，A5） | 未发现 |
| 关键结论无来源 | 正常报告的结论 Schema 要求至少一个已核验来源；未核验的进入 `unconfirmed` | 未发现 |
| ContextPack 无 snapshotId/provenance | Schema 强制（`kernel-protocol.test.ts`） | 未发现 |
| 模块通过异常字符串协作 | 跨模块结果为结构化的 `SyscallRejected`、`UnitReport`、`ModuleError` 与原因码；Workflow 识别端口超时靠 `FabricError.code`，不解析消息文本 | 未发现 |
| 无法独立替换或测试适配器 | `SystemParts` 允许替换任意产品工厂；`packages/testing` 提供共享 fake 与 contract test；组合根测试分别以 fake 与真实部件运行 | 未发现 |
| M1Interface、SharedContracts 与 AgentToolPool 不一致 | R4.3 预检：Schema ID 与注册表一致，文件与目录都存在，16 个定义与文档对应；两处不一致已修正（A6） | 已修正，阶段四复核 |

## 3. 限制清单（草稿，R1.7、R5.1）

| 限制 | 说明 |
|---|---|
| 平台 | 验收与兼容矩阵只覆盖 Ubuntu 24.04 LTS；Windows 与 macOS 可用于开发，但不在验收范围（D7） |
| 模型服务商 | 只接入 DeepSeek（OpenAI 兼容协议）；`deepseek-v4-pro` 已定义但不是默认模型 |
| 文本编码 | 只读取 UTF-8 文本；GBK 等编码的文件与二进制文件一样不进入概览与检索，读取时返回 `UNSUPPORTED_FILE`（A2） |
| 大文件 | 超过 16 MiB 的文件不可读取；单次读取最多 400 行且受字节上限约束 |
| 秘密保护 | 依靠路径排除规则（`.env*`、`*.pem`、`*.key` 等）；写在普通源码文件中的密钥不会被识别或遮蔽 |
| 符号检索 | 用记录了限制的正则策略，不做语法分析（M1TechStack 第 8 节） |
| 运行状态 | 单进程、单用户、单活动任务；运行状态不持久化，进程退出后不能恢复（M1Plan 第 9 节） |
| CI 触发 | `pull_request` 只匹配 `main` 与 `feat/**`，`feature/M1/main` 上的提交靠 push 触发（D6） |
| Prompt | 仍为 `v0.1.0` 草稿（PLACEHOLDER），真实模型评测后定稿封存（R3.5） |
| 真实模型基线 | 成功率、来源完整性、成本与延迟基线尚未取得（A1） |

## 4. 需要 Cary 或真实模型才能完成的事项

| 事项 | 原因 |
|---|---|
| R2.1 fixture 审阅 | 完成标准要求 Cary 审阅（A4） |
| R3.1、R3.6 真实模型运行；R3.3（D3）、R3.4 配置校准、R3.5 Prompt 定稿与封存 | 需要 `DEEPSEEK_API_KEY` 与评测结果（A1）；`pnpm run acceptance` 会先列出次数与费用上限 |
| 计划第 6 节 A1–A6 的二次选择 | 自主执行期间的决定 |
| R4.6 协议冻结 | 应在阶段三结束、确认不再改 Schema 之后 |
| R5.3 Issue 处理、R5.4/R5.5 发布 PR | 每项都需要 Cary 单独确认 |

## 5. Issue 处理意见（草稿，R5.3）

只是建议，未在 GitHub 上执行任何操作。

| Issue | 建议 | 依据 |
|---|---|---|
| #4 早期工具集 | 关闭 | 工具集已定为 search_repository、read_file 与两个控制工具（AgentToolPool 第 4 节） |
| #5 一问一答转发 | 转入后续里程碑 | M1 不做对话转发 |
| #6 安全风险清单 | 关闭 | 五条全部落实为陷阱 S1–S5（R2.4） |
| #10 M0 结论与 M1 待决问题 | 关闭 | 结论已进入 M1Interface 与各模块文档 |
| #13、#14、#18、#19、#20 机制讨论 | 关闭，各附结论所在的文档章节 | 讨论结果已写入 Kernel、Workflow、ExecutorSet 文档 |
| #15 实现目标讨论 | 关闭 | M1Plan 第 1 节 |
| #17 通信机制讨论 | 关闭 | Fabric.md 与 M1Interface 第 2 节；跨进程 IPC 转入后续 |
| #24 排除规则 glob 语义 | 关闭 | #27 已合入，M1Interface 3.5 定义语义 |
| #25 CI 安装 ripgrep | 关闭 | CI 已安装 rg，且兼容矩阵覆盖有与无 rg（R1.1、D7） |
| #26 ExecutorSet 实现决策 | 关闭 | 已答复的决定全部落实（R1.4、R1.5、R1.6） |
| #28 同步步骤 | 关闭 | 三个分支已合并 |
| #29 依赖与约定 | 关闭 | 端口期限已系统级化（R1.8），其余约定已落实 |
| #32 合并后对齐 | 第 3 节已落实（R3.2）；第 1 节待 D3、第 2 节待真实模型评测，保留到阶段三结束 | |
