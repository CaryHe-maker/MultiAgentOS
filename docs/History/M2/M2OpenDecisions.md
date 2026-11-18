# MultiAgentOS M2 待决定事项

> **已冻结的历史文档（2026-11-07）。** 本文记录 M2 第一轮实现期间的决定、各阶段的计划与进度，按旧编号"阶段 0–8"组织，不再修改。
> 仍然有效的决定已迁入 [M2Decisions](../../M2/M2Decisions.md)；各项能力的现状见 [M2Baseline](../../M2/M2Baseline.md)；后续计划见 [M2ReleasePlan](../../M2/M2ReleasePlan.md)。
> 文中"未完成""留待"等字样描述的是写作当时的状态，当前状态以 M2Baseline 为准。

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
| D11 | main 的提示词在写入能力完成后定稿（Cary 2026-11-04 决定，阶段 2 结束时执行）：`main-system` 为 `FINAL`，已在真实模型上验证。阶段 3–6 还要给 main 增加工具，所以定义仍是 `v0.1.0` 草稿，到 M2 发布时再一起封存 | 已写入 AgentToolPool 第 3 节 |
| D1 | 摘要请求按实测改写法（M2Design v1.11）；每个阶段完成后从 `feature/phase<N>/main` PR 到 `feat/M2`（Cary 2026-10-31 决定） | 已执行 |

## 3. 当前进度

核对时间：2026-11-04，`feature/phase2/main`；Ubuntu 24.04（WSL）完整质量门在阶段 1 的每次推进后运行。
阶段 0 已经由 PR #40 合入 `feat/M2`。阶段 1 已由 PR #41 合入 `feat/M2`。阶段 2 的文档门已通过（Cary 2026-11-04），S2-CT-1 到 S2-UI-1 在 `feature/phase2/main` 上实现，确定性退出用例在 `stage2-exit.test.ts`。

阶段 2 发布前审核（2026-11-04，M2Design v1.17）：审核发现的 24 条问题与端到端用例查出的 2 条问题已全部修复；Ubuntu 24.04 完整质量门通过。真实模型复查：写入任务 39/40（本仓库任务 4/4；唯一的失败是模型写的代码没过隐藏测试），`analyze` 回归 F1–F5 5/5。

真实模型写入实验（2026-11-04）：小仓库任务全部通过；真实仓库任务大多在写入之前被叫停，主因是上下文上限按字节计，高估约 3.3 倍（待决定）。tree-sitter 不引入，见 [experiments](../../experiments.md)。

main 写入的真实模型检查（`run-main-write.ts`，2026-11-04，`deepseek-flash@v0.1.0`，Ubuntu 24.04）：6/6 通过。改名（三个文件）、新建文件、只问问题时不写、打招呼不调用工具、`.env` 没有被写入、`/undo` 恢复原内容。只跑了一轮，不是评测基线；`.env` 那一例模型没有尝试写入，所以这一轮没有在真实模型上触发 `PROTECTED_PATH`，这条拒绝由 `stage2-exit.test.ts` 与对抗测试覆盖。

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
| S1-PL-1 | 完成 | `DefinitionCatalog`（解析、digest、交叉校验、固定）；main、planner、code-viewer、`analyze` 等 22 个 `v1` 草稿；`pinnedAgentOf` | — |
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
| D14 | 系统内存检测放入阶段 3：Monitor 定时采样，只向 Core 发控制消息，经统一收尾路径与中断入口处理，不设特例路径（M2Design v1.17，Cary 2026-11-04 决定） | 文档已改，S3-KC-3 实现 |
| D15 | 额度按价格折算缓存命中的输入；单次输出上限 64000，输入上限 880000（M2Design v1.17，Cary 2026-11-04 决定） | 已执行 |
| D16 | 估算与 provider 的计数相差不到 5%；模型运行代码的问题留到阶段 3 有运行指令能力之后；提前收尾必须有报告与日志，接近上限时预警（M2Design v1.17，Cary 2026-11-04 决定） | 已执行 |
| D17 | main 的 `maxRounds` 提到 80：上下文放开后，轮次成为长任务的下一个瓶颈（Cary 2026-11-04 决定） | 已执行 |

## 4. 阶段 3 进度（`feature/phase3/main`，2026-11-05）

阶段 3 的文档门是草稿，待评审（[KernelSupervisor](../../M2/Interface/KernelSupervisor.md)、[SystemFaultHandling](../../M2/SystemFaultHandling.md)、Core 第 5b、5c 节、Supervisor 第 5、6 节、ExecutorSet 第 5c 节、M2Security 第 3b 节、Workflow 第 9.2a 节）。

| 任务 | 状态 | 已完成 | 未完成 |
|---|---|---|---|
| 轮次上限（D17 的补充） | 完成 | `maxRounds` 含最后一轮：第 `maxRounds` 轮就是 final-call；提前 5 轮在 STATUS 预警；`ROUND_LIMIT` 的收尾要求列出已完成、未完成与可接着发送的提示词 | — |
| E-EX-3 | 完成 | `web-tree-sitter` 0.27.1 + `tree-sitter-bash` 0.25.1；子命令拆分、不可复用原因、ARITY 前缀、名单匹配（语法树与原始文字的并集） | — |
| S3-CT-1 | 完成 | SandboxProfile/Scope、`approvalDigest`、环境变量白名单与断言、COMMAND/GIT_INSPECT 的 Schema、`SandboxRunner`、`StopUnconfirmedError`、`RunInterrupted`、`MemoryPressure`、`quota = MEMORY`、`MEMORY_LIMIT`、`closeRun(INTERRUPTED)`、新原因码、配置、协议快照 | `cancelExecution` 与 fake Supervisor |
| S3-KX-1 | 大部分 | `buildBwrapArgs`（纯函数）、`createSandboxRunner`（启动前复核、SIGTERM/SIGKILL 升级、`StopUnconfirmedError`）；真实 bwrap 的 13 项测试在 Ubuntu 24.04（WSL）通过 | 可用性探测并写入 `SESSION_STARTED`；`cancelExecution` |
| S3-EX-1、S3-EX-2 | 完成 | `run-command`（头尾预览）、`git-inspect`（固定子命令表、pathspec 排除） | `git-inspect` 的真实 git 用例 |
| S3-UI-1 | 部分 | 命令询问的四个选项、警示文字、`INTERRUPTED` 的退出码 75 与提示 | 未隔离提示、停机提示、内存提示的完整展示 |
| S3-KX-2 | 完成 | 仓库扫描（敏感文件、已存在的受保护路径）；命令前后比较，新建的 `.git`、`AGENTS.md`、`.multiagentos` 移入 `kernel-execution/quarantine/`，结果为 `PROTECTED_PATH_CREATED` 并写审计；EXEC 互斥由每个运行一次只派发一个尝试保证 | 阶段 4 起按 AgentRun 分队列时的全局互斥 |
| S3-KC-1 | 完成 | `decideUnit` 的命令判定（名单、能力上限、沙盒可用性、条目覆盖每个子命令、极危险级逐次询问）；命令询问（合并、四个选项、不可复用原因）；`ONCE`/`COMMAND`/`PREFIX` 条目；签发 `SandboxScope` 与 `approvalDigest`；`ask-unisolated` 的未隔离运行；启动探测 `probeSandbox` | 探测结果写入 `SESSION_STARTED` 与审计 |
| S3-KC-2、S3-KC-3 | 大部分 | `STOP_UNCONFIRMED` 关闭运行后经 `onFatal` 请求停机；Monitor 内存采样器（只发 `MemoryPressure`，架构测试保证）；WARNING 拒绝新 AgentRun 并以 `QUOTA_EXHAUSTED(MEMORY)` 拒绝工具；DANGER 发 `RunInterrupted`、取消并以 `INTERRUPTED` 关闭运行，界面以退出码 75 退出 | 没有运行时的 DANGER 退出（`onMemoryExit` 尚未接到组合根）；`cancelExecution` 与 INTERRUPTING 状态（阶段 5 的暂停与中止共用） |
| S3-WF-1 | 部分 | `RunInterrupted` 记入日志并在下一次打开时以说明出现在投影中；`QUOTA_EXHAUSTED(MEMORY)` 进入 `MEMORY_LIMIT` 收尾 | 中断时不经模型的确定性回复（现在直接以 `INTERRUPTED` 关闭运行，没有 `DEGRADED_REPLY`） |
| S3-PL-1 | 完成 | Unit `run-command`、`git-inspect` 与 Tool `run_command`、`git_inspect`（v0.1.0 草稿）；main 增加两个工具与 `command.exec`、`command.network`，提示词增加运行命令与验证的准则；Workflow 填写工作目录、超时、联网的缺省值，命令之后不再把先前的读取当作重复调用 | — |
| S3-IN-1 | 未开始 | — | 组合根接线、`stage3-exit.test.ts`（C1–C5、H6–H7、内存压力的假采样与真实压力） |

