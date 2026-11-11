# Phase 1 实验记录

每次实验写下：目的、参数（系统版本、模型、题、限制）、结果、发现、随后的改动。结果的原始数据在 WSL 的 `~/bench/results/results.jsonl`（每次运行一行）与各运行目录（指令、Agent 输出、验收输出、`mas` 的会话日志、`dsh` 的接口用量）；汇总用 `scripts/taskset/summarize.mjs`。

## 通用参数（除非某次实验另写）

| 项 | 值 |
|---|---|
| 模型 | `deepseek-flash`（`mas` 默认；`dsh` 默认） |
| `mas` | 提交 `15e077b07fa6` 加工作区未提交的改动（见各次实验）；定义摘要 `41a7f4d8d8b0f485`；由 `apps/control-plane/test/eval/bench.ts` 在容器里驱动；沙盒不可用时走 `ask-unisolated`（每条命令问一次授权，评测方一律回答允许） |
| `dsh` | `@deepseek-ai/dsh` 0.2.2-rc.1，`--profile headless "<指令>"`，`DSH_HOME` 为容器内临时目录，模型接口经记录代理 |
| 环境 | 每题一个全新容器（题自带的镜像，`task.toml` 的 CPU 与内存限制），评测前两边都在容器里装好 `git`（镜像没有时）；工作目录为镜像的 `WORKDIR` |
| 每题限制 | Agent 15 分钟封顶；验收由题自带的隐藏测试在 Agent 结束后放入 |
| 并行 | 同时 3 个容器（SWE-bench Pro 同时 2 个） |
| 机器 | WSL2 Ubuntu-24.04，32 核，约 7.5 GB 内存，Docker 29.7.2 |
| 度量 | 成功：隐藏测试通过（1）或不通过（0）；时间：Agent 的墙钟秒数，不含装 git 与验收；token：`dsh` 在接口处由记录代理统计（Anthropic 形式，缓存命中与未命中分开），`mas` 取自会话日志（OpenAI 形式，缓存命中含在输入里）；汇总时统一成"模型读到的全部输入 token"与输出 token |

汇总表每格：结果、Agent 秒数、输入 token / 输出 token、模型请求数、缓存命中率。

## E1 到 E4（2026-11-11）：适配器上线与第一批 10 题

**目的：** 让 `mas` 与 `dsh` 在同一批开发集题上跑起来，找出适配层与 `mas` 自己的问题。

**题（10）：** Terminal-Bench `fix-code-vulnerability`、`git-multibranch`、`multi-source-data-merger`、`openssl-selfsigned-cert`；SWE-bench Pro `NodeBB-da0211b1`、`tutanota-de49d486`；自建并行 `wide-write-s2-n10`、`wide-read-s2-n14`、`research-then-implement-s2-n14`、`conflict-trap-s2-n8`。

**途中发现并处理的问题（按发现顺序）：**

1. **`mas` 在容器里没有命令工具。** 日志里 `sandbox: none (commands cannot be run)`：容器里没有 bubblewrap，默认配置 `sandbox.unavailable = deny`，命令工具整个不提供。评测方改成 `ask-unisolated`（容器本身就是隔离）。
2. **以路径开头的消息被当成指令。** 指令 `/app/registry.py 里有一张表……` 以 `/` 开头，控制台把它当作没有的指令，什么都没发给模型，评测空等到 15 分钟超时（请求数 0）。**产品改动：** 以 `/某目录/` 开头的行是消息，不是指令（`console.ts`，单元测试已加）。
3. **没有 `git` 的镜像里 `mas` 变成只读。** `compose-system.ts` 在找不到 git 时把整个会话设为只读（撤销靠 git），于是 `openssl-selfsigned-cert` 与 `multi-source-data-merger` 里既不能写文件也不能运行命令，两题得 0 分。评测方在容器里装好 git（两边一样）。**这是真实的产品限制**：在没有 git 的机器上 `mas` 什么都改不了。是否改成"无 git 也能写、只是没有撤销"留作设计问题，见下面"待决"。
4. 评测适配器自己的小问题：两个任务 id 写错前缀（SWE-bench Pro 目录名带 `instance_`）、WSL 偶发连接超时使后台进程残留容器（已清理，之后按名字前缀 `ar-` 清理，不碰别的容器）。

**结果（改完 1、2 之后，3 之前的汇总；`mas` 的 `openssl`、`merger` 是没有 git 时的结果）：**

