# MultiAgentOS M1 发布工作计划

> 状态：工作计划，2026-10-24 起草，起点为 `feature/M1/main` 的 `d041637`（#36 合并后）。
> 本文件不是规范。M1 的范围与验收以 [M1Plan](M1/M1Plan.md) 及 `docs/M1/` 下的文档为准，
> 长期架构以 [Architecture](Architecture/README.md) 为准；与它们冲突时以它们为准。

## 1. 目的与起点

三个工作分支已全部合入 `feature/M1/main`：Workflow、UserInteraction 与 CLI（#31），
Kernel 与 Infrastructure（#33），ExecutorSet 与 AgentToolPool（#35、#36）。
真实部件可以组成完整系统，并已用脚本化的假 provider 跑通整条调用链。

本文件规定从这一状态到 M1 发布版（`feat/M1 -> main`）期间的行为规范与阶段规划。

起点时已知的状态：

| 项 | 状态 |
|---|---|
| 质量门 | Ubuntu 24.04 上 build、lint、format:check 通过；测试 86 个文件、1076 项通过，14 项 rg 用例因本机无 rg 跳过 |
| 产品部件 | M1Plan 第 2 节第 1–9 项均已实现；第 10 项（固定任务集基线）未开始 |
| Prompt 与工具说明 | `v0.1.0`，`contentStatus: PLACEHOLDER` |
| 真实模型 | 只在 C 审查题上评测过，评测使用 `executor-set/eval/agent-loop.ts` 的简化循环，不经产品调用链 |
| 固定任务集 F1–F5 | 仓库中没有 fixture 与验收工具 |
| 合并遗留问题 | 见第 4 节阶段一 |

## 2. 行为规范

### 2.1 规范与权威来源

1. 所有代码、文档、Commit 必须满足 [Style](Style.md)，包括命名、格式、Commit 格式，
   以及“修复缺陷必须先增加可复现测试”。
2. M1 的验收目标以 `docs/M1/` 为准，长期架构以 `docs/Architecture/` 为准。
   本计划只安排工作顺序，不新增、放宽或改写验收标准。
3. **凡是需要修改 `docs/M1/` 或 `docs/Architecture/` 下任何文件的事项，必须先单独向 Cary 提出请求，
   说明修改内容、原因和影响，得到同意后才能修改。** 本计划中这类任务标为“需请求”。
4. **不得中途切换概念。** 术语、对象、原因码和状态名一律沿用 M1 文档已有的定义，
   不引入别名，不改变已有概念的含义或边界，不用新概念替换旧概念；
   确有必要时按第 3 条提出请求。
5. 修改 contracts 的 Schema、Port 或跨模块类型，等于修改 M1Interface 或 SharedContracts，按第 3 条处理。
   新增 M1TechStack 未允许的依赖同样按第 3 条处理。
6. 代码与 M1 文档不一致时，先列出差异再决定改哪一方，不得为了让测试通过而默默改动任何一方。

### 2.2 分支与提交

1. 本阶段的主要工作分支是 `feature/M1/main`。合并后的开发工作直接在本分支提交，
   一般不另开分支；确需隔离的实验可以按 Style 4.2 另开短期分支，完成后合回本分支。
2. 每个 Commit 只表达一个逻辑变更，保持可构建、可测试，格式符合 Style 第 5 节。
   依赖、lockfile 与构建配置的修改单独提交。
3. **Commit 的粒度参照 `feature/M1/main` 上已有的提交**：一个 Commit 对应一项完整的任务或
   一组相关的修改（通常是本计划中的一个或几个相关任务），而不是每处小改动各一个 Commit。
   - 相关的小修复合并为一个 Commit，在正文中逐条列出，例如
     `fix: 修正授权提示与 Workflow 依赖声明并精简 UserInteraction 规范`。
   - 代码修改连同它所需的测试与文档同步放在同一个 Commit 中，不拆成代码、测试、文档三个。
   - 只改文档的同一阶段任务合并为一个 Commit。
   - 只有主要目标不同、无法归入同一 Type 的修改才拆开（Style 5.1）。
4. 提交前在 WSL Ubuntu 上运行 `pnpm run check` 与 `git diff --check`，全部通过才能提交。
   本机已安装 rg 后，rg 用例不得跳过。
5. 满足第 2–4 条的本地 Commit 可以直接生成，不需要逐个确认。
   **推送到 `origin` 必须先向 Cary 确认**，确认时列出将要推送的提交。
6. 不得 force push，不得 rebase、squash 或以其他方式改写 `feature/M1/main` 已推送的历史。
   尚未推送的本地提交可以整理，但不得丢弃 Cary 的提交。
7. `feature/M1/main -> feat/M1` 与 `feat/M1 -> main` 都使用 merge commit，保留三个工作分支与
   评测记录所引用的提交。

### 2.3 协作与对外发布

1. 本阶段的全部任务由 Cary 负责，不需要与 field 或 meti 对接；遇到原属其他负责人的目录或决定，
   直接解决，不等待对方。
2. **发布任何 Issue 或 PR 前，必须先单独向 Cary 确认内容。** 在 Issue 或 PR 上评论、关闭 Issue、
   修改标签，同样先确认。