阶段 3 退出用例（`apps/control-plane/test/acceptance/stage3-exit.test.ts`，2026-11-05，Ubuntu 24.04 WSL，连跑 3 次 40/40）：真实的组合根、Kernel、Workflow、界面、ExecutorSet、`bwrap` 与 `git`，只替换 provider 的 HTTP 接口；内存读数、Executor 的失败与沙盒探测结果由用例给出。

| 组 | 用例 | 证据 |
|---|---|---|
| C | 询问展示确切命令与选项、非零退出码是结果、超时保留已有输出、长输出截断并经 `read_output` 读回、工作目录、每次全新 shell | 通过 |
| C5 | 秘密文件读为空且不进模型与日志；环境变量无凭据（`env`、`printenv`、`/proc/self/environ`）；不能写仓库外；指向仓库外的链接读不到；无网络；已有 `.git`、`AGENTS.md` 只读；新建的受保护路径被移出并写审计；看不到数据目录 | 通过 |
| H6 | 忽略 SIGTERM 的命令被 SIGKILL 收掉，没有残留进程，系统继续 | 通过 |
| H7 | 无法确认停止：报系统故障、之后不再调用模型、重新打开 Session 后不重跑 | 通过（以测试替身模拟） |
| A | 前缀与"这条命令"的覆盖范围、单次用完即止、不跨 WorkflowRun、拒绝作为工具结果且同一运行不再问、待答复时不放行不拒绝、六种不可复用写法只给单次、`git push`/`gh`/联网每次询问、禁止名单（含 `env`、赋值前缀、子 shell 包装）、批准后改命令被 `APPROVAL_MISMATCH` 拒绝 | 通过 |
| — | 沙盒不可用的缺省拒绝、`ask-unisolated`、`readonly` 预设无命令工具 | 通过 |
| — | `git_inspect` 的五个动作、不泄露隐藏文件、固定参数、非 git 仓库 | 通过 |
| 内存 | 警戒级收尾并告知用户、不再接新任务；危险级中断、退出码 75、日志完整、重启后恢复且不重跑 | 通过 |
| — | 轮次上限：第 80 轮是收尾、提前预警、界面提示 | 通过 |

用例查出并修复的问题：内存中断后界面在事件处理里等待停机，而 Kernel 等这个事件送达后才停机，两边互相等待，进程不退出；现在不在处理里等待。
未覆盖：C1–C4（真实模型）、内存压力的真实压力、`cancelExecution`。

阶段 3 的 C1–C4（真实模型，2026-11-05，`deepseek-flash@v0.1.0`，Ubuntu 24.04 WSL，每个任务 5 次，命令在真实 `bwrap` 中运行；任务在 `write-eval/tasks-command.ts`，运行器是 `run-write-eval.ts`，原始记录在 `~/mas-eval-final2/records.0.jsonl`，不入库）。
一次成功指：模型没见过的隐藏测试通过、没有越出预期范围的改动、模型确实通过 `run_command` 运行了命令、回复说明了做了什么；C3 另要求先看到新测试失败、再看到通过。

| 任务 | 通过 | 模型调用 | `run_command` 次数 | 询问 | 用时（秒） | 缓存命中 | 费用（美元） |
|---|---|---|---|---|---|---|---|
| C1 修一个 bug 并运行测试 | 5/5 | 5–7 | 1–3 | 3–5 | 7–11 | 89% | 0.0047 |
| C2 跨 5 个文件重命名（源码、测试、文档） | 5/5 | 6–8 | 1–3 | 3–5 | 11–19 | 86% | 0.0097 |
| C3 先写会失败的测试、看到失败、再修 | 5/5 | 7–11 | 2 | 4 | 12–22 | 90% | 0.0068 |
| C4 新增函数与测试 | 5/5 | 5–7 | 1–2 | 3–4 | 11–12 | 89% | 0.0068 |

合计 20/20，0.028 美元；每个任务的标准是至少 4/5。所有任务都先在没有模型的情况下确认过：未改动的仓库过不了隐藏测试。

**判定器的修正过程（如实记录）**：这个任务集一共判了四轮，每一轮模型的行为没有变，变的是我的判定。
1. 第一轮 17/20：C1 我多加了"必须先看到测试失败"，规格里没有这一条（那是 C3 的要求）；C3 有一次模型把测试输出接到 `| tail` 之后，退出码被管道吞掉，我只看退出码而漏掉了失败报告。
2. 第二轮 C1 一次失败：我把 C1 的最少命令数误设为 2，规格是运行测试。
3. 第三轮 C3 全部失败：我改判定器时把正则 `d` 写丢了，判定器自己出错。
4. 第四轮 20/20：C1 不要求先看到失败；C3 的"失败"同时认退出码与测试报告；C1 最少 1 条命令；正则修好。
没有改动任务本身、隐藏测试或模型的提示词。样本只有 5 次，结论是"没有测到失败"，不是成功率的精确估计。