| 题 | mas | dsh |
|---|---|---|
| conflict-trap-s2-n8 | 通过 21.4s 51k/1.2k r7 c95% | 通过 27.3s 31k/1.0k r6 c95% |
| fix-code-vulnerability | 通过 41.8s 134k/2.6k r10 c90% | 通过 72.4s 382k/4.2k r20 c92% |
| git-multibranch | 通过 127.1s 232k/17.3k r14 c90% | 通过 288.1s 1488k/44.8k r37 c99% |
| NodeBB-da0211b1 | 通过 206.4s 960k/12.3k r25 c94% | 通过 120s 583k/13.4k r22 c95% |
| tutanota-de49d486 | 通过 395.6s 751k/7.9k r31 c96% | 通过 326.4s 584k/7.3k r22 c95% |
| multi-source-data-merger | 失败（无 git，只读）| 通过 61.2s 62k/7.2k r7 |
| openssl-selfsigned-cert | 失败（无 git，只读）| 通过 43.5s 135k/5.4k r16 |
| research-then-implement-s2-n14 | 通过 33.7s 49k/2.0k r6 | 通过 24.7s 46k/1.1k r7 |
| wide-read-s2-n14 | 通过 53.4s 121k/3.7k r12 | 通过 40.1s 56k/1.7k r7 |
| wide-write-s2-n10 | 通过 28.6s 104k/3.8k r11 | 通过 107.7s 109k/5.1k r11 |

合计：`mas` 8/10、`dsh` 10/10；`mas` 的两次失败都是上面第 3 条（环境），不是模型或提示词。在两边都通过的 8 题上，`mas` 的输入加输出 token 合计约 245 万、`dsh` 约 336 万（`mas` 约为 `dsh` 的七成三，差距几乎全来自 `git-multibranch` 与 `fix-code-vulnerability` 两题；`NodeBB`、`tutanota`、`wide-read` 上 `mas` 反而更多）；Agent 时间合计 `mas` 908 s、`dsh` 1007 s（`mas` 在两道 SWE-bench Pro 与两道小题上更慢）。

**模型与思考强度的核对（探针 probe3，2026-11-11）：** 记录代理现在也存请求参数（不含消息、工具与 `dsh` 的会话日志）。`dsh` 的主请求为 `thinking: {type: enabled}`、`output_config: {effort: high}`、`max_tokens: 256000`，模型名 `deepseek-flash`，走 `https://api.deepseek.com/anthropic`；另有一个标题请求（`thinking: disabled`、`max_tokens: 4096`）计入 `dsh` 的用量。`mas` 的主 Agent 默认强度 `high`（`deepseek-flash` v0.1.0，`providerEffort: high`），走 OpenAI 兼容接口。两边强度一致，接口协议不同，不能证明服务端对两种接口的采样设置完全一致。E1 到 E3 当时代理没存请求参数，上面这批的强度是事后用探针核对的。

**注意：** 样本很小（每题一次），这些数字只能当作"适配器已通、没有明显的量级差距"的证据，不能下结论。

## E5（2026-11-11）：开发集剩余的题，`mas` 与 `dsh` 各一遍

**目的：** 在开发集剩余的 25 题上并排跑两个系统，找出 `mas` 的问题。参数同"通用参数"；`mas` 为提交 `15e077b07fa6` 加上工作区未提交的改动（控制台一条规则，见 E1 到 E4 的第 2 条），`dsh` 与 `mas` 的思考强度都是 `high`（见上面的核对）。E4 的重跑（无 git 的两题）在 E5 期间并行补跑：`multi-source-data-merger` 通过（43 s，8 请求），`openssl-selfsigned-cert` 的容器残留未出结果，在 E6 重跑。

**结果：** `mas` 通过 18/25，`dsh` 23/25；Agent 时间合计 `mas` 6729 s（其中 4 次 900 s 超时共 3600 s）、`dsh` 3383 s；token（读入加输出）`mas` 1626 万、`dsh` 1429 万；请求数 `mas` 414、`dsh` 486。逐题的表在 `~/bench/results/results.jsonl`，用 `node scripts/taskset/summarize.mjs ~/bench/results/results.jsonl e5 --md` 重新生成。

**`mas` 的失败与原因：**