3. Style 6.3 要求进入 `feat/*` 与 `main` 的 PR 至少有一名非 PR 创建者批准。
   第 1 条不免除这一要求，评审人由 Cary 安排。

### 2.4 测试、安全与评测

1. 不得删除、跳过或放宽已有测试来让质量门通过；不稳定的用例必须找到原因并修复，不得靠重跑。
2. 不得削弱只读边界、排除规则、路径检查、预算与来源核验。安全相关的修改必须附带反例测试。
3. 不得提交 API key、`.env`、运行目录或评测产生的数据目录。API key 只通过环境变量
   `DEEPSEEK_API_KEY` 或 MultiAgentOS 工作目录下不入库的 `.env` 提供。
4. 普通质量门不得依赖真实模型或外部网络（M1TechStack 第 11 节）。
5. 真实模型运行会产生费用。成批运行前先说明次数、模型与预计费用。
   每次运行记录 provider、模型、配置、固定定义的 digest、commit、token、成本和耗时。
6. 评测结论引用的运行记录必须能由 commit 与定义 digest 复现。
7. 发现的问题（缺陷、偶发失败、文档与实现不一致等）不论大小，都要在发现时记入第 4 节相应阶段作为任务，
   并在发布前解决，不留下技术问题；不得用“已知限制”代替修复。只有 M1 文档明确不在 M1 范围内的事项才写入限制清单。

### 2.5 本计划的维护

1. 每完成一项任务，在第 5 节的进度记录中填写完成日期、提交与验证证据。
2. 阶段规划中的任务可以按实际情况拆分或补充；修改第 2 节行为规范，或删减任何任务，
   需要先得到 Cary 同意。
3. 待决事项的结论记录在第 3 节，结论需要修改 M1 文档的，仍按 2.1 第 3 条处理。

## 3. 待决事项

以下事项必须由 Cary 决定。标为“需请求”的事项会修改 M1 文档。已决定的事项在“结论”列记录日期。

| ID | 事项 | 背景 | 建议 | 决定时机 | 结论 |
|---|---|---|---|---|---|
| D1 | 检查后文件被删除时返回什么 | `guarded-file.ts` 打开文件遇到 ENOENT 时返回 `VIOLATION(PATH_ESCAPE)`，ExecutorSet.md 3.2 第 7 步也这样写；#26 A1 的答复是改为 `NOT_FOUND`。不改的话，分析期间仓库内文件被正常删除会让运行以安全违规结束 | 改为 `REJECTED(NOT_FOUND)`；`ENOTDIR`、`ELOOP` 与身份不符仍为违规。需请求（ExecutorSet.md 3.2） | 阶段一 | 2026-10-24 同意，含 ExecutorSet.md 修改 |
| D2 | 检索评分中“路径含 test 乘 0.9” | #26 E 要求去掉，代码（`search-executor.ts`）与 ExecutorSet.md 3.3 仍保留；F2、F4 要求找到测试文件 | 去掉。需请求（ExecutorSet.md 3.3） | 阶段一 | 2026-10-24 同意，含 ExecutorSet.md 修改 |
| D3 | 收尾说明只保留一处 | Workflow 记录 `FEEDBACK(WRAP_UP_NOTICE)`，上下文组装器的状态行也写明最后一次调用及原因（#32 第 1 条） | 由阶段三的评测决定保留哪一处。需请求（Workflow.md 第 8 节或 ExecutorSet.md 4.4） | 阶段三 | 2026-10-25 决定只保留状态行：评测中三种做法收尾后正常出报告的比例相同（8/10、8/10、9/10），按设计取可读性更好、本就每轮变化的状态行；Workflow 不再记录 `WRAP_UP_NOTICE`，修改 Workflow.md 第 8 节与 M1Interface 的反馈码 |
| D4 | 启动期额度校验的上界 | 现为 79156 / 80000。用户输入按每个字符都是二次转义的控制字符估算，约预留 58k token；Monitor 第 4 节还把 FILE_READ 的字节上限当作 token 相加。留给 Prompt 与工具说明的空间约 5k token | 在阶段三开始前决定是否放宽估算方法或调整 `perCallInputLimit`。需请求（Monitor.md 第 4 节） | 阶段三之前 | 2026-10-25 自主执行期间定论（见第 6 节 A5，待 Cary 复核） |
| D5 | 30 秒端口期限是否改为系统级约定 | Workflow 与 UserInteraction 各有一个 `PORT_RETURN_TIMEOUT_MS`；#29 计划改为 `SystemConfig` 配置项、由 Fabric 统一执行。M1Plan 没有要求 | 端口期限已在两个模块中按 Workflow.md 与 UserInteraction.md 的规定执行；系统级化只是集中配置与执行的位置。M1 发布不做，作为已知限制记录 | 阶段一 | 2026-10-24 决定在阶段一实现（R1.8），采用方案 A：期限值进入 `SystemConfig`，Fabric 执行 Gateway 请求的期限，组合根为 Catalog 与 Persistence 适配器加同样的期限，模块内不再有期限逻辑；需修改的 M1 文档在实施前列出，按 2.1 第 3 条确认 |
| D6 | CI 的 `pull_request` 分支过滤 | 只匹配 `main` 与 `feat/**`，与 M1TechStack 第 11 节一致；`feature/M1/main` 上的提交靠 push 事件触发 | 保持现状 | 阶段一 | 2026-10-24 同意保持现状 |
| D7 | “兼容矩阵”的含义 | M1Plan 第 7 节要求兼容矩阵全部通过，但 M1 文档没有定义它包含哪些维度 | 阶段二开始时提出定义（例如协议族的 major 版本正反例、Node 与 Ubuntu 版本）。需请求（M1Plan 第 7 节） | 阶段二 | 2026-10-25 决定：Ubuntu 版本定为 24.04 LTS（项目规范版本），只测这一版；矩阵为主格（`.node-version`、有 rg）、Node 上界（最新 24.x、有 rg）、无 rg 三格，外加协议冻结守卫，全部放入 CI；定义写入 M1Plan 第 7 节与 M1TechStack 第 11 节 |
| D8 | 评测脚本的 Agent 循环 | `executor-set/eval/agent-loop.ts` 自己实现了简化的 Workflow，评测结果不能代表产品（#32 第 4 条） | M1 验收只采用阶段二的验收工具经产品调用链得到的结果；`agent-loop.ts` 保留为开发工具 | 阶段二 | 2026-10-25 自主执行期间按建议定论（见第 6 节 A3，待 Cary 复核） |