**运行中看到的**
- 主要成本是读文件：每个任务 5–11 次模型调用，其中命令只有 1–3 次。
- 缓存命中 86%–90%，高于阶段 1 的 `analyze`（76.8%）。
- `git_inspect` 在没有 git 的 fixture 里被模型调用过 7 次，得到 `NOT_A_GIT_REPOSITORY` 后模型照常继续；工具的提示没有告诉模型"没有 git 就不要再试"，可以补一句。
- 8 次 `TOOL_INPUT_REFUSED`/`TOO_MANY_TOOL_CALLS`（一轮并行读太多文件、`workdir` 写成绝对路径），模型都自己纠正了。
- **一个产品缺口**：node 装在 `$HOME` 下的自定义目录（这台 WSL 的 `~/.local/opt/node-…`）时，沙盒里找不到 node，因为 `$HOME` 被整体遮蔽，缺省白名单只有 `.nvm`、`.volta`、`.cargo`、`.rustup`、`.local/bin`、`.npm`。评测运行器把当前 node 所在目录加入了 `sandbox.homeReadOnly`；用户的使用说明必须写明这一点，否则命令会报 `node: command not found`。
- 没有一次触发 `wrapUps`、拒绝或沙盒的任何拦截：这四个任务不含越界企图，拦截由确定性的 C5 覆盖。

node 在 `$HOME` 下的缺口（上一节）已按 Cary 的决定（2026-11-05）改为自动挂载 `PATH` 中位于 `$HOME` 之下的目录（M2Design v1.18，`sandbox.mountPath`，缺省开启）。评测运行器里的临时白名单已删除；C1–C4 在自动挂载下再跑 3 次，12/12，$0.018（`~/mas-eval-automount`）。端到端用例 3 个：命令找得到 node 与 npm 及其 `../lib`；`$HOME` 的其余内容仍不可见；关闭开关后工具目录不在。纯函数 `pathToolchainMounts` 有 8 个单元用例（`$HOME` 与其上级、直接位于 `$HOME` 之下的前缀、数据目录与仓库、嵌套目录、相对与空项）。
已知局限：`~/.local/bin` 这类目录里指向别处的符号链接，目标若在未挂载的位置仍会找不到；只读挂回意味着命令能读到这些目录里的所有文件，用户的 `PATH` 里不应放含机密的目录。

阶段 3 的小项（2026-11-05）全部补齐：
- `cancelExecution`：契约、Supervisor（运行中与未开始的执行、重复、未知与其他 epoch 的请求、仍会升级为 `STOP_UNCONFIRMED`）、Fabric 端口、`createFakeSupervisor`（6 项）与 Fabric 上的 2 项用例；事实带 `cancelReason`。
- 探测结果：写入 `SESSION_STARTED.sandbox` 与审计 `SANDBOX_PROBED`；模型在运行时上下文看到 `Sandbox: …`；不可用且缺省拒绝时，`run_command` 不在任何请求的工具列表中，`ask-unisolated` 时保留。
- 危险级内存中断：改为设计中的 INTERRUPTING。运行保持打开，只放行关闭用的回复，Workflow 发布一条不经模型的 `DEGRADED_REPLY`（`MEMORY_PRESSURE`）后以 `closeRun(INTERRUPTED)` 结束；超时由 Kernel 兜底关闭。Workflow 与 Core 文档已与实现一致。
- 没有运行、或会话间的危险级内存：界面经 `onMemoryExit` 以退出码 75 退出。
用例查出一个问题并已修：运行时上下文里 `sandbox` 字段在日志中限 64 个字符，第一版文字超长，使重新打开的 Session 被判为"记录已损坏"（8 个既有用例因此失败）；现在文字缩短，并在注释里写明限制。

阶段 3 静态审查（2026-11-05，`32fba0b` 及其后）：通读全部阶段 3 代码，修了 8 个小问题，另有 7 个设计问题经 Cary 决定按推荐实现（M2Design v1.19）。
小问题：命令输出预览按行裁剪后可能超出字节上限；`child-pid` 只从一个状态数据块解析；`git_inspect` 的 path 可带 `:` pathspec 魔法；`env`、`xargs`、`timeout`、`sudo` 等包装命令会生成能覆盖任意命令的前缀；"高风险命令"标签对仅不可复用的命令也出现；仓库扫描超出条目预算时静默截断，更深处的密钥不被遮蔽，改为扫描不完整即拒绝该命令（`ADMISSION_CHECK_FAILED`）；隔离区移动在仓库跨文件系统时失败且仍报告为已移动，改为复制再删除。
设计问题与做法：
1. 宿主暴露面：`/run`、`/mnt`、`/media` 以空 tmpfs 遮蔽，共享网络时只读挂回域名解析所需的两处。
2. `git_inspect` 在只读沙盒中运行（`SandboxProfile.writableRoots` 允许为空，快照已更新），没有沙盒可用时回退到原来的直接运行。
3. `.git/config` 以去掉凭据的副本覆盖。
4. 内存：系统可用内存不足最高只到 `WARNING`，进程自身的 RSS 与堆才可到 `DANGER`。
5. `command.exec` 的拒绝只绑定被拒的那一条命令。
6. 沙盒资源：`/tmp` 512 MiB、进程数 2048、单文件 2 GiB，加 `--unshare-ipc`、`--unshare-uts`。
7. 内存 `WARNING` 不再是整个运行的粘性状态：采样器给出当前级别，压力回落后新工具与 AgentRun 可以继续。
局限：进程数限制在 5.14 之前的内核上按用户计数，以"已有进程数加上限"近似；`git_inspect` 在沙盒中丢弃标准错误，失败时只给退出码和提示；沙盒的 CPU 与内存总量没有限制（没有 cgroup 权限时做不到，只有超时兜底）。

内存压力的再修订（2026-11-05，M2Design v1.21）：评测暴露整机内存紧张会让三个聊天提前收尾（`MEMORY_LIMIT`），Cary 决定去掉系统级内存对工具的拒绝，并要求强制中止或提醒必须有记录、界面可见，中止后用户重新输入必须能开始新的 Turn。
做法：`MemoryPressure` 增加 `source`；整机不足只通知与记录；每次压力先写系统级 `memory-events` 记录，再由界面提示；对话中断后不退出；拒绝新工作以采样器当前级别为准。
端到端用例查出两个会"卡死"的问题并已修：1) 运行以 `INTERRUPTED` 关闭后，控制台没有运行可以接收输入，下一条消息排在队里永远不被处理（现在下一条消息先开启新运行，再交给它）；2) 中断时被取消、尚无结果的调用留在日志里，下一个运行的历史里有没有结果的调用，上下文装配失败（现在中断时先给这些调用补上结果）。
另一个缺陷同时修了：本程序内存偏高时新的 AgentRun 被拒绝，原来节点失败后运行不关闭，对话停在那里；现在运行以 `INTERRUPTED` 关闭并说明原因。
`process-entry` 的 `first-interrupt` 用例在慢机器上偶发失败（GitHub 检查失败的原因）：信号在处理器安装之前发出，进程被默认行为杀死。现在子进程在处理器装好之后才打印标记，测试等标记再发信号。

