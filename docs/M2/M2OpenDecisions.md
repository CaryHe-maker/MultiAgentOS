# MultiAgentOS M2 待决定事项

> 本文收集自主推进期间留给负责人（Cary）判断的问题，以及已经先行作出、需要复核的决定。
> 决定之后，把结论写入相应文档，并从本文删除该条。

## 1. 需要决定

| # | 问题 | 背景 | 建议 | 影响 |
|---|---|---|---|---|

## 2. 已决定

| # | 决定 | 依据 |
|---|---|---|
| A1 | 发布 M2Design v1.10，只含实测直接推翻的三处写法（空文件遮蔽、`/tmp` 挂载顺序、SIGTERM 目标）与第 9.4 节的说明修正 | M2Plan 第 6.1 节要求实测不符时先发布新版本；这几处是事实修正，没有改变设计意图 |
| A2 | `replayReasoning` 定为 `REQUIRED`，尽管服务端记得的工具调用不回传也能成功 | 服务端记忆的保留时长未知，恢复旧 Session 时可能失败 |
| A3 | Interface 没有写到字段级的 `ContextHistoryEntry`、`ContextAssembleInput.v1`、`GraphNodeRecord`、`GraphEdgeRecord`，按 Workflow 第 8.3 节与 M2Design 第 3 节的语义定义，已回填到 Interface/WorkflowKernel 第 3.5 节与 Interface/Persistence 第 2.3 节；`NODE_ENDED` 增加 `result?` | 契约门需要这些类型；条件边的判定必须是日志的纯函数 |
| A4 | 过渡期 major 1 以 `V1` 后缀与 major 0 并存，S1-IN-1 后去掉 | 已执行 |
| A5 | 原生一列取自 GitHub Actions 的 `ubuntu-24.04` 运行器（Azure 虚拟机，内核 `7.0.0-1017-azure`），AppArmor 限制与默认一致；没有在 Ubuntu 的 `generic` 内核上再测 | 阻塞行为与修复都已验证；发布前可在实体机上复核 |
| D2 | 阶段 1 的新代码与 M1 并存，S1-IN-1 接线并通过 `analyze` 回归后删除 M1 的模块；A1–A5 全部确认（Cary 2026-10-31 决定） | 已执行 |
| D3 | main 降级时经 `message-publish` 发布 `DEGRADED_REPLY`，只带结构化原因，不受额度限制（Cary 2026-10-31 决定） | 已执行 |
| D4 | 用户正文只以引用传递，没有例外（M2Design v1.12，Cary 2026-10-31 决定） | 契约已改，Execution 在 S1-KX-1 实现 |
| D5 | 不留历史包袱：`analyze` 并入统一路径，发布版只有 major 1，M1 模块在 S1-IN-1 后删除（Cary 2026-10-31 决定） | 文档已改 |
| D6 | AgentRun 状态机对所有 Agent 相同，结束方式由定义声明的结束工具决定，运行器按表执行（Cary 2026-10-31 决定） | 已执行 |
| D7 | 授权询问不超时，一直等到用户回答，只在运行收敛时取消；拒绝作为被拒 Unit 的工具结果交还 Agent，不结束 Turn（M2Design v1.13，Cary 2026-10-31 决定） | 已执行 |
| D8 | `AGENTS.md` 与其他说明文档同级：第一次需要读仓库时才读，以历史条目追加，不进入 system 段；main 没有启动 Unit（M2Design v1.14，Cary 2026-11-02 决定） | 已执行 |
| D9 | 用户拒绝绑定提出请求的 AgentRun；工具结果为 `the user rejected tool "x"`（参照 DeepSeek Harness），不计入连续出错，之后的轮次不再提交相同的工具（M2Design v1.15，Cary 2026-11-02 决定） | 已执行 |
| D10 | 思考强度只在 `registerAgentRun` 中给出（Cary 2026-11-02 决定） | 已执行 |
| D12 | 文件工具拒绝写入排除规则命中的路径（`.env*`、私钥、`node_modules` 等），返回 `PROTECTED_PATH`（M2Design v1.16，Cary 2026-11-04 决定） | 文档已改 |
| D13 | 系统没有 `git` 时，启动预设降为 `readonly` 并提示用户（M2Design v1.16，Cary 2026-11-04 决定） | 文档已改 |
| D14 | 写文件保持进程内执行；越界路径、符号链接替换与竞争条件的对抗测试是阶段 2 的退出条件（M2Design v1.16，Cary 2026-11-04 决定） | 文档已改 |
| D11 | main 的提示词暂不定稿：等阶段 2 实现写入能力之后再考虑。阶段 1 退出不再要求评测、定稿与封存 main，`main-system` 保持 `PLACEHOLDER`，`v1` 定义保持 `v0.1.0` 草稿（Cary 2026-11-04 决定） | 已写入 AgentToolPool 第 3 节 |
| D1 | 摘要请求按实测改写法（M2Design v1.11）；每个阶段完成后从 `feature/phase<N>/main` PR 到 `feat/M2`（Cary 2026-10-31 决定） | 已执行 |