## 4. 阶段规划

阶段按顺序进行；前一阶段的退出条件满足后进入下一阶段。同一阶段内没有依赖关系的任务可以并行。

### 4.1 阶段零：基线与环境

| ID | 任务 | 完成标准 |
|---|---|---|
| R0.1 | 在 WSL Ubuntu 24.04 中安装 ripgrep，版本与 CI 一致（14.1.0） | `rg --version` 输出 14.1.0 |
| R0.2 | 在 WSL 中对 `feature/M1/main` 运行完整质量门与 `demo:fake` | 测试全部通过，0 项跳过；记录测试数量 |
| R0.3 | 完成 Kernel 工作文档移入 `docs/History/` 的整理，修正指向它们的链接（`docs/README.md` 等） | 仓库内没有失效的相对链接 |
| R0.4 | 更新根 `README.md` 中已过时的实现状态（仍写着三个模块抛出 `NOT_IMPLEMENTED`） | README 与当前实现一致 |
| R0.5 | 本计划入库 | 本文件已提交 |

退出条件：质量门在 Ubuntu 上全部通过且不跳过 rg 用例；文档链接无失效。

### 4.2 阶段一：合并遗留问题收口

不需要修改 M1 文档的任务：

| ID | 任务 | 完成标准 |
|---|---|---|
| R1.1 | 在 `process.env.CI` 下找不到 rg 时让 rg 用例失败，而不是跳过（#25） | 去掉 rg 后在 `CI=1` 下运行，用例失败 |
| R1.2 | 修复 `system-control.test.ts` 中“stops the modules past a Kernel core that does not converge in time”的不稳定失败 | 先写出能稳定复现的条件；修复后连续运行 50 次无失败 |
| R1.3 | 为 M1Interface 6.6 补一条 Workflow reducer 性质测试：每个工具调用之后有 `TOOL_RESULT` 或带同一 `toolCallId` 的 FEEDBACK（#28） | fast-check 性质测试通过 |
| R1.4 | 核对 #24–#29、#32 中已答复的决定，逐条确认代码与文档已经落实 | 第 5 节记录逐条结果 |

需要按待决事项的结论处理的任务：

| ID | 任务 | 依赖 |
|---|---|---|
| R1.5 | 按 D1 修改 `guarded-file.ts` 与对应测试，同步 ExecutorSet.md | D1 及其请求获得同意 |
| R1.6 | 按 D2 修改检索评分与对应测试，同步 ExecutorSet.md | D2 及其请求获得同意 |
| R1.7 | 按 D6 的结论，在限制清单草稿中记录不做的事项 | D6 |
| R1.8 | 按 D5 实现端口期限的系统级约定：`SystemConfig` 增加端口响应期限（默认 30 秒），由 Fabric 的 `request` 统一执行并给出超时错误，组合根注入；Workflow 与 UserInteraction 删除各自的 `PORT_RETURN_TIMEOUT_MS`，只负责按所在的捕获边界升级；用户输入仍不受期限约束。同步 M1Interface、Fabric.md、Workflow.md、UserInteraction.md 与相关测试 | D5；文档修改内容获得同意 |
| R1.9 | 查明并修复 `stage6-acceptance` 在 CPU 满载下偶发失败的原因（2026-10-24 压力测试中 12 轮出现 1 次）：先在压力下稳定复现并取得失败输出，再修复；修复后在同样压力下连续运行足够次数无失败 | 原因写入进度记录；压力下连续 50 次通过 |

退出条件：R1.1–R1.4、R1.8、R1.9 完成；D1、D2、D5、D6 有结论，结论要求的修改已完成；质量门通过。

### 4.3 阶段二：固定任务集与验收工具

依据 M1Plan 第 6、7 节。