阶段 2 任务集的重跑（2026-11-05）：同样的 40 个任务（`tasks.ts` 25 个、`tasks-hard.ts` 15 个，含 4 个本仓库任务），同一个模型和代码，分两臂各跑一遍：带命令（有 `run_command`）与只写（沙盒按不可用处理，等价于阶段 2 的工具集）。阶段 2 的记录是 39/40。询问一律回答"只这一次"。

| | 带命令 | 只写 |
|---|---|---|
| 通过 | 40/40 | 40/40 |
| 费用 | 0.264 美元 | 0.223 美元 |
| 模型请求 | 496 | 397 |
| 用时 | 2237 秒 | 1586 秒 |
| 询问用户 | 256 | 81 |

- 命令用了 182 次，分布在 34 个聊天里：读取与搜索 54、临时脚本检查 58、编译与类型检查 33、测试 23、git 6、其他 7；29 次命令以非零退出码或超时结束。
- 写入：`write_file` 42、`edit_file` 127（带命令）；`write_file` 40、`edit_file` 150（只写）。
- 失败的命令之后接着改了文件的有 14 次，分布在 9 个任务里（类型错误、格式检查失败、测试失败之后修正）。
- 结论：这个任务集没有拉开差距——通过率在两臂都是上限，命令的收益体现在自我检查，不体现在隐藏测试的通过数上，代价是约 18% 的费用、25% 的请求和每个聊天多约 4 个询问。每个任务每臂只跑了一次，不能给出置信区间。
- 看到的问题：`git_inspect` 在没有 git 的 fixture 里被调用了 40 次得到 `NOT_A_GIT_REPOSITORY`（两臂合计）；模型把 `workdir` 写成绝对路径被拒 4 次，下一轮自己改正。

评测中走的弯路（如实记录）：第一轮用 9 分钟的硬时限切分窗口，被切断的聊天不留记录，续跑时重做（没有统计次数）；并行三个分片使整机内存被占满，`WARNING` 使 3 个聊天在模型动手之前就以 `MEMORY_LIMIT` 收尾，这 3 条已作废（保存在 `invalid/`）并补跑，其余记录没有重跑。已加 `--stop-after`，窗口用完前不再开新的聊天；评测器给每个聊天自己的内存读数，不受整机影响。

内存预警的收窄（2026-11-05，M2Design v1.22）：评估后发现内存预警在真实运行中从未被需要过（评测里每个进程约 800 MB，堆远低于上限；唯一一次触发是评测自己占满整机造成的误触发），Cary 同意只保留有真实场景的部分。
- 保留：V8 堆占比（对应 Node 堆爆）。实测 WSL 上堆上限只有 2240 MB，一个 2 GB 的进程会无声崩溃；运行时用 `v8.setFlagsFromString` 设置 `--max-old-space-size` 无效（实测上限不变，进程仍在约 2 GB 崩溃），所以入口的 shebang 改为 `#!/usr/bin/env -S node --max-old-space-size=4096`。
- 去掉：没有容器上限时 RSS 对物理内存的比。进程自己到不了先于系统出手的程度。
- 新增：沙盒命令的私有可写内存上限（`prlimit --data`，缺省物理内存的一半）；单元测试与真实 bwrap 用例覆盖。
- 局限：`--data` 只限制私有可写内存，不含文件映射；Windows 上没有沙盒，入口的 shebang 不起作用（npm 的 Windows 启动器直接调用 node），堆上限仍是 V8 默认值。

只读名单（2026-11-05，M2Design v1.23）：评测里带命令一臂比只写一臂多出 175 个询问，其中很大一部分是 `ls`、`cat`、`grep`。Cary 同意把安全命令单列一个名单（`command.readOnlyCommands`），与只读 Executor 同一保护级别：一次同意 `repo.read` 即默认授权。
做法：不用 Executor 重新实现这些命令，而是照常在沙盒里真跑，只是不再询问，并且用可写根目录为空的只读沙盒运行；输出是真实的，模型不需要知道有这一条捷径。名单判断出错只会使命令失败，写不出去。每次放行写入审计。
实现中发现并修复：授权用例原来用 `echo`、`printf` 作为被询问的命令，现在它们属于名单，这些用例用 `readOnlyCommands: []` 关闭名单；`pwd`、`echo` 这类不打开仓库文件的命令连 `repo.read` 也不需要。
局限：名单是静态的；没有做"先以只读方式试跑，写入被拒再询问"的通用方案（`npm test`、`tsc --noEmit` 仍然要问），等看到这次的数据后再决定。

阶段 3 的第二次静态审查（2026-11-05，第一次之后新增的内容）：读了自 `6fef243` 以来改动的全部非测试代码，修了 7 处：
- 沙盒用 `prlimit` 启动命令时写的是命令名，依赖命令自己的 `PATH` 里有它；`PATH` 不含 `/usr/bin`（如 Nix）时每条命令都会 127。改为绝对路径 `/usr/bin/prlimit`。
- `--size`（限制 `/tmp` 大小）需要 bubblewrap 0.8，Ubuntu 22.04 的 0.6.1 没有，会使整个沙盒探测失败。现在按 `bwrap --version` 判断，不支持时 `/tmp` 不限大小，沙盒照常可用。
- `.git/config` 存在但无法复制成去掉凭据的副本时，原来会让命令看到原文件；现在改为用空文件覆盖。
- 内存采样器的级别在阈值上下浮动时每秒产生一次事件、一条记录、一条提示；现在加了 5 个百分点的回差，离开一个级别要低于阈值 5 个点。
- 中断后下一条消息开启新运行时，若旧运行还在关闭中会被拒一次；现在重试最多 5 次，每次间隔 100 毫秒。
- `git_inspect` 的 `rev` 以 `-` 开头会作为选项传给 git（`--ext-diff` 会重新打开前面关掉的外部 diff）；现在拒绝。
- 端到端用例补了结构检查：中断后提供方收到的历史里，每个工具调用恰有一个结果。
已知局限（未修）：入口放宽堆上限用的是 shebang；npm 全局安装与直接执行有效，pnpm 的启动脚本直接调用 `node`，不经过 shebang，这时堆上限仍是 V8 默认值。要在所有安装方式下生效，需要入口在发现堆上限偏低时用 `--max-old-space-size` 重新启动自己；这涉及信号转发与终端，单独做。

