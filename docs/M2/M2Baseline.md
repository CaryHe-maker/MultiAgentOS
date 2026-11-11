# MultiAgentOS M2 现状基线

> 2026-11-07，`feat/M2` 合入压缩与阶段整理之后。本文是 [M2ReleasePlan](M2ReleasePlan.md) 的起点：已经做到什么、证据在哪里、还差什么。
> 它只描述现状，不描述计划；机制以 [M2Design](M2Design.md) 为准。旧的阶段计划与进度已冻结在 [History/M2](../History/M2/README.md)，本文不再使用旧的阶段编号。

## 1. 口径

- **已实现**：代码在 `feat/M2`，有确定性测试（假模型、假 provider、假时钟），在 Ubuntu 24.04（WSL）与 GitHub Actions 的质量门中通过。
- **真实模型已验证**：另在真实模型（`deepseek-flash`）上跑过，当时的数字与结论记录在 [History/M2/Evaluation](../History/M2/Evaluation/)；原始记录与脚本已随评测体系的重建删除（[Evaluation](Evaluation.md)）。这些数据来自单个模型与少量运行，不是统计结论。
- **缺口**：设计里要求、尚未做到的部分。第 5 节汇总。
- 质量门：约 150 个测试文件、约 2410 个用例，在 Ubuntu 24.04（含 WSL2）上全部通过。**Windows 原生不是支持平台**（[M2Decisions](M2Decisions.md) 2a）：那里还有几个与符号链接、第二个实例的检测和进程退出码相关的用例失败，不算缺陷（缺口 17 是真实模型测试时顺手修的，不代表适配 Windows）。冻结的系统测试另有 phase 发布检查（[M2FrozenTests](M2FrozenTests.md)）。

## 2. 能力现状