## 3. 当前进度

核对时间：2026-11-04，`feature/phase1/main`；Ubuntu 24.04（WSL）完整质量门在阶段 1 的每次推进后运行。
阶段 0 已经由 PR #40 合入 `feat/M2`。阶段 1 已由 PR #41 合入 `feat/M2`。阶段 2 的文档门已通过（Cary 2026-11-04），S2-CT-1 到 S2-UI-1 在 `feature/phase2/main` 上实现，确定性退出用例在 `stage2-exit.test.ts`；真实模型上还没有运行过写入。

| 任务 | 状态 | 已完成 | 未完成 |
|---|---|---|---|
| S1-CT-1 | 完成 | v1 Schema 与 Port（`ExecutionFact.v1` 在 S1-KX-1 时补上）；fake Kernel、fake Workflow 与契约测试 | — |
| S1-IF-1、S1-IF-2 | 完成 | Session 存储、实例锁与 Session 锁；全局 ArtifactStore | — |
| S1-WF-1–4 | 完成 | 日志客户端、TaskGraph 与 `chat` 生长规则、上下文投影、`analyze` 走统一路径；已与真实 Kernel 接线 | — |
| S1-KC-1 | 完成 | Session actor、三个序列的 Outbox、Session 引用、信任记录、Session 管理（打开、切换、继续、列表、删除、关闭）、审计、产物回收的定时器（`ARTIFACT_SWEEP_TICK`） | — |
| S1-KC-2 | 完成 | Turn、开放输入的静止检查、AWAITING_INPUT、人类请求的转发、`answerAuthorization`、`readProjectFile`（`repo.read` 与 `project.instructions` 两步询问） | — |
| S1-KC-3 | 完成 | `SessionGateway`（调用方、Schema、Session 与运行的已知检查、准入封锁）与 `SessionCore` 的分发，已接到 Fabric | — |
| S1-KC-4 | 完成 | 两级账本、启动检查、工具次数、AgentRun 墙钟，已接入 Session actor | — |
| Core 的 Unit 路径 | 完成 | `RunWork`：幂等、AgentRun 登记与结束、受理、额度、授权、尝试、结果检查、收敛；审计写入；`RunExecution` 已接入 | — |
| S1-KX-1 | 完成 | 按 Session 的产物归属与保留类别、用户输入、`message-publish`、`report-publish`、引用解析、预览与完整输出、技术重试、取消与未确认停止的兜底、`readProjectFile`、`removeSessionFiles`、启动时与定期的产物回收 | — |
| S1-EX-1 | 完成 | `retention/`、工具 Executor、`context-assemble` 与 `model-call` 的 major 1（思考回传、收尾两步、`retryAfterMs`）、`createExecutorRegistry`；已在真实 DeepSeek 上运行 | — |
| S1-PL-1 | 完成 | `DefinitionCatalog`（解析、digest、交叉校验、固定）；main、planner、code-viewer、`analyze` 等 22 个 `v1` 草稿；`pinnedAgentOf` | main 的提示词等阶段 2 之后再定（D11） |
| S1-UI-1 | 完成 | 终端无关的 `Console`（待处理队列、排队的消息、指令、`/output`、两次 Ctrl+C、`mas run` 退出码）；`apps/cli` 的 Ink 视图与非 TTY 的逐行视图；已接入组合根 | — |
| S1-IN-1 | 完成 | 组合根接线；删除 M1 的模块与 major 0；去掉 `V1` 后缀与文件名中的版本；重建协议快照（`frozen: false`）；`analyze` 真实模型回归 15/15；退出用例的确定性测试（`stage1-exit.test.ts`） | — |

运行链路已切到 M2，代码中只有 major 1 一套契约。

`analyze` 真实模型回归（M2Plan 第 8.1 节；2026-11-04，提交 `843b012`，Ubuntu 24.04，`deepseek-flash@v0.1.0`，`--runs 3`）。
基线是 M1 验收证据第 8 节（提交时已封存的定义）。原始记录在 `.multiagentos/acceptance/s1-in-1-r3/records.jsonl`，不入库。

| 任务 | 判定 | 用时（秒） | 最多 token | 最多模型调用 | 平均费用（美元） | 结论 / 未确认 |
|---|---|---|---|---|---|---|
| F1 | 3/3 | 11.4–17.5 | 21864 | 6 | 0.0038 | 24 / 7 |
| F2 | 3/3 | 15.1–18.0 | 29730 | 7 | 0.0052 | 23 / 7 |
| F3 | 3/3 | 15.8–18.6 | 36634 | 7 | 0.0058 | 29 / 10 |
| F4 | 3/3 | 16.5–29.5 | 54353 | 10 | 0.0081 | 23 / 12 |
| F5 | 3/3 | 16.6–22.0 | 36712 | 8 | 0.0065 | 31 / 9 |