| ID | 任务 | 完成标准 |
|---|---|---|
| R2.1 | 为 F1–F5 各准备一个 fixture：固定的仓库内容、问题、预期来源、禁止路径、禁止副作用与验收断言。问题不得泄漏答案文件名；仓库内容由测试工具在运行前准备，产品代码不调用 git | 五个 fixture 由 Cary 审阅通过 |
| R2.2 | 编写验收工具：经 `multiagentos analyze` 的完整调用链运行任务；运行前后计算同一快照摘要并比对；从 RunSummary 与 AnalysisReport 取得指标并检查断言；按 M1TechStack 第 11 节记录运行信息 | 工具能对单个任务给出通过或失败及原因 |
| R2.3 | 离线 E2E：用脚本化的假 provider 驱动 R2.2 的工具跑 F1–F5，纳入质量门 | 质量门中 F1–F5 离线用例全部通过，不使用网络 |
| R2.4 | 把 #6 的安全风险清单落实为测试或陷阱题：假 `.env` 与假 key 不出现在上下文、模型请求和审计记录中；README 中的注入指令不导致越界读取；死循环在预算上限停下并给出原因；超大文件与二进制文件在限定时间内返回明确错误；GBK 编码与中文文件名不导致崩溃或乱码 | 每一条都有对应的测试或陷阱题，并通过 |
| R2.5 | 按 D7 的结论建立兼容矩阵的测试 | D7 获得同意；矩阵测试通过（2026-10-25 已提前完成，阶段二新增的离线 E2E 与 fixture 放在 `pnpm run test` 中即自动进入各格） |

验收工具与 fixture 只作为 devDependency 或测试目录存在，不得成为任何产品包的生产依赖。
真实模型运行不属于质量门。

退出条件：R2.1–R2.5 完成；离线 F1–F5 与安全用例在质量门中通过。

### 4.4 阶段三：真实模型联调与 Prompt 定稿

开始前 D4 必须有结论。

| ID | 任务 | 完成标准 |
|---|---|---|
| R3.1 | 用真实模型（默认 `deepseek-flash`）经完整调用链跑 F1–F5，每题至少 3 次，按失败分类记录问题 | 得到首轮失败清单 |
| R3.2 | 按 #32 第 3 节核对 Prompt 与工具说明：来源必须完全落在某一次 `read_file` 的范围内；概览与搜索结果不能作为来源；同一次回复不重复调用；Planner 只能交接或结束；未获授权时如实说明；空文件不能作为来源 | 每条规则在 Prompt 或工具说明中有对应文字，或说明不需要的原因 |
| R3.3 | 按评测结果决定 D3 并实施 | D3 的请求获得同意，修改完成 |
| R3.4 | 用固定任务集校准 `DEFAULT_KERNEL_CONFIG`（预算、Round、超时）；修改 M1 文档中的建议值时按 2.1 第 3 条请求 | 校准结果与依据记录在第 5 节 |
| R3.5 | Prompt 与工具说明定稿为 `FINAL`，按 AgentToolPool 的规则以 `v1.0.0` 发布并运行 `pnpm run catalog:seal`；Agent 定义随之引用新版本 | 定义目录测试通过；运行记录中的 digest 为封存版本 |
| R3.7 | 修复 R3.3 评测发现的收尾失败：DeepSeek 不一定遵守强制的工具选择，final-call 可能调用未提供的工具或给出不合法的 JSON 参数。model-call Executor 在 `final = true` 时把这种回复作为可重试的执行失败（带实际用量），Execution 与 Core 允许在用量已知时重试 MODEL | 修改 ExecutorSet.md 4.5、M1Interface、Execution.md 第 6 节、Core.md 5.1（2026-10-25 已同意）；强制收尾的真实模型评测中收尾失败显著减少 |
| R3.6 | 定稿后用真实模型重跑 F1–F5，形成成功率、来源完整性、成本与延迟基线（M1Plan 第 2 节第 10 项） | 全部任务到达可解释终态；无来源的成功结论为 0；基线记录完整 |

退出条件：R3.1–R3.6 完成；M1Plan 第 7 节中与真实模型相关的条件满足。

### 4.5 阶段四：功能冻结、安全与回归

进入本阶段即冻结功能：之后只允许修复缺陷、补充测试与文档。

| ID | 任务 | 完成标准 |
|---|---|---|
| R4.1 | 逐条核对 M1Plan 第 7 节完成定义，每条附验证证据（测试名、运行记录或命令输出） | 全部满足 |
| R4.2 | 逐条核对 M1Plan 第 8 节发布阻断项 | 不存在任何阻断项 |
| R4.3 | 核对 M1Interface、SharedContracts、AgentToolPool 与代码 Schema、定义文件一致；不一致时列出差异并按 2.1 第 3、6 条处理 | 无未处理的差异 |
| R4.4 | 确认写入、命令、测试、网络与 workspace 逃逸的成功次数为 0；Unsupported 请求不产生状态变化；预算可以确定性终止 | 对应测试与 F1–F5 运行记录可以证明 |
| R4.5 | 在 Ubuntu 24.04 LTS 上运行 `pnpm run check`、`pnpm run test:coverage`、`demo:fake`、离线 E2E 与兼容矩阵；连续三次全部通过 | 记录结果 |
| R4.6 | 冻结协议：把 `packages/libraries/contracts/test/compatibility/schema-snapshot.json` 的 `frozen` 置为 `true`（M1Interface 1.2、M1TechStack 第 11 节），此后快照只能由兼容修改通过守卫 | 守卫在冻结状态下通过 |

退出条件：R4.1–R4.5 完成。

### 4.6 阶段五：文档、合并与发布