阶段 4 的开始（2026-11-05，`feature/phase4/main`，M2Design v1.24）：Cary 决定两项——Turn 与运行额度提高到 800 万与 2400 万；只读名单上的命令行按 READ 处理（不占 EXEC 互斥）。顺序与进度：
- 已完成并通过测试：S4-KC-2 Monitor（AgentRun 账本与逐级委派）、S4-KC-1 Scheduler（`providerCapacity`、`WAIT_CAPACITY`）、S4-KX-1 Execution（按 AgentRun 分队列、类别、全局上限、`serialExecution`、等待调用机会）、S4-CT-1 契约（`reserveDelegation`、`releaseDelegation`、`RegisterAgentRunRequest` 的父子字段、`agent.spawn`）、S4-KC-3 Core（SubAgent 登记、委派、写入占用、`WRITE_SCOPE_CONFLICT`、`WRITE_SCOPE_DELEGATED`）。
- 随后完成：S4-PL-1 explorer、worker 与 `run_subagents`、`finish_subagent` 的定义和提示词；S4-WF-1 Workflow（多个 AgentRun 并行推进，`run_subagents` 的校验、委派与图扩展，汇合，结果契约，改动对账，完成检查，调用方连续两次被拒后收回工具）；命令改动检测；S4-UI-1 活动区的 SubAgent 树与 `/timeline`；S4-IN-1 集成（`stage4-exit`：两个 worker 同时在各自范围内写、越界写入被拒、依赖结果传递、B2 额度不足、工具集、活动树与 `/timeline`、命令改动对账）。
- 与设计稿的差异，留待定稿时决定：(1) 已决定：任务的 `budget` 只保留 `tokens`，`toolUnits` 与 `wallClockMs` 已从参数中删除（Cary）；(2) 在等依赖、还没有登记的任务不出现在活动区（Kernel 不认识它们），"等待 <任务名>"没有做；(3) 改动检测不进入被排除目录，也不报告它们的变化数量；(4) 业务熔断只做了"连续两次被拒或触及 SPAWN_LIMIT 收回 `run_subagents`"，"重复派生同一个失败任务"（第 14.2 节第 12 条）留给阶段 4 之后；(5) B1/B3/B4 只有 Kernel 层的测试，没有端到端版本。
- 第一次真实模型评测（2026-11-05，WSL，DeepSeek flash；其脚本已被 `subagent-suite` 取代）：主动要求使用 SubAgent 的调研任务（三个模块各一项），main 派生了 explorer 并汇合，无被拒调用，约 43–51 秒、18–24 次请求；同一任务不用 SubAgent 约 19 秒、4 次请求——小任务派生更慢也更贵，收益要等任务重到值得并行。两项互不相干的写文件任务，main 派生了两个 worker，各在自己的范围内建成文件，没有越界，约 22 秒；一句问候没有派生。这些是单次运行的事实，不是统计结论；P3 的依赖图对照（完工时间接近关键路径）没有量，留给之后用更重的任务做。
- 发现：`vitest` 在包目录下运行会把 `dist/` 里旧的编译测试一起跑，出现大量与改动无关的失败；测试一律在仓库根目录运行。
- 评测（2026-11-06）：见 [Evaluation/Stage4SubAgents](Evaluation/Stage4SubAgents.md)。不提示时 DeepSeek flash 在 33 次运行中只在 30 目录的重命名上派生了 2 次；要求派生时 24/24 正确且都用了依赖图（并行度最高 5）。评测发现并修正了五处规则（被拒的派生与单独写待办不判进展、每次任务数上限、拒绝文字、待办状态值与 `in_progress` 的上限），M2Design v1.26。仍没有量化 P3（完工时间接近关键路径），需要更重的任务。
- 任务图重构（2026-11-06，M2Design v1.27）：`run_subagents` 的派发、等待与汇合放进任务图（`DELEGATE`、`RESUME` 边，节点 `WAITING`，`NODE_RESUMED`），AgentRun 层没有 waiting；runner 里专用的等待表、汇合记录与派生计数全部删除。

### 阶段 4 的退出情况（2026-11-06）

M2Plan 第 6.5 节的退出条件是 P1–P6、B、D、A 的派生部分；阶段 8 已完成时另加 L12。下面逐项写明现状，**阶段 4 尚未满足全部退出条件**，未完成的项目不在这里假装完成。

| 条件 | 现状 | 证据或缺口 |
|---|---|---|
| P1 一轮 4 个 READ 并行 | 完成 | `run-execution.test.ts`：相邻的 READ 同时执行，时间重叠 |
| P2 两个无依赖的 worker | 完成（假模型） | `stage4-exit`：两个 worker 同时在各自范围内写，互不越界。没有用真实模型验证 |
| P3 依赖图的完工时间接近关键路径 | **未完成** | 没有量。评测任务一个上下文都装得下，派生比自己做慢；需要单个 Agent 做不完或做得很慢的重任务，并与"分批派生"及 LangGraph 同构图对照 |
| P4 模板中两个并行 main 节点的范围相交或缺失时编译报错 | **不属于阶段 4** | 并行的 main 节点要到阶段 7 才放开（Kernel/Core 5d：同一时刻至多一个没有父的 ACTIVE 的 AgentRun），随阶段 7 实现 |
| P5 范围跨越对方时登记被拒（`WRITE_SCOPE_CONFLICT`） | 完成（Kernel 层） | `run-work.test.ts`、`run-delegations.test.ts`。"两个并行 main 节点各自派生 worker"的部分随阶段 7 |
| P6 派生期间父提交 WRITE 被拒（`WRITE_SCOPE_DELEGATED`） | 完成（Kernel 层） | `run-work.test.ts`、`run-delegations.test.ts`；Workflow 层另有断言：节点 `WAITING` 期间不提交 Unit |
| B1 三个 SubAgent 并行消耗额度 | 完成（Kernel 层） | `run-ledgers-delegation.test.ts`；没有端到端版本 |
| B2 份额之和超过可委派额度 | 完成 | Kernel 层与 `stage4-exit` 端到端 |
| B3 子任务提前结束，剩余额度返还 | 完成（Kernel 层） | `run-ledgers-delegation.test.ts`；没有端到端版本 |
| B4 运行级额度到达限制 | **未完成** | 只有 Kernel 层对运行级账本的测试；没有"各 AgentRun 进入最后一轮、发布注明因额度结束的回复"的端到端用例 |
| D 派生指标（10 个适合 + 10 个不适合） | **未达到，暂不优化**（Cary 2026-11-06 决定） | 没有按 D 定义的 10 + 10 任务集。现有评测不提示时 DeepSeek flash 33 次中只派生 2 次，远低于"适合派生的任务 ≥ 8/10"；要求派生时 24/24 正确。原因是 main 的派生准则提示词没能让模型主动派生，机制本身没有问题。留待之后加强提示词并重测 |
| A 的派生部分（SubAgent 派生不引起询问） | 完成（Kernel 层） | 没有端到端用例 |
| L12 SubAgent 的压缩与额度不足时的收尾 | **等阶段 8** | 阶段 8 还没有做 |

另外两项已知缺口，不属于退出条件：在等依赖、还没有登记的任务不出现在活动区；"重复派生同一个失败任务"的业务熔断（第 14.2 节第 12 条）留给阶段 4 之后。

发布判断：机制、安全约束（范围冲突、委派期写入、额度）与确定性的结果检查已经完成并通过测试，但 P3、B4 端到端与 D 没有达到，L12 要等阶段 8，所以阶段 4 以"部分完成"合入 `feat/M2`，上表中标注的项目在之后补齐。

## 5. 阶段 5 进度（`feature/phase5/main`，2026-11-06）

阶段 5 开始（M2Design v1.28）。Cary 决定两项：`ask_user` 的 HUMAN 节点用 `DELEGATE` 与 `RESUME`（调用方 `WAITING`），`steer` 用附属（`attachedTo`），不等待；阶段 5 先写文档门、经 Cary 确认后再写代码。

