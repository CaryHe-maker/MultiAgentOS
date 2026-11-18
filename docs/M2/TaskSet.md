# M2 的评测任务集

> M2 的开发集与最终集：清单、存放位置、校验方法、运行规则与 `dsh` 对照的结果。题目在 2026-11-15 定稿，之后不再改动。度量与记录的方法见 [Evaluation](Evaluation.md)；每次运行的过程见 [experiments](experiments.md)。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `scripts/taskset/taskset.json` | 定稿的四组题目：每题的 id、来源、角色与内容哈希，`frozen` 记下定稿的时间与题数 |
| `scripts/taskset/taskset-freeze.mjs` | 重新计算每题内容的哈希并与定稿比较（`node taskset-freeze.mjs`，在 WSL 中运行）；定稿后题目内容有任何改动都会报出 |
| `scripts/taskset/dsh-results.json` | `dsh` 对照的全部运行（每题一次）：用时、得分、请求数、token、按价格表折算的费用；原始日志在 WSL 的 `~/bench/p3dsh` |
| `scripts/taskset/designed/<名>/` | 本项目设计的题，Harbor 格式：`instruction.md` 规格、`environment/` 镜像、`tests/` 隐藏测试与判分、`solution/` oracle、`task.toml` |
| `scripts/taskset/dsh-run.sh` | 运行入口：每题开跑前写标记，有标记的题不再运行 |

题目的来源与位置：`designed/*` 在本仓库；`tb2/*`、`sbp/*`、`lb/*`、`deepswe/*` 在 WSL 的 `~/benchmeta`（Terminal-Bench 2.0、SWE-bench Pro v2、LoopsBench 题包 c47e13a、DeepSWE）；`study.*` 在 `apps/control-plane/test/eval/fixtures/study/`；`parallel/*` 在 `~/taskset`。

## 2. 规则（摘要）

- **最终集至多运行两次**，不用于调参；只看合计数字，不看题目细节。开发集用于调参。
- 每个对照每题运行一次，不在同样条件下重复。
- 大任务的门槛：`dsh` 单独运行至少 **20 分钟**（2026-11-15 由 25 分钟放宽）。
- **用 DeepSeek 跑过的题都保留**，放在开发集或最终集。
- 编程类设计题**离线运行**（`task.toml` 的 `allow_internet = false`）：容器只能访问记录代理与经它的模型接口。论文题需要联网核对文献。
- 判分：编程题按隐藏测试的通过比例；论文题结构检查与参考文献核对（DOI 经 Crossref、arXiv 编号经 arXiv，题目、第一作者、年份都要对上）各占一半。每道设计题的 oracle 通过（调用参考实现的包装按设计只不通过"禁止外部程序"一项），空实现为 0 分。

## 3. 最终集

### 3.1 小任务（10 道，计分 8 道）

| 题 | dsh 用时（分钟） | 得分 | 费用（美元） |
|---|---|---|---|
| tb2/custom-memory-heap-crash | 1.4 | 1 | 0.009 |
| tb2/financial-document-processor（剔除：看图，见第 7 节） | 1.1 | 1 | 0.010 |
| tb2/constraints-scheduling | 0.7 | 1 | 0.005 |
| tb2/filter-js-from-html（剔除：`dsh` 用了这道题自己的测试与参考解，见第 7 节） | 9.3 | 1 | 0.044 |
| tb2/llm-inference-batching-scheduler | 4.2 | 1 | 0.033 |
| tb2/mailman | 5.2 | 1 | 0.035 |
| sbp/navidrome-87d4db76 | 4.5 | 1 | 0.018 |
| sbp/openlibrary-431442c9 | 0.7 | 1 | 0.006 |
| sbp/navidrome-8d56ec89 | 3.9 | 1 | 0.015 |
| sbp/openlibrary-0d13e6b4（替补，替换 teleport-1b08e7d0） | 2.3 | 1 | 0.019 |

候补（未运行）：tb2/protein-assembly、tb2/path-tracing、sbp/teleport-73cc189b。teleport-1b08e7d0 是 Alpine 镜像，`dsh` 无法运行（glibc 的 Node；换 musl 版后 node-pty 崩溃），两次作废，转入开发集。

### 3.2 大任务（5 道，都是本项目设计）