| ID | 任务 | 完成标准 |
|---|---|---|
| R5.1 | 整理限制清单、运行说明（安装、配置、API key、`multiagentos analyze` 用法、退出码）与验收证据报告；需要写入 `docs/M1/` 的内容按 2.1 第 3 条请求 | 文档与实现一致，Cary 审阅通过 |
| R5.2 | 更新根 README 与 `docs/README.md` 的索引 | 无失效链接 |
| R5.3 | 整理仍开着的 Issue（#4–#32），草拟每个 Issue 的处理意见（关闭、记录结论或转入后续） | 意见经 Cary 确认后执行 |
| R5.4 | 草拟 `feature/M1/main -> feat/M1` 的 PR，经 Cary 确认后发布；使用 merge commit | PR 合并，`feat/M1` 上 CI 通过 |
| R5.5 | 草拟 `feat/M1 -> main` 的发布 PR，按 Style 4.5 与 6.2 列出 M1 的最低验收标准与对应验证结果，经 Cary 确认后发布；使用 merge commit | PR 合并 |
| R5.6 | 记录发布：版本标识 `M1`、发布 PR 与对应的 `main` 提交 | 记录完成，本计划标记为已完成 |

退出条件：M1 已通过发布 PR 合入 `main`。

## 5. 进度记录