| 题 | 现象 | 原因 |
|---|---|---|
| `dependency-chain-s1-n3`、`-s2-n7` | 900 s 超时，0 次请求 | 指令以 `/app 里有……` 开头，前一次修的规则只放行 `/app/…`，这一行仍被当成指令，什么也没发给模型 |
| `research-then-implement-s1-n6` | 900 s 超时，1 次请求后暂停 | 模型对 `/app/notes`、`/app/TASK.md` 用了读工作区之外文件的工具（它不知道 `/app` 就是工作区根），两次失败后暂停等人 |
| `failure-recovery-s1-n6` | 15 s 结束，只报告不完成 | 模型对 `/app/unit_XX/impl.py` 用绝对路径写，全部被 `WRITE_OUT_OF_SCOPE` 拒绝，没有改用相对路径就收尾了 |
| `raman-fitting`、`adaptive-rejection-sampler` | 验收不过（后者超时 902 s） | 待分析，更像是模型能力或时间不够；`dsh` 在后一题同样失败 |
| `nginx-request-logging` | 2 项验收不过 | 两个系统都失败，指令与镜像相关，待看 |

**随后的改动（都在开发集上发现，未看最终集）：**
1. 控制台：以 `/` 开头的行，只有第一个词是已有指令、或整行只有一个没有的词才是指令，其余是消息（`console.ts`、测试、M2Design 的表）。
2. 主 Agent 提示词（`main-system`）加一条：文件工具只收相对路径；指令里是绝对路径时先用 `pwd` 找到根，路径在根之下就去掉前缀；外部读取工具只用于根之外的文件夹。

**注意：** 在 `mas` 慢的几题（`gcode-to-text`、`headless-terminal`、`chess-best-move`）上 `mas` 的 token 是 `dsh` 的 2 到 3 倍，请求数相近，说明单次请求读入的更多（工具结果更长或上下文更大），列为下一步要看的问题。

## E6 与 E7（2026-11-11）：改完控制台规则与提示词后重跑 `mas` 的失败题

**目的：** 验证 E5 里两处改动（斜杠开头的句子是消息；提示词教模型把工作区内的绝对路径改成相对路径）。参数同 E5，只跑 `mas`，工作区含上述两处改动，`mas` 的定义摘要随提示词改动而变。E6 里有 3 题没有产生结果（容器没留下记录，原因未查明，疑为同时构建镜像），在 E7 补跑。

**结果（`mas` 全部通过，之前都是失败）：**

| 题 | 结果 |
|---|---|
| `dependency-chain-s1-n3` | 通过 11.1 s，6 请求 |
| `dependency-chain-s2-n7` | 通过 10.7 s，6 请求 |
| `research-then-implement-s1-n6` | 通过 16.1 s，8 请求 |
| `failure-recovery-s1-n6` | 通过 34.7 s，10 请求 |
| `openssl-selfsigned-cert`（有 git） | 通过 36.1 s，13 请求 |

**发现：** 去掉两个环境问题与路径问题后，`mas` 在开发集 25 题里只剩 `raman-fitting`、`adaptive-rejection-sampler`、`nginx-request-logging` 三题没过，其中后两题 `dsh` 也没过。

## E8（2026-11-11）：`mas` 思考强度 `low`，只作探索，不采用

**目的：** 看思考强度对时间与 token 的影响。`dsh` 没有按任务动态调整强度的机制（强度是一次运行里固定的选择，不设时用适配器默认，实测 `high`），为了两边对等，**两边都固定为 `high`**，本实验的结果不作为基线，也不改默认值。

**参数：** 同 E5，只跑 `mas`，主 Agent 的 `defaultEffort` 临时改为 `low`（改的是 WSL 副本的定义文件，已改回 `high`）。7 题里有 3 题（`gcode-to-text`、`headless-terminal`、`chess-best-move`）的驱动进程中途消失、没有结果（容器残留，已清掉），不计。

| 题 | `high`（E5） | `low` |
|---|---|---|
| `merge-diff-arc-agi-task` | 通过 230 s，34k 输出 | 通过 144 s，20k 输出 |
| `raman-fitting` | 失败 289 s | 通过 285 s，36k 输出 |
| `element-web-dae13ac8` | 通过 357 s | 通过 309 s |
| `adaptive-rejection-sampler` | 失败（超时 902 s） | 失败 446 s |

**结论：** 降低强度能缩短时间、减少输出，但两边强度不一致就不能比；留作以后"按任务自动选强度"这类功能的参考，现阶段不做。优化只从工具、提示词与工作流入手。

## 汇总 S1（2026-11-11）：开发集已测的 36 题，E1 到 E7 取每个系统每题最近一次结果