| 能力 | 状态 | 证据 | 缺口 |
|---|---|---|---|
| Session、Turn、Turn-chat（`chat`）、开放输入、日志的写入与恢复、Fork、实例锁 | 已实现；真实模型已验证 | `chat-exit`；`analyze` 回归 F1–F5 5/5，49 条结论全部带已核验来源 | 无 |
| 上下文投影、可重建性、思考模式、预览与完整输出 | 已实现 | 投影的属性测试（日志前缀重放得到同一投影）；缓存命中率 77%（`analyze`） | 无 |
| 写入与回退：`write_file`、`edit_file`、`/undo`、`/diff`、快照、子目录 `AGENTS.md` | 已实现；真实模型已验证 | `write-undo-exit`；写入任务 39/40，main 写入 6/6 | 真实仓库任务大多在写入前被上下文上限叫停，已由放宽上限与压缩缓解，没有重测 |
| 命令与沙盒：bwrap、`run_command`、`git_inspect`、命令拆分与 ARITY、敏感文件遮蔽、停机 | 已实现；真实模型已验证 | `command-sandbox-exit`；C1–C4 自动挂载后 12/12；C5 确定性用例 | 沙盒没有 CPU 与内存总量限制（无 cgroup 权限时做不到，只有超时兜底）；内存压力的 DANGER 退出只有确定性测试，没有在真实内存压力下验证 |
| 并行：按 AgentRun 分队列、写入占用、额度逐级委派、`run_subagents`、结果契约 | 已实现；机制已验证 | `subagents-exit`、Kernel 层测试；要求派生时 24/24 正确 | P3（完工时间接近关键路径）没有量；B4 没有端到端用例；D（派生指标）不达标：不提示时 33 次只派生 2 次 |
| SubAgent 的结果交接：`summary` 与 `report` 两段、引用登记表（`REFERENCES_REGISTERED`、`ref_N/toolCallId`）、`retainArtifacts`、上下文包随模型调用结束释放（`ONCE`） | 已实现；真实模型已验证（`subagents.report` 1/1） | `subagents-exit`、`subagents.test.ts`、`handover` 的单元测试 | 前驱任务的结果交给后继任务（`dependsOn`）未做 |
| 在别的文件夹里打开 Session：确认、`WORKSPACE_BOUND`、按文件夹的纪元、快照与项目指令随文件夹重置 | 已实现 | `workspace-switch-exit`（13 个场景）、`workspace-binding.test.ts`、`workspace-snapshots.test.ts` | 信任文件夹的提示（WS-1）、切换时的压缩未做 |
| 读工作区之外的文件：`external.read`、三个外部读取工具、授权目录、拒绝名单、连续两次失败暂停 | 已实现；真实模型已验证（`external.read`、`external.trap`、`external.windows`，各自小样本） | `external-read-exit`（X1–X3）、`external-read.test.ts`、`external-scope.test.ts` | 连续两次失败暂停没有在真实模型上触发过 |
| 人类在环：暂停、继续、`/steer`、中止、`ask_user` | 已实现；真实模型已验证 | `human-in-loop-exit`、`pause-steer-ask.test.ts`；5 个场景 15/15 | H13 与"`ask_user` 的同意不产生授权"只有 Kernel 层测试；`ask_user` 没有次数上限 |
| Web：`web_search`、`web_fetch`、地址检查、重定向与 DNS 重绑定 | 已实现；真实模型已验证 | `web-exit`；3 个场景 3/3（含注入页面与私网地址） | Brave 适配器只用假实现测过；`readonly` 预设不含网页；DeepSeek 抓取的计费与搜索词留存没有证据；Workflow 在同一 AgentRun 内记住被拒的工具 |
| 上下文压缩：自动、溢出、`/compact`，修剪与摘要，撤销时使摘要失效 | 已实现；真实模型已验证 | `compaction-exit`（L1–L4、L7–L21：刚新建就压缩、打开旧对话后压缩与再压缩、重开后压缩与 Fork、反复压缩、打开时已超阈值、压缩中来消息、被拒、被 Fork 取消）；真实模型：长对话六个事实 8/8，新建即压缩、打开旧对话后压缩、反复压缩、压缩后重开均通过，摘要请求缓存命中约 99.8% | 早先只修剪的压缩切掉的结果，之后的摘要仍读到修剪后的内容；压缩后上下文没有硬上限（最新一段不受压缩影响）；"额度不足"只有单元测试 |
| 终端交互：控制台、`/help`、`/status`、`/timeline`、`/output`、`/undo`、`/diff`、`/compact` | 已实现 | `console` 的单元与验收测试 | 图视图等非安全功能未做 |
| 日志查看器 `mas log`、思考的流式显示（回复不流式）、状态行与上下文占比、带光标的输入框、字符宽度的启动测量 | 已实现 | `log.test.ts`、`thinking-stream`、`ink-*.test.ts`、`input-box-ink*.test.ts`、`terminal-width.test.ts`（[Phase1Console](Phase1Console.md)） | 授权与工作区、并行优化未做；白底终端的配色未定 |
| 使用者模板、条件边、有界循环、`all_done`、`mas run`、`/run`、`research` 模板 | **未做** | 仅内置 `chat`、`analyze`；`analyze` 用到条件边 | 整块工作，见 [M2ReleasePlan](M2ReleasePlan.md) phase 2 |
| 并行的 main 节点（P4、P5 的并行节点部分） | **未做** | 没有模板就没有并行 main | 随模板一起做 |
| Agent 与 Prompt 定义（main、explorer、worker、planner、code-viewer、`compaction-system`） | 草稿 `v0.1.0`；main 已验证 | AgentToolPool 第 3 节 | 其余未经评测定稿；没有固定任务集可比较版本 |

## 3. 验收组现状（M2Design 第 13 节）

| 组 | 现状 |
|---|---|
| R `analyze` 回归 | 通过（F1–F5 5/5） |
| C 编程任务与安全陷阱 | C1–C4 真实模型通过（写入 39/40、自动挂载后 12/12）；C5 确定性用例 100% 拦截。C1–C4 没有按"每个任务 5 次、至少 4 次成功"的发布口径重跑 |
| P 并行 | P1、P2、P5（Kernel 层）、P6（Kernel 层）完成；P3 未量；P4 随模板 |
| D 派生指标 | 未达标，暂不优化 |
| H 人类在环与回退 | 确定性用例完成；H13 只有 Kernel 层测试；真实模型检查覆盖暂停、插话、中止、`ask_user` |
| G 工作流 | G1 完成；G2–G4 需要使用者模板；G5（任意日志前缀重放）对已有模板完成 |
| B 额度 | B2 端到端；B1、B3 只有 Kernel 层；B4 未做端到端 |
| A 授权 | 完成；派生部分只有 Kernel 层 |
| W 网页 | 通过 |
| O Turn-chat 与 `research` 对比 | 未做 |
| L 上下文 | L1–L5、L7–L13 完成；L6（产物回收）在已有测试中覆盖，随发布时再核对 |
| S 恢复与实例锁 | 完成 |