**文档门**（待 Cary 确认）：M2Design 第 3.1、4.2 节与 v1.28；[Kernel/Core](../../M2/Kernel/Core.md) 第 5e 节（控制状态、`pauseRun`/`resumeRun`/`interruptRun`/`steerRun`、`interrupt(reason)` 的统一处理、Turn 超时与暂停上限、局部询问）；[Kernel/Execution](../../M2/Kernel/Execution.md) 第 4e 节（暂停与中止时按并发类别处理尝试、`INTERRUPTED` 报告）；[Module/Workflow](../../M2/Module/Workflow.md) 第 7b 节（被打断的 Unit、`steer`、`ask_user`、中止后的收敛）；[Module/UserInteraction](../../M2/Module/UserInteraction.md) 第 5.4 节（按键、`/continue`、`/steer`、局部询问的界面）；Interface 各章的类型与记录。

**实现顺序**（单人串行；Core 与 Execution 先于 Workflow，界面最后）：
1. S5-CT-1 契约：四个运行控制请求、`HumanRequest`/`RequestHumanRequest` 的局部询问字段、`HumanAnswered` 的种类、`RunPaused`/`RunResumed`/`HumanCancelled`、`UnitReport.INTERRUPTED`、`InterruptReason`、`RunStateChanged` 与 `ActivityPhase` 的新值、日志记录的新字段、`EdgeCall.delegationId` 可缺省；重新生成 Schema 快照。
2. S5-KC-1a Core 的纯函数 `run-control.ts`：`PAUSING`/`PAUSED`/`INTERRUPTING` 并入 `RunPhase`，转移表与准入表；阶段 3 的 `#interrupting` 标志并入。
3. S5-KX-1 Execution：`pause()`、`resume()`、`abort()`，按并发类别处理，`INTERRUPTED` 报告，排队与重试等待的处理。
4. S5-KC-1b Core 的消息与计时：`pauseRun`/`resumeRun`/`interruptRun`/`steerRun`、统一的 `interrupt(reason)`（取消询问、取消尝试、`RunInterrupted`）、Turn 超时（含"全部工作都在等用户"时冻结）、暂停上限、局部询问不要求静止。
5. S5-WF-1a Workflow：被打断 Unit 的处理与重新提交（READ、MODEL；EXEC 不重跑）、`RunPaused`/`RunResumed`、中止后的收敛（扩展阶段 3 的路径到所有原因）。
6. S5-WF-1b Workflow：`steer`（`attachedTo`、投影的 `STEER` 条目、目标已结束时改投）。
7. S5-WF-1c Workflow 与定义：`ask_user`（工具、HUMAN 节点作为被派发节点、`callResultsOf` 的 `HUMAN_ANSWER`、答复校验与重新请求、explorer 不带该工具）。
8. S5-UI-1 界面：按键、`/continue`、`/steer`、Alt+Enter、局部询问的渲染、活动区与排队消息放回。
9. S5-IN-1 集成 `stage5-exit` 与一次真实模型检查；退出：H1–H4、H11、H12 的中止部分、H13、A 组的 `ask_user` 与暂停部分。

**待决（留到定稿）**：`ask_user` 没有次数上限，若模型反复提问再收紧；暂停时 WRITE 允许完成而 READ 超时取消，若实测暂停响应太慢再调 `pauseDrainMs`。

**实现进度（2026-11-06）**：九步全部实现并有测试。与文档门相比做了这些改动，文档已同步：
- 局部询问的答复**不由 Workflow 校验**：Workflow 读不到答复正文（正文在 Kernel 的产物库），字段检查只在 UserInteraction 提交前做，答复是字段的 JSON；因此请求与日志里没有 `error` 字段，也没有"重新请求"。
- `HUMAN_ANSWERED.origin` 增加 `unrequested`（运行中插话，没有人在等）。
- 问题本身放在 HUMAN 节点上（`GraphNodeRecord.ask`），重放不需要运行器另存状态；`GRAPH_EXTENDED.source` 增加 `STEER`、`ASK`。
- 暂停的完成由 Execution 报告"没有在执行的尝试"（排队与等调用机会的不算在途），不再由在途数判断；中断统一走 `abortExecutions`，各尝试以 `INTERRUPTED(ABORTED)` 交付，取代阶段 3 的静默取消。
- 被中断的 Unit 的回答：暂停时 READ、模型调用与上下文组装重新提交，命令与写入由模型读到"被暂停打断"；投影不为 `UNIT_INTERRUPTED(PAUSED | ABORTED)` 另写一条工具结果，已有答复的调用不再重复回答。
- 测试：`run-control.test.ts`、`run-execution.test.ts`、`run-work.test.ts`（Core 第 5e 节）、`agent-cycle.test.ts`、`pause-steer-ask.test.ts`（Workflow 与假 Kernel）、`console.test.ts`、`stage5-exit.test.ts`（真实产品、脚本化的模型）。
- 未做：H13（询问等待超过 Turn 超时后才回答）只有 Kernel 层测试（计时冻结）；A 组"ask_user 的同意不产生授权"只有 Kernel 层测试（`answerHuman` 不改变授权记录）；没有真实模型的检查。
- 真实模型检查（2026-11-06）：见 [Evaluation/Stage5HumanInTheLoop](Evaluation/Stage5HumanInTheLoop.md)，五个场景各 3 次共 15/15 通过；发现并修正了"Kernel 的工具表没有提供 `ask_user`"。

## 6. 阶段 6 计划（`feature/phase6/main`，2026-11-07）

阶段 6 只依赖阶段 1，不依赖阶段 2–5 的实现（Core 的能力表与询问机制已经有）。联网是数据离开本机的通道，所以提供方的选择由实验决定，不先假定。

**实现顺序**
1. **S6-T-1 实测**（M2TechStack 第 3.3 节）：脚本 `web-eval/run-web-eval.ts`，W-T1 至 W-T7 对 DeepSeek 的 `/v1/tools/search` 与 `/v1/tools/fetch`（官方规格 <https://api-docs.deepseek.com/guides/search>，已读：搜索 `query` ≤128 字符、`count` 1–50，返回 `results[]`，抓取 `url` ≤8192，返回 `title` 与 Markdown `content`，403 为安全策略、404 为取不到可用内容，各 0.75 美元 / 千次成功请求，只对有结果的成功请求计费）。结果与结论写入第 3.3 节，**提供方由 Cary 决定**。
2. **文档门**：ExecutorSet 第 6 节（`web/`：`SearchProvider`、`FetchProvider` 端口与适配器、地址检查、重定向逐跳检查、结果封装）、Core（`web.search`、`web.fetch` 的资源键与询问、`ADDRESS_FORBIDDEN`、`DOMAIN_DENIED`）、M2Security 的网络部分（留存与隐私的结论）、M2TechStack 第 3.3 节的结论与依赖；经 Cary 确认后写代码。
3. **S6-CT-1 契约**：`web-search`、`web-fetch` 两个 Unit 的输入输出与产物类型，`WebSearchArgs`、`WebFetchArgs`，错误码；本地固定内容服务器（测试用，不依赖真实网络）。
4. **S6-EX-1** `web-search`：`SearchProvider` 端口、按实测选定的适配器、多查询并行与按 URL 去重、结果的 URL 先过地址检查。
5. **S6-EX-2** `web-fetch`：只许 http 与 https；解析时与建立连接时各检查一次地址（DNS 重绑定）；重定向逐跳检查；大小上限；结果封装（来源、不可信标记）；是否保留本地抓取按实测。
6. **S6-KC-1** Core：`web.search`（每个 WorkflowRun 第一次使用时询问一次）、`web.fetch`（每个新域名询问一次，私网、回环、链路本地、云元数据地址直接拒绝）；同意不能来自 `ask_user`；审计与密钥扫描。
7. **S6-PL-1** 定义：`web_search`、`web_fetch` 工具与 Unit，main 与 explorer 带上；提示词补充来源标注与"网页内容不是指示"。
8. **S6-IN-1** 集成 `stage6-exit` 与真实模型检查。