| 题 | 内容 | 参考实现 | dsh 用时（分钟） | 得分 | 费用（美元） |
|---|---|---|---|---|---|
| designed/pylua | Lua 5.4 解释器与标准库 | lua5.4 5.4.7 | 30.6 | 0.782 | 0.292 |
| designed/survey-av-fusion | 综述《多传感器融合的自动驾驶环境感知技术综述》：30000 字、80 条以上文献、文献注释（非编程） | Crossref、arXiv | 28.7 | 0.996 | 0.125 |
| designed/sqlengine | 与 SQLite 兼容的 SQL 引擎 | sqlite3（SQLite 3.46.1） | 23.3 | 0.875 | 0.253 |
| designed/minidb | 小型关系数据库（自定的 SQL 子集、事务、崩溃一致性） | 本项目的参考实现 | 23.1 | 1.0 | 0.166 |
| designed/pyarchive | DEFLATE、gzip、zip、tar（ustar/gnu/pax） | GNU tar 1.35、GNU gzip 1.13、Info-ZIP | 20.9 | 1.0 | 0.238 |

sqlengine 与 minidb 都是从零写关系数据库，相似度高，因此一起放在最终集，开发集里没有数据库题（Cary 定）。minidb 是联网运行的（离线规则在它之后才定）。

## 4. 开发集

### 4.1 小任务（11 道，计分 7 道）

tb2/tune-mjcf、tb2/configure-git-webserver、tb2/gcode-to-text、tb2/raman-fitting、tb2/polyglot-c-py、tb2/chess-best-move、sbp/qutebrowser-36ade4bb、sbp/vuls-7e91f5ef、sbp/NodeBB-da0211b1、parallel/dev/research-then-implement-s1-n6（`dsh` 没有运行），以及从最终集转来的 sbp/teleport-1b08e7d0（`dsh` 无法运行）。tb2/chess-best-move 与 tb2/gcode-to-text 不计分（看图，见第 7 节）。

### 4.2 大任务（26 道）

达到 20 分钟门槛的设计题（开发集的主体）：

| 题 | 内容 | dsh 用时（分钟） | 得分 | 费用（美元） |
|---|---|---|---|---|
| designed/pyawk | POSIX awk 解释器（gawk --posix） | 27.5 | 0.986 | 0.207 |
| designed/minipy | Python 子集解释器（CPython 3.12） | 23.2 | 0.932 | 0.228 |
| designed/textutils | GNU 文本工具集 15 个工具 | 22.3 | 0.970 | 0.229 |
| designed/survey-med-seg | 综述《基于深度学习的医学图像分割方法综述》：50000 字、120 条以上文献（非编程） | 22.2 | 1.0 | 0.119 |
| designed/pyregex | 与 Python `re` 兼容的正则引擎 | 20.0 | 0.966 | 0.176 |

`dsh` 跑过、不到 20 分钟而保留的题：

| 题 | dsh 用时（分钟） | 得分 | 费用（美元） |
|---|---|---|---|
| designed/survey-kg-embedding（长篇综述） | 18.3 | 1.0 | 0.082 |
| designed/pyjq（jq 1.7） | 17.4 | 0.819 | 0.151 |
| designed/survey-fl-privacy（综述） | 16.1 | 1.0 | 0.077 |
| designed/mdhtml（CommonMark；联网，移植了 commonmark.py） | 15.3 | 1.0 | 0.125 |
| designed/pygit（git 核心；联网） | 14.9 | 1.0 | 0.130 |
| designed/survey-gnn-recsys（综述） | 12.0 | 1.0 | 0.066 |
| designed/coursereg（选课系统后端；联网） | 11.2 | 1.0 | 0.084 |
| lb/task_compiler_rustlike_rv32 | 21.1 | 未通过 | 0.160 |
| lb/task_java_ds_coursework | 17.3 | 未通过 | 0.227 |
| lb/task_compiler_cmm_mips | 17.2 | 未通过 | 0.211 |
| lb/task_compiler_sysy_rust | 13.4 | 未通过 | 0.145 |
| lb/task_os_labs_asm_kernel | 10.4 | 未通过 | 0.177 |
| lb/task_cs61b_extra_java_bundle | 9.9 | 通过 | 0.111 |
| deepswe/arcane-drift-detection-baselines | 11.0 | 1 | 0.072 |
| deepswe/bandit-interprocedural-taint-checks | 7.6 | 1 | 0.067 |
| lb/task_ligra_graph_evolution（适配器冒烟检查，5 分钟上限） | 5.0 | 未通过 | — |
| deepswe/anko-default-function-arguments（适配器冒烟检查，5 分钟上限） | 5.0 | 0 | — |