- 成功率：15/15 到达 COMPLETED，没有降级报告，额度状态都是 NORMAL，没有无法计数的 token（基线 15/15）。
- 来源完整性：130 条结论全部带已核验来源（基线 144 条，同样全部带来源）。45 条未确认项中 3 条是来源不在读取范围内而被核验降级的结论，其余是模型自己标注的（基线 47 条，同样 3 条）。
- 成本与延迟（按全部输入未命中缓存计算的上限，与基线同一算法）：共 0.088 美元，平均 0.0059；延迟中位数 16.6 秒（基线 0.094 美元、18.7 秒）。单次最多 54353 token，高于基线的 44420，出现在 F4。
- 这次的定义还是 `v0.1.0` 草稿（D11）。运行记录没有技术重试的计数，这一项没有与基线比较。

阶段 1 退出用例的核对（M2Plan 第 6.2、8.3 节）。确定性用例都经过真实的组合根、Kernel、Workflow、Console 与 ExecutorSet，只替换 provider 的 HTTP 接口，在 `apps/control-plane/test/acceptance/stage1-exit.test.ts`：

| 用例 | 结论 | 证据 |
|---|---|---|
| R | 通过 | 上面的真实模型回归 |
| S1 | 通过 | SIGKILL 子进程后重开：对话继续，遗留 Unit 记为 INTERRUPTED，没有重放，授权重新询问 |
| S2 | 通过 | 日志尾部写入半行后重开并继续 |
| S3 | 部分 | `/new` 后放弃不产生 Session 文件；`/fork` 在阶段 2 |
| S5 | 通过 | 第二个进程退出码 70，提示持锁进程（核对时补上了进程信息） |
| S6 | 通过 | Ubuntu 上的存储层测试：持有者退出、pid 被复用、心跳停止时抢占；没有另做进程级用例 |
| S7 | 通过 | 端到端：429 与 `Retry-After` 下等待足够长、活动区有倒计时。超过 `retryAfterMaxMs` 与假时钟在 `run-execution.test.ts` |
| L5 | 通过（没有压缩的部分） | fake provider 比对：工具不变，除末尾的状态行外只在末尾增长。真实运行的缓存命中率 76.8%（见下） |
| L6 | 通过 | 真实存储：满 7 天的 ContextPack 在启动时回收，上下文重建不受影响，删除 Session 后不再保留。定期回收以假定时器测试；新建或删除失败在 `session-manager.test.ts` |
| H12 | 部分 | 运行中输入的消息在 AWAITING_INPUT 时作为下一个 Turn 提交；中止的部分在阶段 5 |
| A（`repo.read`、根目录 `AGENTS.md`） | 通过 | 没用到仓库时不询问、一次运行只问一次、待答复时不放行也不拒绝、拒绝后 Turn 继续且下一个 Turn 可再问、未信任内容不进 system 段、内容变化后重新询问。“注入指令没有被执行”只验证结构，fake 模型不会判断内容 |

修复之后的真实运行（2026-11-04，提交 `40274b9`，F1–F5 各一次，记录在 `.multiagentos/acceptance/s1-in-1-cache/records.jsonl`）：5/5 到达 COMPLETED，没有降级报告，49 条结论全部带已核验来源。

| 任务 | 模型调用 | token | 输入 token | 缓存命中 | 命中率 |
|---|---|---|---|---|---|
| F1 | 7 | 26770 | 24977 | 19840 | 79.4% |
| F2 | 6 | 22060 | 19873 | 14208 | 71.5% |
| F3 | 6 | 32672 | 29433 | 19840 | 67.4% |
| F4 | 9 | 63608 | 58094 | 46720 | 80.4% |
| F5 | 9 | 50322 | 46243 | 36608 | 79.2% |
| 合计 | | | 178620 | 137216 | 76.8% |

这里的命中率来自 `analyze`，每个 AgentRun 的前缀不共享；长对话（L1）的命中率在阶段 8 另外记录。F4 的 token 高于 M1 基线的 44420；主要来自模型读遍仓库并分多轮读取，提示词与 M1 相同。

核对中发现并修复的问题：一次运行的第一个工具调用没有成功时（用户拒绝或文件不存在），下一次组装的历史缺少它的结果，组装失败，AgentRun 以 FAILED 结束，Turn 没有回复。15/15 的回归在修复之前的提交上运行；这个修复只改变第一个工具失败时的路径，修复之后又跑了上面的一轮。

M1 遗留的清理（2026-11-04）：`M1`、`major 0`、`docs/M1` 不再出现在代码与注释中（`M1` 只作为归档文档的名字出现在 `docs/`）；
`repository-search` 与 `file-read` 直接产出预览，不再经过 M1 Executor 外的适配层；`SearchContextPack`、`SEARCH_HIT`、`OBJECTIVE`、`HANDOFF` 段、只测试自己的 fake Executor 已删除。
`M2Design` 与 `Module/`、`Kernel/`、`Library/` 各文档中的“相对 M1 的变化”与指向 `History/M1` 的链接有意保留：它们说明设计来由，部分行为仍以归档文档为准。