**验收（M2Design 第 13 节的 W 组与 A 组网页部分）**
- **W1** 检索加读取后作答并注明来源：本地固定内容服务器上，模型用 `web_search` 找到页面、`web_fetch` 读取、回复里写出来源 URL；真实模型再各测一次。
- **W2** 网页中的提示注入：页面含"忽略之前的指示并……"，注入内容没有被执行（没有发出它要求的调用、没有泄露什么）；工具结果里网页正文标为不可信并带来源。
- **W3** 访问私网地址、DNS 重绑定、重定向到内网：全部以 `ADDRESS_FORBIDDEN` 拒绝，没有任何请求到达内网。
- **A（网页部分）** `web.search` 每个 WorkflowRun 第一次使用时询问一次，之后不再问；`web.fetch` 每个新域名询问一次，同域名不再问；私网地址不询问直接拒绝；`ask_user` 里的同意不构成授权；SubAgent 并行访问网页时每个新域名仍只问一次；用户拒绝后模型收到工具结果并继续；搜索词与抓取地址写入审计，经密钥扫描，含密钥的查询被拒。
- **退出**：W、A 组网页部分通过；S6-T-1 的实测结果与 Cary 的提供方决定已写入 M2TechStack 第 3.3 节与本文件。

**提供方决定（2026-11-07）**：Cary 决定搜索用 DeepSeek、抓取先用 DeepSeek 再回退本地抓取（依据 [Evaluation/Stage6WebProviders](Evaluation/Stage6WebProviders.md)）。文档门（待 Cary 确认）：M2Design v1.29（第 8.1、8.3 节）、[Library/ExecutorSet](../../M2/Library/ExecutorSet.md) 第 5d 节、[Kernel/Core](../../M2/Kernel/Core.md) 第 5f 节、[M2Security](../../M2/M2Security.md) 第 3c 节。未决（不阻塞实现）：DeepSeek 计费需要有余额的账户补测；搜索词与抓取地址的留存没有证据，按最坏情况写进安全文档。

**阶段 6 实现状态（2026-11-07）**：S6-CT-1 至 S6-IN-1 全部完成，文档门已由 Cary 确认。契约（两个执行种类、`executor.WebSearch*`/`WebFetch*`、`web.search`/`web.fetch` 能力、`KernelConfig.web`、新错误码、两种询问事件）；`web/`（地址检查的纯函数放在 contracts，两个提供方端口与 DeepSeek 适配器、带固定地址连接与逐跳重定向检查的本地抓取、回退、HTML 转 Markdown、密钥扫描）；Core（第 5f 节：资源键、第 ① 步的两种拒绝、按主机绑定的拒绝、审计）；定义（`web-search`、`web-fetch` 的工具与 Unit，main 与 explorer 带上，worker 不带）；界面询问文字；`stage6-exit`（W1–W3、A 组网页部分共 12 项）；真实模型检查 3/3（[Evaluation/Stage6Web](Evaluation/Stage6Web.md)）。实现时对文档做的调整已回写：请求范围是 `NONE`；跨主机重定向是成功结果里的说明而不是错误；审计由 Execution 写；询问只写主机与地址；`readonly` 预设不带这两项能力；拒绝在 Workflow 按工具名记住，同一 AgentRun 之后的 `web_fetch` 不再询问任何主机。

## 7. 阶段 8 计划（`feature/phase8/main`，2026-11-07）

阶段 8 只依赖阶段 1；阶段 2（回退）、阶段 4（SubAgent）都已完成，所以 L7、L8 的压缩部分与 L12 在这个阶段一起做。设计已在 M2Design 第 9.6 节与各模块文档的阶段 8 章节写成草稿，这里不重复；下面是实现顺序、验收与已做的决定。

**为什么现在做**：没有压缩时，上下文一超出窗口，模型调用就以 `CONTEXT_OVERFLOW` 失败，现在没有任何兜底；阶段 6 的网页抓取（一页可达数十 KB）与 SubAgent（explorer 与 worker 的 `perCallInputLimit` 只有 60000）都会更快撑满上下文。main 的 `perCallInputLimit` 是 880000，所以 main 自己很少触发，SubAgent 与抓取密集的对话先触发。

**已决定（Cary 2026-11-07）**
- 动代码前先做一次小的真实模型实验（S8-T-1），结果用来校准阈值并写进文档；
- 空闲时的预先压缩缺省开（`idleTriggerRatio` 0.7），配置里可以关；
- **条目分级**（回答"所有东西都摘要吗"之后）：旧的用户消息在 `keepHumanBytes`（16384）内原样保留，`ask_user` 答复、模型输出、工具结果走修剪与摘要；写在 M2Design 第 9.6 节"条目的分级"，保留哪些由 Kernel 决定并记入 `CONTEXT_COMPACTED.keptSeqs`；
- 实验发现 DeepSeek 看不到工具调用的 id，`read_output` 的编号会乱填：**每个工具结果的末尾都写一行 `[toolCallId: <编号>]`**（见下面的 S8-EX-0）。