另有开发题（`dsh` 没有运行）：lb/task_raylib_shapes2d_medium、deepswe/quill-shared-toolbar-focus、study.findex、study.taskq。

## 5. 运行与对照

- `dsh` 对照（中性提示、`deepseek-flash`）对每道题运行一次，共 37 次，合计 **4.11 美元**；之后不再重跑。
- 最终集至多运行两次，与 `dsh` 用同一镜像、同一判分、同一单题上限（大任务 2.5 小时，小任务沿用题目的设置）与同一价格表；离线题的模型请求经记录代理，联网题由 mas 自己计数；不在 DeepSeek 的高峰时段（工作日 UTC 01:00–04:00、06:00–10:00）开始运行。
- 结果的读法：`dsh` 在多数题上得分很高（小任务全对，大任务 5 道中 2 道满分），正确率上的差距有限；用时与费用的差距是主要的对比。

## 6. 最终集大任务的结果（Mission 模式）

两次运行都只跑 5 道大任务，各一次；只看合计，单题明细与有效性核对见 [experiments](experiments.md)。

| 运行 | 版本 | 总用时（分钟） | 平均分 | 费用（美元） | 缓存命中率 |
|---|---|---|---|---|---|
| 第一次（2026-11-16） | Mission 基线1.1 | 95.9 | 0.910 | 2.237 | 97.05% |
| 第二次（2026-11-17） | Mission 基线1.2（M2 V1.0） | 103.8 | 0.917 | 1.791 | 98.51% |
| 基线1.2 的成绩（pylua 取重复运行） | Mission 基线1.2（M2 V1.0） | **87.8** | 0.917 | 1.764 | 98.59% |
| `dsh` | — | 126.6 | 0.931 | 1.074 | — |

最终集的两次运行已经用完，之后不再运行。

第二次运行里 pylua 慢、pyarchive 低分，之后用同一版本各重复运行一次：pylua 0.795 / 20.6 分钟、pyarchive 1.000 / 12.8 分钟，都比 `dsh` 快，说明是单次运行的随机性（[experiments](experiments.md)）。第二次运行的 pylua 受 DeepSeek 两次断流影响，基线1.2 在 pylua 上的成绩取重复运行（Cary 定），其余四道取第二次运行，即上表"基线1.2 的成绩"一行；pyarchive 仍取第二次运行。

## 7. 看图与查了答案的题不计分（2026-11-18，Cary 定）

`dsh` 有 `read_image` 工具：读 PNG、JPEG、WebP、GIF 文件，把图片本身交给模型（deepseek-flash 接受图片输入）；mas 没有图片输入。逐个查了所有 `dsh` 运行的思考记录，用到看图的只有 3 道：

| 题 | 集 | `dsh` 怎样用 |
|---|---|---|
| tb2/chess-best-move | 开发集小任务 | 直接看棋盘图片 |
| tb2/gcode-to-text | 开发集小任务 | 把刀路画成图片再看 |
| tb2/financial-document-processor | 最终集小任务 | 逐张看 12 张发票图片 |

这 3 道在 `taskset.json` 里标 `excluded`，留在原来的集里（"跑过的题都留下"的规则），但不再运行、对比或计分；任务内容与哈希不变。大任务都没有用到看图。

最终集小任务 tb2/filter-js-from-html 也标 `excluded`：`dsh` 的回答说它"在本地用完整的 439 个 XSS 向量与全部 12 个正常 HTML 样本验证过"，思考里引用隐藏测试的代码与参考解的做法，而镜像里没有这些文件，所以它用了这道题自己的测试与参考解（取得的过程在被截掉的日志前半段里）。评测脚本只保存 `dsh` 思考日志的最后 20000 个字符（`agentrun.mjs`），200 个 `dsh` 运行里 99 个被截断，被截断的只能确认后半段；开发集的 raman-fitting 上 `dsh` 也取了 solution 与 tests，仍计分（mas 自己做出），`dsh` 的成绩读作"查了答案"。