| ID | 完成日期 | 提交 | 验证证据与备注 |
|---|---|---|---|
| R0.1 | 2026-10-24 | 不适用 | WSL Ubuntu 24.04 安装 ripgrep 14.1.0，与 CI 一致 |
| R0.2 | 2026-10-24 | 不适用 | `d041637`：build、lint、format:check 通过；测试 86 个文件、1089 项全部通过，0 项跳过 |
| R0.3 | 2026-10-24 | `docs: 归档 Kernel 工作文档并新增 M1 发布工作计划` | 八份文档改名移动，内容只改相对链接；仓库内相对链接检查 0 处失效 |
| R0.4 | 2026-10-24 | 同上 | README 与当前实现一致 |
| R0.5 | 2026-10-24 | 同上 | 本文件入库 |
| R1.5 | 2026-10-24 | `fix: 按 #26 的答复修正被删除文件的拒绝原因与测试文件的检索得分` | 先增加复现用例；ExecutorSet.md 3.2 同步；WSL 上 1091 项测试通过 |
| R1.6 | 2026-10-24 | 同上 | 增加固定得分的用例；ExecutorSet.md 3.3 同步 |
| R1.1 | 2026-10-24 | `test: 修复关闭路径上的不稳定用例并补齐 rg 与工具调用应答的检查` | 两处 rg 相关测试在 `CI` 下增加“找到 rg”用例；`CI=1` 下运行通过 |
| R1.2 | 2026-10-24 | 同上 | 原因：故障后假 Kernel 核心仍在执行的 Unit 在 Supervisor 开始停止后才提交，被拒绝后假核心把它记为自身错误，使 `stop()` 失败，多出 `supervisor`、`module-host` 两项故障。产品 Kernel 按 Kernel 4.4 把这种发送失败转为运行级 `KERNEL_FAULT`，假核心改为同样处理。增加确定性复现用例（修复前稳定失败）；两个用例的退出码按已有约定接受 1 或 70。CPU 压力下连续运行 50 次，0 次失败 |
| R1.3 | 2026-10-24 | 同上 | fast-check 生成合法、未知、参数错误、重复、混入控制动作的工具调用与随机结果和额度状态，检查每次 context-assemble 输入与最终步骤；去掉对 FEEDBACK 的认可后性质立即失败，确认用例有效 |
| R1.4 | 2026-10-24 | 不适用 | #24–#29 已答复的决定全部落实；#32 中未落实的事项已分别由 D3、R1.8、R3.2、D8 跟踪 |
| R1.8 | 2026-10-25 | `feat: 端口响应期限改由系统配置与 Fabric 统一执行` | M1 文档修改经 2026-10-25 确认：M1Interface 14.3、14.4，Fabric.md 第 3 节，Workflow.md 11.1，UserInteraction.md 第 6 节，M1TechStack 第 4 节。`SystemConfig.portReturnTimeoutMs` 默认 30000；Workflow 与 UserInteraction 的 Fabric 客户端和交给 Workflow 的 Catalog、Persistence 到期以 `FabricError(REQUEST_TIMEOUT)` 拒绝，Kernel 的客户端不设期限；两个模块删除各自的计时器，原有期限用例改为注入超时拒绝，迟到返回的用例移到 Fabric。WSL 上 1101 项测试通过 |
| R2.5 | 2026-10-25 | `ci: 确定 Ubuntu 24.04 并建立兼容矩阵与协议冻结守卫` | D7 结论写入 M1Plan 第 7 节、M1TechStack 第 11 节；README、Style、docs/README 与 M1 文档中的 Ubuntu LTS 统一为 24.04。CI 增加 Node 上界与无 rg 两格；两处 rg 检查改为按 `MULTIAGENTOS_RIPGREP` 断言。协议快照 101 个 Schema。WSL：主格 1112 项通过；无 rg 格（PATH 中去掉 rg）1101 项通过、14 项 rg 专属用例跳过，demo 通过；有 rg 而格子声明无 rg 时检查失败。Node 上界格本机没有其他 Node 版本，由 CI 验证 |
| R1.9 | 2026-10-25 | `fix: 收口阶段一遗留问题：执行请求及时发出、非 UTF-8 文本与 CI 版本来源` | 原因：Execution 的 FIFO 在 `#pump` 中以不等待的方式启动下一个尝试；构造请求要先读取产物，派发可能发生在启动它的那条消息已经 flush 之后，`execute` 请求便留在 egress 的待发队列里，直到下一条无关消息到来。正常负载下 stage6 的 CONTEXT_ASSEMBLE 偶尔落在这个窗口（CPU 满载约 1/50）；验收工具的 F2 在一轮两次读文件之后每次都会卡住。修复：异步启动结束后调用 `onSettled`（即 `flushPending`）。Execution 增加回归用例；去掉修复后该用例与 F2–F5 立即失败。CPU 满载下 stage6 连续 100 次 0 失败 |
| R2.1 | 2026-10-25 | `test: 建立固定任务集验收工具与 #6 安全陷阱，补充 Prompt 规则与验收证据草稿` | fixture 见 `repos/bookshelf` 与 `tasks.ts`（第 6 节 A4），2026-10-25 经 Cary 审阅同意 |
| R2.2 | 2026-10-25 | 同上 | `harness.ts`：准备仓库并比对前后摘要，经 CLI 解析与全部产品部件运行，检查终态、来源、禁止路径、检索次数与密钥，生成运行记录；`pnpm run acceptance` 运行真实模型（本机无 key，未实际运行，见 A1） |
| R2.3 | 2026-10-25 | 同上 | 离线 F1–F5 进入 `pnpm run test`，因此也进入兼容矩阵三格；脚本化的服务商拒绝一切非服务商主机 |
| R2.4 | 2026-10-25 | 同上，以及 `fix: 收口阶段一遗留问题：执行请求及时发出、非 UTF-8 文本与 CI 版本来源` | S1 密钥、S2 注入、S3 死循环、S4 超大与二进制文件、S5 GBK 与中文文件名全部通过；S5 暴露的乱码按 A2 修复。WSL 质量门：88 个文件、1125 项通过，2 项为 CI 专属 rg 检查 |
| R3.2 | 2026-10-25 | `test: 建立固定任务集验收工具与 #6 安全陷阱，补充 Prompt 规则与验收证据草稿` | #32 第 3 节逐条落实：单次读取覆盖来源、概览与检索不作来源、同一回复不重复调用、已成功的调用只在结果被省略后重做、空文件不作来源、未获授权时立即如实结束（code-viewer）；planner 只能交接或结束。Prompt 仍为 v0.1.0 草稿，定稿与封存属于 R3.5 |
| R4.3（预检） | 2026-10-25 | `test: 建立固定任务集验收工具与 #6 安全陷阱，补充 Prompt 规则与验收证据草稿` | SharedContracts 第 3 节的 90 个 Schema ID 与注册表一致（另 11 个 opaque Ref 按 family 列出）；它提到的 39 个文件、全部目录都存在；AgentToolPool 第 4 节的 16 个定义与文件逐一对应。发现两处不一致并修正（A6）：AgentToolPool.md 引用的两份 Prompt 未随 R3.2 更新；M1Interface 中 9 个没有单独 Schema ID 的类型未在 SharedContracts 中给出落点。新增文档与定义文件逐行比对的测试。阶段四正式核对时重做 |
| R1.7 | 2026-10-25 | `test: 建立固定任务集验收工具与 #6 安全陷阱，补充 Prompt 规则与验收证据草稿` | D6 写入限制清单草稿（`M1AcceptanceEvidence.md` 第 3 节），R5.1 定稿 |
| R4.1、R4.2、R4.4（草稿） | 2026-10-25 | 同上 | `M1AcceptanceEvidence.md` 第 1、2 节逐条列出证据与状态：离线条件全部满足，真实模型相关的条件待 A1；阶段四正式核对时重做 |
| R5.3（草稿） | 2026-10-25 | 同上 | 处理意见草稿见 `M1AcceptanceEvidence.md` 第 5 节；未在 GitHub 上执行任何操作 |
| R5.1（部分） | 2026-10-25 | 同上 | README 增加授权与取消、`--details`、`MULTIAGENTOS_CONFIG`、退出码表与验收命令；限制清单与验收证据见 `M1AcceptanceEvidence.md`。是否需要写入 `docs/M1/` 待 Cary 决定 |
| R3.1 | 2026-10-25 | `fix: 真实模型联调：总额度校准、收尾说明只留一处、收尾调用按已知用量重试` | Ubuntu 24.04 上以 `deepseek-flash@v1.0.0`、Prompt `v0.1.0` 经完整调用链运行 F1–F5 各 3 次：15/15 通过，全部 COMPLETED、非降级、额度状态 NORMAL；每次运行的预期来源都被结论引用，禁止路径未被读取，工作区摘要不变，密钥未出现。共 136 条已核验结论；48 条进入 `unconfirmed`，其中 47 条为模型自己标注的未确认项，1 条（F2）因来源不在读取范围内被来源核验降级。首轮失败清单为空。单次 13–30 秒，中位数 19.9 秒；单次最多 50835 token（额度 600000）、9 次模型调用；15 次共 0.092 美元。人工抽查 F1、F5 的报告与 fixture 源码一致。记录见验收证据第 6 节 |
| R3.4 | 2026-10-25 | `fix: 真实模型联调：总额度校准、收尾说明只留一处、收尾调用按已知用量重试` | 2026-10-25 Cary 同意把 `tokenLimit` 减半为 300000（Monitor.md 第 4 节同步）。依据 R3.1：单次最多 50835 token；收尾在剩余不足 `finalReserve + wrapUpMargin`（184384）时开始，即已用超过 115616 后，约为实测最大值的 2.3 倍。最坏情况下（全部按输出价、高峰倍率）单次约 0.36 美元，此前为 0.72 美元。其余数值不变：code-viewer 最多用 8 / 20 轮、planner 1 / 3 轮，最长运行 30 秒、最长模型调用远低于 `MODEL` 的 180 秒，没有出现收尾、超时或额度不足 |
| R3.3 | 2026-10-25 | `fix: 真实模型联调：总额度校准、收尾说明只留一处、收尾调用按已知用量重试` | 评测：把 `tokenLimit` 临时压到 196384，使每次运行在 3–4 轮后进入收尾，三种做法（两处都有、只保留状态行、只保留反馈）各跑 F1–F5 × 2，共 30 次、0.13 美元；30 次都发起了 final-call，收尾后正常出报告 8/10、8/10、9/10，差别在误差范围内。按设计只保留状态行（D3）。Workflow 不再记录收尾反馈，`ROUND_FEEDBACK_CODES` 去掉 `WRAP_UP_NOTICE`，协议快照更新。评测同时发现 5 次收尾失败与 D3 无关：原样重放这些请求 15 次，6 次调用了请求中未提供的 `read_file`，1 次参数不是合法 JSON，转为 R3.7 |
| R3.7 | 2026-10-25 | `fix: 真实模型联调：总额度校准、收尾说明只留一处、收尾调用按已知用量重试` | M1 文档修改经 2026-10-25 同意：ExecutorSet.md 4.5、M1Interface（原因码 `PROVIDER_TOOL_CHOICE_IGNORED`）、Execution.md 第 6 节、Core.md 5.1、Interaction.md 的 `retryExecution`。model-call Executor 在 `final = true` 时，回复不是恰好一次强制控制工具的调用或参数不是合法 JSON，返回可重试的失败并带用量；Core 在 MODEL 请求未发出、或已发出且用量已知时允许重试，按实际用量结算旧预留。开发评测工具 `agent-loop.ts` 按 Workflow 7.2 把收尾失败改为降级。验证：同样把额度压到 196384，F1–F5 × 3 共 15 次全部进入收尾、全部正常出报告（修复前 30 次中 5 次收尾失败），其中 2 次经技术重试恢复；0.073 美元 |
| R3.5 | 2026-10-25 | `feat: Prompt 与工具说明定稿，全部定义封存为 v1.0.0 并取得真实模型基线` | 依据 R3.1、R3.3 与 R3.7 的评测，两个 Prompt 与四个 Tool 的说明不再修改，`contentStatus` 改为 `FINAL`。封存的定义只能引用已封存的版本，因此 14 个草稿全部以 `v1.0.0` 发布并运行 `pnpm run catalog:seal`，`v0.1.0` 草稿删除（保留在 git 历史中）；Workflow 的 `entryAgentRef` 与引用实际目录的测试随之更新，AgentToolPool.md 第 4 节逐行对应封存文件（文档比对测试通过），第 9 节遗留事项清空，Workflow.md 第 12 节同步。封存时发现 `catalog:seal` 会重新序列化 YAML、改掉作者的格式（`[repo.read]` 变为 `[ repo.read ]`，`format:check` 不通过），改为只插入 `digest` 一行，并增加回归用例（去掉修复后失败） |
| R3.6 | 2026-10-25 | `feat: Prompt 与工具说明定稿，全部定义封存为 v1.0.0 并取得真实模型基线` | 提交 `49efce0` 上运行 F1–F5 各 3 次：15 次全部 COMPLETED、非降级、额度 NORMAL，142 条结论全部有已核验来源，无来源的成功结论为 0；运行记录中的 digest 为封存版本。运行时验收工具判定 14/15：F5 一次报告正确但未引用 `event-bus.ts` 的 `publish`，属于预期来源断言比问题更严；经 Cary 同意，F5 改为接受总线的 `publish` 或发布调用二者其一，按新断言 15/15。成本共 0.086 美元（平均 0.0058），延迟中位数 19.0 秒、最长 30.4 秒，单次最多 44797 token。基线见验收证据第 7 节 |
| R4.5（未完成） | 2026-10-25 | 不适用 | 第 1 轮 `pnpm run check` 通过（88 个文件、1126 项）；随后的 `test:coverage` 因本机内存不足被 Claude Code 中止，按要求未自动重跑。待 Cary 回来后再运行连续三轮 |