## 4. 真实模型评测汇总

| 评测 | 结果 | 记录 |
|---|---|---|
| `analyze` 回归 F1–F5 | 5/5，49 条结论带来源，缓存命中 77% | 本地记录，已不在仓库 |
| 写入任务 | 39/40；main 写入 6/6 | 记录与脚本已删除 |
| 命令任务 C1–C4（自动挂载） | 12/12，约 $0.018 | 同上 |
| SubAgent | 要求派生 24/24；不提示 2/33；小任务派生比自己做更慢更贵 | [Stage4SubAgents](../History/M2/Evaluation/Stage4SubAgents.md) |
| 人类在环 | 5 个场景 15/15 | [Stage5HumanInTheLoop](../History/M2/Evaluation/Stage5HumanInTheLoop.md) |
| Web | 3 个场景 3/3 | [Stage6Web](../History/M2/Evaluation/Stage6Web.md)、[Stage6WebProviders](../History/M2/Evaluation/Stage6WebProviders.md)、[Stage6FetchOrder](../History/M2/Evaluation/Stage6FetchOrder.md) |
| 上下文压缩 | 长对话六个事实 8/8；两处缺陷由这次评测发现并修复 | [Stage8Compaction](../History/M2/Evaluation/Stage8Compaction.md) |

这些评测的共同点：每次真实模型检查都发现了脚本化测试看不到的问题（工具表缺 `ask_user`、模型看不见调用 id、抓取顺序、摘要读到已修剪的历史）。
这些评测当时各有各的运行器，现在由统一的[评测体系](Evaluation.md)取代；这张表是历史基线，新的基线（基线 1、基线 2，见 M2ReleasePlan 第 3a 节）在 phase 1、2 按各模式的任务集记录。

## 5. 已知缺口与遗留

已经决定"暂不做"的不在此列（见 M2Design 第 14.2 节；发布时汇入 `M2Limitations.md`）。

**功能**
1. 使用者模板、条件边、有界循环、`all_done`、`mas run`、`/run`、`research` 模板、并行的 main 节点。
2. 派生指标 D 不达标：main 的派生准则没能让模型在适合的任务上主动派生。
3. P3、B4 端到端、H13 与 `ask_user` 授权的真实模型检查。
4. 在等依赖、还没有登记的任务不出现在活动区；"重复派生同一个失败任务"的业务熔断。

**安全与健壮性**
5. 沙盒没有 CPU 与内存总量限制；内存压力的 DANGER 退出只有确定性测试，没有在真实内存压力下验证。
6. 压缩之后的上下文没有硬上限：最新一段（`keepRatio` 0.15，约占单次输入上限的 15%）不受压缩影响，极大的工具结果会使压缩帮不上忙，只能收尾。
7. 早先只修剪的压缩切掉的结果，之后的摘要读到的仍是修剪后的内容，要靠 `toolCallId` 与 `read_output` 读回。
8. 网页：Brave 适配器没有对真实服务测过；`readonly` 预设不含网页；Workflow 在同一 AgentRun 内记住被拒的工具。
9. 提示注入只试过少数几种写法，且模型这几次识破了；防线不依赖模型的判断，但没有系统的对抗用例集。

**评测与流程**
10. 评测体系已建立，但 Turn-chat 与预置工作流的任务集和基线还没有；C1–C4 没有按发布口径重跑；成本与延迟没有记录成回归门槛。
11. 发布文档（`M2Usage.md`、`M2Limitations.md`、验收证据）没有开始。
12. 实体机（非虚拟机、`generic` 内核）上的沙盒行为没有复核；CI 的 `phase-gate` 任务第一次运行还要看结果。