**口径：** 每题每系统取最近一次有结果的运行（`mas` 的失败题改过后重跑的结果替代旧结果；E8、E9 的探索与剖析运行不计）；一题一次，没有重复。读入 = 模型读到的全部输入 token（`dsh` 含缓存命中），输出含思考。两边思考强度都是 `high`。

| 范围 | 系统 | 通过 | Agent 秒数 | 读入 | 输出 | 请求 |
|---|---|---|---|---|---|---|
| 全部 36 | `mas` | 33 | 5077 | 1856 万 | 59.0 万 | 577 |
| 全部 36 | `dsh` | 34 | 4506 | 1743 万 | 45.0 万 | 646 |
| Terminal-Bench 20 | `mas` / `dsh` | 17 / 18 | 3805 / 3436 | 1397 万 / 1379 万 | 50.9 万 / 37.6 万 | 372 / 469 |
| SWE-bench Pro 3 | `mas` / `dsh` | 3 / 3 | 959 / 726 | 366 万 / 292 万 | 5.0 万 / 5.0 万 | 98 / 82 |
| 自建并行 13 | `mas` / `dsh` | 13 / 13 | 313 / 345 | 94 万 / 72 万 | 3.1 万 / 2.4 万 | 107 / 95 |
| 两边都通过的 33 | `mas` / `dsh` | 33 / 33 | 3833 / 3333 | 1501 万 / 1264 万 | 43.1 万 / 31.6 万 | 506 / 540 |

未通过：`mas` 三题（`adaptive-rejection-sampler`、`nginx-request-logging`、`raman-fitting`），`dsh` 两题（前两题）。

**结论：** 通过率相差一题；在两边都通过的题上，`mas` 的时间多约 15%、读入多约 19%、输出多约 36%，请求数少约 6%。也就是 `mas` 每次请求读得更多、想得更多，而不是请求更多。此前"`mas` 的 token 约为 `dsh` 的七成"只对头 10 题成立，在全部题上不成立，已作废。`mas` 明显慢于 `dsh` 的集中在长任务（`gcode-to-text` 619 对 228 s、`headless-terminal` 429 对 170 s），在小任务和自建并行题上两者接近。

## E9 与 E10（2026-11-11）：剖析 `mas` 的请求构成，并收紧命令输出预览

**E9（剖析，`mas` 三道长任务，`high`，默认限制）：** 测驱动现在把每次请求的构成（各类内容的字符数，不含内容）写进 `request-profile.jsonl`。`chess-best-move` 第 22 次请求时：回放的历史思考 17.8 万字符、工具结果 7.8 万字符、系统提示 0.7 万字符、工具定义 1.6 万字符；单条命令输出最大 2.2 万字符（命令输出预览的默认上限是 50 KiB 与 2000 行）。`headless-terminal` 通过（236 s），`chess-best-move` 通过（344 s），`gcode-to-text` 超时失败（902 s；E5 里同一题通过，619 s，同一题两次差别很大）。

**`dsh` 的同一指标（探针 p11，`dsh`，`chess-best-move`，28 次请求）：** `dsh` 同样回放思考（第 27 次请求里 `thinking` 块共 4.1 万字符、工具结果 1.7 万字符），但量远小于 `mas`（`mas` 同题 22 次请求就是 17.8 万与 7.8 万）；系统提示 2.6 千字符（`mas` 6.9 千）、工具定义 1.9 万字符（`mas` 1.6 万）。`dsh` 的 `bash` 工具长输出只留尾部、完整输出存文件；系统提示很短，只有工具用法的几条规则（先看退出码、用 `read`/`glob`/`grep` 代替 `cat`/`find`、后台任务与子 Agent 的用法）。

**结论：** 两边都回放思考；`mas` 的差别在于每一步想得多得多（同一指令下每次请求的输出 `mas` 约 2000 token、`dsh` 约 600 token）。E8 中 `mas` 的 `low` 与 `dsh` 的 `high` 输出量接近，提示 DeepSeek 的 OpenAI 兼容接口（`reasoning_effort: high`）与 Anthropic 兼容接口（`output_config.effort: high`）对同一档强度的实际思考量可能不同；设置对等，实际并不对等，之后比较时要记着这一点。

**E10（`mas`，命令输出预览 12288 字节与 300 行，其余默认，`high`）：** 已有的 5 题全通过：`headless-terminal` 221 s，`chess-best-move` 289 s，`merge-diff-arc-agi-task` 71 s，`raman-fitting` 245 s（E5 失败）、`polyglot-c-py` 162 s；`gcode-to-text` 未完。单次差异里有噪声，E5、E9 与 E10 同题时间相差可达一倍，不能把差异直接归于预览上限；需要重复运行才能下结论。