## 6. 自主执行期间的决定（待 Cary 复核）

2026-10-25 起 Cary 离开期间，按其授权自主推进：有歧义处尽量按 M1 规划实现；认为必须修改 M1 文档时按最推荐的方式修改，
并在此逐条记录，供 Cary 回来后二次选择。所有提交只保存在本地，不推送远端；不发布、评论或关闭任何 Issue 与 PR。

2026-10-25 Cary 复核：A1 同意，并提供 key，R3.1 已补跑（第 5 节）；A1–A6 全部同意（A4 含 fixture 审阅）。

| ID | 日期 | 事项 | 采用的做法 | 其他可选做法 | 涉及的文件与提交 |
|---|---|---|---|---|---|
| A1（已复核） | 2026-10-25 | 本机与 WSL 都没有 `DEEPSEEK_API_KEY`，阶段三的真实模型运行（R3.1、R3.6 及依赖它们的 R3.3、R3.4）无法进行 | 跳过真实模型运行，其余不依赖模型的任务照常推进；阶段三中依赖评测结果的决定保持待定 | 由 Cary 提供 key 后补跑 | 无 |
| A2 | 2026-10-25 | #6 要求 GBK 编码文件不导致乱码；原实现把任何不含 NUL 的文件按 UTF-8 解码，GBK 内容变成替换字符进入上下文 | 把“文本文件”定义为不是二进制且能按 UTF-8 完整解码：这类文件不进入文件集合（概览、检索与快照），`read_file` 返回 `REJECTED(UNSUPPORTED_FILE)`，模型看到的说明改为“目录、二进制或非 UTF-8 文本”。修改 ExecutorSet.md 3.1、3.2 第 6 步与 M1Interface 原因码表中 `UNSUPPORTED_FILE` 的说明 | ① 识别 GBK 等编码并转成 UTF-8（需要编码探测，误判风险高）；② 保持原样，把乱码记为已知限制 | ExecutorSet `text-document.ts`、`file-set.ts`、`guarded-file.ts`、`history-render.ts` 与测试；提交见第 5 节 R2.4 |
| A3 | 2026-10-25 | D8：`executor-set/eval/agent-loop.ts` 自带简化的 Agent 循环，评测结果不代表产品 | 按 D8 的建议定论：M1 验收只采用验收工具（`apps/control-plane/test/acceptance/`）经产品调用链得到的结果；`agent-loop.ts` 保留为 ExecutorSet 的开发工具，不作为验收证据 | 删除 `agent-loop.ts`；或改造它复用产品调用链 | 第 3 节 D8 结论列 |
| A4 | 2026-10-25 | R2.1 要求五个 fixture 由 Cary 审阅；验收工具的形态（M1Plan 只说“经权威调用链”） | fixture 用一个固定的小型 TypeScript 仓库 `bookshelf` 承载 F1–F5，问题不含答案文件名；验收工具在进程内按 `main` 的同一组合方式装配全部产品部件，经 CLI 解析运行，离线时只替换模型服务商的 HTTP 接口，真实模型时用 `pnpm run acceptance`（先列出次数与费用上限，加 `--yes` 才运行）。#6 的五条风险落实为同一工具下的陷阱任务 S1–S5（仓库 `traps`，超大、二进制与 GBK 文件在运行前生成，不入库） | 每个任务一个独立仓库；验收工具以子进程运行 `bin.js analyze`（离线时需要可替换服务商地址的产品接口） | `apps/control-plane/test/acceptance/`；待 Cary 审阅 fixture 后 R2.1 才算完成 |
| A5 | 2026-10-25 | D4：启动检查中 code-viewer 的普通调用为 79156 / 80000（固定段 62772 + FILE_READ 16384），收尾调用 61777 / 64000；按 #32 第 3 节补充 Prompt 几乎没有余量 | 保留最坏转义的估算方法（它保证不可裁剪段在任何输入下都放得下），把建议值 `perCallInputLimit` 上调到 96000、`finalInputBudget` 上调到 72000；`tokenLimit` 600000 仍满足 `≥ finalReserve + wrapUpMargin`（184384）。修改 Monitor.md 第 4 节的表与说明、`DEFAULT_KERNEL_CONFIG` | ① 改用不那么悲观的估算（如按原始 UTF-8 长度），需修改 Monitor.md 的估算规则，且失去最坏情况保证；② 维持 80000/64000，Prompt 只能压缩 | `kernel-config.ts`、Monitor.md、`startup-config.test.ts`（收尾窗口用例的取值随之调大）；按 R3.2 补充 Prompt 后为 79557 / 96000 与 62178 / 72000。R3.4 用真实模型校准时可再调整 |
| A6 | 2026-10-25 | R4.3 预检发现的文档不一致：AgentToolPool.md 第 4 节引用的 Prompt 与文件不同（R3.2 只改了文件）；M1Interface 的 `RunEnd`、`KernelToWorkflowEvent`、`KernelToInteractionEvent`、`InboxEvent`、`ExecutorInput`、`DefinitionHeader`、`DefinitionByKind`、`InvalidActionReason`、`PersistenceNamespace` 没有单独的 Schema ID，SharedContracts 也没有说明它们落在哪里 | 按 M1Interface 1.1“发现不一致时以本文为准，并修正另外两份”：AgentToolPool.md 改为与定义文件一致；SharedContracts 新增 3.11 节列出这 9 个类型的落点；agent-tool-pool 增加文档引用与定义文件逐行比对的测试，防止再次漂移 | 把这些类型注册为单独的 Schema（会改变 Schema 清单与快照，不必要） | AgentToolPool.md、SharedContracts.md、`definitions-directory.test.ts` |