13. 代码里以 `agent.id === 'main'` 识别"顶层的对话 Agent"的地方有五处（压缩目标 `MAIN`、子目录 `AGENTS.md` 的范围、`read_output` 的范围、启动检查）。设计假定只有一个顶层的对话 Agent；预置工作流里有多个顶层 AgentRun 时，要把"顶层"改成不依赖名字的概念（phase 2 的设计项）。
14. 协议注册表里有一批只登记、从不使用的"暂不支持"引用族（检查点、恢复、人工审阅、集成、日志位置、保留令牌、消费者位移，SharedContracts 3.9 为长期架构预留）。它们不进入任何产品路径，是否在 M2 发布前删除由负责人决定。
15. **日志里的 `MODEL_TURN.usage` 曾经从未被写入（已修，2026-11-08）。** 记录格式一直有这个字段，压缩的"实测词元数"（`measured`）和评测的词元、成本、缓存命中都从它读取，但 Kernel 给 Workflow 的 `UnitReport` 不带用量，Workflow 写 `MODEL_TURN` 时也没有填；所以压缩一直用估算而不是实测，`metricsOf` 对真实运行得到的词元为 0、成本为空（评测体系自己的测试用手写记录，没有发现）。现在 `UnitReport` 带可选的 `usage`，Workflow 写进 `MODEL_TURN.usage`，有测试：Workflow 的记录带用量、一次脚本对话的日志里每次模型调用都有用量、评测从真实日志读到词元。旧的日志没有这个字段，读取方仍然按"没有"处理。
16. `mas run --repo` 与 `--readonly` 曾被程序级选项吞掉（已修：`enablePositionalOptions`，有回归测试）。
18. **Windows 原生不支持（已决定，不是缺口）。** 沙盒是 bubblewrap，只有 Linux 有；Windows 原生探测为 `NO_BWRAP`，按设计拒绝运行命令，不降级。M2 只支持 Linux 与 WSL2，写入 [M2Decisions](M2Decisions.md) 2a 与 README；不做原生沙盒，也不做"不运行命令"的原生模式。
17. **Windows 上 `search_repository` 的 SYMBOL 与 TEXT 搜索一直返回"没有匹配"**：`rg` 在 Windows 上输出 `.\src\a.ts`，而结果按 `./` 去掉前缀，路径对不上文件集，所有匹配被丢弃（真实模型运行时发现；目标平台 Ubuntu 不受影响）。已修（`search-backends.ts`），原有的"rg 与扫描一致"用例在 Windows 上也通过了。

## 6. 静态审核记录

2026-11-08，phase 0 的整体审核（此前只有阶段 2、3、4、8 各做过一次，阶段 1、5、6 没有）。范围与做法：

- **机械扫描整个代码库**（约 4.1 万行产品代码）：没有使用的导出、从未读取的配置项（0）、从未使用的原因码（0）、不安全的类型转换、被吞掉的错误、重复的实现、旧阶段标记与旧文档路径、指向不存在的文档章节的代码注释。
- **逐段阅读安全相关的路径**：授权判定（`unit-decision`）、命令执行前后的保护检查、沙盒扫描、被吞掉错误的各处。没有逐行读完全部代码，这一点不声称。

发现并已修复：

1. 命令执行前的"受保护路径快照"失败时，命令仍然照常运行，事后无法把命令在受保护位置新建的东西拿走（不变量 16）。现在改为拒绝运行（`ADMISSION_CHECK_FAILED`），并有测试。
2. 退出码 75 在契约里是常量、在控制台里又写死一遍，改为同一个常量。
3. 一个没有任何引用的函数（`displayPath`）删除。
4. 节点编号的推导与三处直接调用 `createHash('sha256')` 的重复实现，改用契约里的 `pathDerivedId` 与 `sha256Hex`。
5. 代码注释中 4 处指向不存在章节的文档引用；M2 的 AgentToolPool 文档缺少模型价目一节（只在归档的 M1 文档里），补上第 5a 节。
6. 测试夹具：脚本化 provider 的响应格式与请求路由各写了两份，合并为 `test/support/scripted-model.ts`；五处"列出 Session 后等 100 毫秒再 `/resume`"改为等到列表真的显示出来。

仍然开着的，记在上面的缺口 13、14；15、16、17 已修复，18 已决定不适配。

## 7. 本文怎么用

- [M2ReleasePlan](M2ReleasePlan.md) 的每个 phase 开始时，核对本文的对应行；结束时更新本文，而不是另写进度文档。
- 缺口一经修复，从第 5 节删除并更新第 2、3 节；新发现的缺口追加到第 5 节。
- 本文不记录计划、顺序与日期，那些写在 M2ReleasePlan。