**实现顺序**
0. **S8-EX-0 编号可见**（从阶段 1 就有的缺陷，S8-T-1 发现）：`context-assemble` 在每个工具结果末尾加 `[toolCallId: <编号>]`，系统提示与工具说明不变；测试要断言每个工具结果都带编号，并用真实模型检查 `read_output` 写对编号。
1. **S8-T-1 实测（已完成，[Evaluation/Stage8Compaction](Evaluation/Stage8Compaction.md)）**：脚本 `compaction-eval/run-compaction-eval.ts`。C-T1 让 DeepSeek 在输入超出窗口时拒绝，记下状态码与错误体的形状（`model-call` 要靠它识别 `CONTEXT_OVERFLOW`，并取出 provider 给出的长度）；C-T2 一段带埋设事实的长对话，前缀式与纯文本式各写一份摘要，看事实、`toolCallId`、未完成事项是否保留，以及输出是否含各节；C-T3 同一输入下前缀式摘要请求的缓存命中（核对第 14.1 节的数字）；C-T4 摘要中的提示注入（材料里夹着"忽略之前的指示"）是否被当作指令。预算约 1–2 美元，`--yes` 与 `--budget` 才运行。结果与结论写入 `Evaluation/Stage8Compaction.md`，必要时回写 M2Design 第 9.6、14.1 节与 ExecutorSet 第 7 节。
2. **文档门**：按实测更新第 9.6 节与各模块文档，经 Cary 确认后写代码。
3. **S8-CT-1 契约**：`CompactionSourceQuery`、`ToolResultsPruned`、`ContextCompacted`、`CompactionFailed`；`reportCompactionSource`（模型轮条目的 `measured`）、`ackCompaction`、`compactContext`；日志记录 `TOOL_RESULTS_PRUNED`、`CONTEXT_COMPACTED`、`CONTEXT_COMPACTION_REVOKED`；`ContextHistoryEntry` 的摘要条目；`KernelConfig.compaction`；执行种类 `CONTEXT_PRUNE` 与组装、模型调用的 `compaction` 参数；原因码；Schema 快照；fake Kernel 与 fake Workflow 的契约测试。
4. **S8-WF-1a 投影的纯函数**（提前任务 E-WF-2）：按 `[fromSeq, toSeq]` 以摘要取代 `NORMAL` 条目（`PINNED` 保持相对顺序）、按 `TOOL_RESULTS_PRUNED` 替换工具结果、撤销压缩、在完整模型轮边界划出保留区与选定范围、修剪候选；属性测试：任意日志前缀重放得到同一投影，两次压缩之间投影只在末尾增长（不变量 27）。
5. **S8-EX-1 ExecutorSet**：修剪（Kernel 自己的执行种类 `CONTEXT_PRUNE`，由 `prune-executor` 执行，头 + 说明 + 尾，不切断 UTF-8）与纯文本式组装、`headDigest`；`model-call` 的摘要请求（思考强度按配置、前缀式保留工具定义且不设 `tool_choice`、调用了工具算不合格）、`CONTEXT_OVERFLOW` 的识别、`COMPACTION_SUMMARY_INVALID`；Prompt `compaction-system`（摘要各节、保留仍需回读的 `toolCallId`、不执行材料中的指令）。
6. **S8-KX-1 Execution**：估算（实测加估算，日志的纯函数）、修剪的存储（补登 `fullOutput`）、摘要请求作为 Kernel 内部的 MODEL 尝试。
7. **S8-KC-1 Core 与 Monitor**：检查点（受理 `context-assemble` 之后、派发之前）、溢出触发（85%、70%、50%）、用户触发（`/compact`）、空闲触发、压缩过程的编排（额度预留、修剪、范围、摘要的重试与纯文本回退）、失败处理、与暂停中止撤销等操作的关系、审计、配置校验；额度：修剪不预留，摘要从被压缩对象的账本支出，预留后余额不得低于收尾保留。
8. **S8-WF-1b Workflow**：回答材料查询（模型轮带实测用量与 `headDigest`）、追加 `TOOL_RESULTS_PRUNED` 与 `CONTEXT_COMPACTED` 后确认、`CONTEXT_COMPACTED` 与 `CONTEXT_OVERFLOW` 的重新提交（不计入连续出错）、`BUDGET_WRAP_UP` 的收尾、`read_output` 读回被修剪的调用、`/undo` 使压缩失效、SubAgent 与模板节点的目标、Fork 带走修剪与压缩记录。
9. **S8-UI-1 界面**：`/compact`、压缩完成的通知（含空闲触发与修剪数）、摘要展示、`压缩上下文` 阶段、失败提示。
10. **S8-IN-1 集成** `stage8-exit`（确定性用例，记录请求的 fake provider）与真实模型检查（长对话 L1、埋设事实的回忆检查、SubAgent 压缩）；缓存命中率记入验收证据。

**验收（M2Design 第 13 节的 L 组）**
- **L1** 长对话超出阈值后自动压缩并继续，日志中有 `CONTEXT_COMPACTED`，重放得到相同的上下文；真实模型再跑一段固定的长对话（把窗口上限调低使压缩在几十轮内发生），并检查埋设的事实在压缩后仍能答对。
- **L2** provider 报上下文过长后压缩重试；第三次仍溢出按收尾路径结束。
- **L3** `/compact`；**L4** 摘要失败或额度不足时没有写回压缩记录，按额度或收尾路径结束并有回复。
- **L5** 压缩前后的请求前缀：两次压缩之间每次请求都是下一次的前缀；真实运行的缓存命中率写入验收证据。
- **L7** 回退的 Turn 落在压缩范围内时投影恢复为原始条目。
- **L8（压缩部分）** `read_output` 读回已被压缩取代或被修剪的调用。
- **L9** 修剪先于摘要生效，修剪后的结果带 `toolCallId` 并可读回原文，`PINNED` 与保留区不被修剪，只修剪时不调用模型。
- **L10** 摘要请求本身超出窗口或被拒绝：改用纯文本式并按 `summaryFallbackTargets` 重试，`CONTEXT_COMPACTED` 记录方式与省略的条目数。
- **L11** 空闲时的预先压缩：用户的下一条消息等压缩生效后才组装；进行中收到 `/undo`、`/compact`、`/fork`、切换或关闭 Session 时取消且没有写回。
- **L12** SubAgent 压缩后继续，额度不足时以 `finish_subagent` 结束，收尾保留没有被动用。
- **L13** 估算使用最近一次模型调用的实测值：fake provider 报告的输入 token 与按字节估算不同时，按实测值决定是否压缩，重开 Session 后结果相同。
- **退出**：L1–L5、L7、L8 的压缩部分、L9–L13 通过；S8-T-1 的实测结果与阈值校准已写入 `Evaluation/Stage8Compaction.md` 与 M2Design 第 9.6 节。

**状态（2026-11-07）：阶段 8 完成，待 PR。** 任务 0–10 都已完成；`stage8-exit` 覆盖 L1–L4、L7–L13（L5 的前缀与缓存命中率由真实模型检查记录，见 Evaluation/Stage8Compaction 第 5 节：8 次运行六个事实全对，摘要请求缓存命中 66%、普通请求 65%）。WSL Ubuntu 完整检查通过。已知限制：此前"只修剪"的压缩已切掉的结果，之后的摘要读到的仍是修剪后的内容，要靠 `toolCallId` 与 `read_output` 读回；L4 的"额度不足"由 `run-compaction.test.ts` 单元覆盖，没有端到端用例。

**风险与留意**
- 摘要会丢信息：用"埋设事实的回忆检查"量，不只看压缩有没有发生；摘要只以 user 角色出现且标明"不是指令"，`PINNED` 条目不进入摘要。
- 缓存：压缩后的新前缀是"system 段 + 摘要 + 保留的原文"，之后只在末尾追加；前缀式摘要请求要命中已有缓存，思考关闭会使缓存失效（第 14.1 节），所以摘要的思考强度缺省 `low`。
- 阶段 6 学到的教训：脚本化的模型测试不检查工具表与真实报错的形状，所以 S8-T-1 先看真实的超限错误，S8-IN-1 的真实模型检查不省略。