数据文件：E9 在 `~/bench/results/e9-*`，E10 在 `e10-*`；`dsh` 探针与系统提示的抓取在 `~/bench/usage/p11-*`（`.system.json` 为 `dsh` 第一次主请求的系统提示与工具定义）。

## E11 与提示词重复对照（2026-11-11 到 12）

**E11（`mas`，主 Agent 提示词加一条"思考要简短，别重复推导"，其余默认，`high`）：** 6 题里 `gcode-to-text` 又失败（902 s，模型推理谜题，E5 通过、E9、E10、E11 都失败，不再为它改 `mas`），其余 5 题全通过；去掉 `gcode-to-text` 后 5 题合计时间 E5 1367 s（4/5 通过）、E10 988 s（5/5）、E11 1121 s（5/5），输出 token E5 19.4 万、E10 13.8 万、E11 14.6 万。同一默认配置下同一题时间可差一倍（`headless-terminal` E5 429 s、E9 236 s；`chess-best-move` E5 255 s、E9 344 s、E11 568 s），所以 E10 与 E11 的差别在噪声之内，不能下结论。

**重复对照（`abA1`、`abA2` 无该提示词，`abB1`、`abB2` 有，5 题，交替跑两轮）：** 已出的第 1 轮里 `chess-best-move` 在 A 组 668 s、读入 282 万，B 组 172 s、读入 40 万；`merge-diff-arc-agi-task` 在 A 组 43 s 失败。该失败的原因：题要求在 `/app/repo` 里 `git init`，命令新建 `.git` 被安全设计移走（`PROTECTED_PATH_CREATED`，M2Design 8.3，防止 hook 被留下），`mas` 没能完成；这是有意的取舍，不放宽，记为"安全设计的代价"。其他轮里同一题能通过，说明模型有时绕得过去。

**重复对照的结果（5 题 × 2 轮 = 每组 10 次）：**

| 组 | 通过 | Agent 时间 | 输出 | 读入 | 请求 |
|---|---|---|---|---|---|
| A 无"思考要简短" | 8/10 | 2764 s | 38.2 万 | 1052 万 | 278 |
| B 有"思考要简短" | 8/10 | 1827 s | 25.7 万 | 509 万 | 211 |

第 1 轮 A 1266 s、B 985 s，第 2 轮 A 1498 s、B 842 s，两轮方向一致。B 相对 A：时间 −34%、输出 −33%、读入 −52%、请求 −24%，通过数相同。**结论：保留这条提示词。**（这次改的只有这一条，其余代码与默认值相同，所以差别可以归于它。）

**一个通用的修复（不属于效率实验）：** 模型被告知文件的全路径（`/app/examples.json`）时，文件工具只收相对路径，要靠提示词让模型改写，实测不可靠（上面那次先用 `read_file` 被拒，再误用外部读取工具，最后用 `cat` 绕过）。改成在 `toolInputOf` 里统一处理：位于仓库根之下的全路径一律转成相对路径（对读、写、改、列、搜、命令的 `workdir`），根之外的路径不动，仍由工具拒绝；单元测试已加。提示词里相应的一条改成"根之下的全路径也接受"。

### E12 回放窗口对照（作废）

计划在同一份代码上对比完整回放（`e12all1`、`e12all2`）与只回放最近 2 步思考（`e12k2r1`、`e12k2r2`）。运行时新旧两批队列重叠，同一标签的题目跑了两遍；`e12all2` 全部 902 秒超时且没有用量，原因是 DeepSeek 账户余额耗尽（余额查询为 -0.08 CNY，请求返回 402 `Insufficient Balance`），模型请求全部失败，运行空等到超时。通过数与耗时不能用于比较，结果作废，不据此做决定。

### E13 回放窗口对照（重跑）

同一份代码，每次只跑一批，每批前先等 Docker 可用。标签 `e13all1`、`e13k2r1`、`e13all2`、`e13k2r2`，5 题（headless-terminal、chess-best-move、raman-fitting、merge-diff-arc-agi-task、polyglot-c-py），P=3，`MAS_REPLAY_KEEP=2` 为窗口组。第一批 `e13all1` 与 `e13k2r1` 因同样的余额不足全部失败（用量为 0），已中止，结果作废。充值后重跑。
