# MultiAgentOS M2 技术栈

> 状态：实测已填，待评审。第 3 节已填入 2026-10-31 的实测结果；第 4 节的新增依赖在所属阶段的文档门中确定。

## 1. 目的与权威

本文记录 M2 的运行环境、技术选择、新增依赖与阶段 0 的实测结果。
机制与设计以 [M2Design](M2Design.md) 为准；实测结果与 M2Design 不符时，先发布 M2Design 新版本，再改本文。
M2 沿用 M1 的工程基线（[M1TechStack](../History/M1/M1TechStack.md)），本文只写增加与改变的部分。

## 2. 运行与工程基线

| 项目 | 选择 | 相对 M1 |
|---|---|---|
| 平台 | Ubuntu 24.04 LTS（验收平台）；WSL2 中的 Ubuntu 24.04 用于日常验证 | 不变；沙盒相关的测试只能在这两种环境中运行 |
| Runtime、包管理、语言、Schema、测试、质量门 | Node.js `>=24.19.0 <25`、pnpm、TypeScript、TypeBox、Vitest 与 fast-check、ESLint 与 Prettier | 不变，版本见 M1TechStack 第 2 节 |
| 协议版本 | 发布版只有 major 1（`.v1`）；M1 的 major 0 在阶段 1 接线后删除 | 改变 |
| 系统依赖 | `bubblewrap`（`bwrap`）、`git`、`rg`（可选，M1 已有） | 新增 `bwrap` 与 `git` |

## 3. 阶段 0 实测

### 3.1 bubblewrap（任务 S0-T-1）

**环境**：每一项分别在 Ubuntu 24.04（原生）与 WSL2 中的 Ubuntu 24.04 上，以非特权用户运行。
WSL 的结果取自 2026-10-31：Ubuntu 24.04.5、内核 `6.18.33.2-microsoft-standard-WSL2`、`bubblewrap 0.9.0`；
AppArmor 未启用（`/sys/module/apparmor/parameters/enabled` 为 `N`），`kernel.apparmor_restrict_unprivileged_userns` 不存在。
原生的结果取自同日 GitHub Actions 的 `ubuntu-24.04` 运行器（工作流 `sandbox-probe`，运行 41169485463）：Ubuntu 24.04.5、内核 `7.0.0-1017-azure`、`bubblewrap 0.9.0`；
AppArmor 已启用，`kernel.apparmor_restrict_unprivileged_userns` 为 `1`，与 Ubuntu 24.04 的默认限制一致。它是 Azure 虚拟机，内核不是桌面版的 `generic`。
检查写在 `scripts/sandbox-probe.sh`，共 65 项，覆盖仓库位于 `$HOME` 之外、之内与 `/tmp` 下三种布局；原生一列是下文"修复之后"的结果。

| 原生场景 | 配置 | 结果 |
|---|---|---|
| 原样 | 限制为 `1`，没有修复 | **不可用**：`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`，完整 profile 启动失败 |
| AppArmor profile | 限制仍为 `1`，只给 `/usr/bin/bwrap` 加 profile | 65 项全过 |
| 放开限制 | `sysctl kernel.apparmor_restrict_unprivileged_userns=0` | 65 项全过 |

| # | 检查项（M2Design 第 6.1、6.2、14.1 节） | 预期 | 原生结果 | WSL 结果 |
|---|---|---|---|---|
| 1 | 以完整 profile 运行 `/bin/true`（可用性探测） | 成功；不成功时记录原因与修复方法 | 修复之后通过；原样不可用（见上表） | 通过 |
| 2 | 先以 tmpfs 遮蔽 `$HOME`，再只读挂回白名单目录与仓库，再以 `--bind` 挂载可写根目录 | 挂载顺序生效；白名单外的 `$HOME` 内容不可见 | 修复之后通过 | 通过；挂回目录只读，其中的凭据文件可遮蔽；只把 `src` 作为可写根目录时，其外部不可写。**`--tmpfs /tmp` 必须排在仓库挂载之前**，否则位于 `/tmp` 下的仓库被整个遮住 |
| 3 | 以 `/dev/null` 只读覆盖单个敏感文件（如 `.env`）；以空 tmpfs 覆盖目录 | 命令读到空内容；写入失败 | 修复之后，空文件遮蔽通过；`/dev/null` 的写法未在原生上测 | **不符**：`--ro-bind /dev/null` 读取返回 `Permission denied`（字符设备在 bwrap 的 `nodev` 挂载下不可用）；`--dev-bind /dev/null` 可读但写入静默成功。改用**空的普通文件**（`--ro-bind <空文件>` 或 `--ro-bind-data`）：读到空内容、退出码 0，写入报 `Read-only file system`，宿主文件不变；同一个空文件可以同时遮蔽多个路径。空 tmpfs 覆盖目录通过 |
| 4 | 以 `--ro-bind` 重新挂载已存在的 `.git/`、`.multiagentos/`、`AGENTS.md` | 只读；运行结束后宿主仓库中没有新增文件或目录 | 修复之后通过 | 通过（含子目录的 `AGENTS.md`）；挂载目标不存在且父目录只读时，bwrap 报错退出（退出码 1），不留下文件 |
| 5 | 命令在可写根目录中新建 `.git/hooks/x` 与 `AGENTS.md` | 能在沙盒内新建；运行后由事后检查发现（M2Design 第 6.1 节"新建保护"） | 修复之后通过 | 通过：新建的文件出现在宿主仓库中，符合设计中由事后检查处理的前提 |
| 6 | `--unshare-net`：访问外部地址与回环地址 | 失败 | 修复之后通过 | 通过：两者 `curl` 退出码 7；宿主上同样的地址可以访问 |
| 7 | `--unshare-pid`、`--die-with-parent`：杀死 bwrap 后，沙盒中的子进程全部结束 | 没有残留进程 | 修复之后通过 | 通过 |
| 8 | 对进程组先 SIGTERM、再 SIGKILL（M2Design 第 4.7 节） | 在宽限期内结束；记录实际耗时 | 修复之后通过，SIGTERM 发给外层同样到不了命令；发给内层时 11 ms 结束，SIGKILL 后 11 ms 结束 | **不符**：`--new-session` 使沙盒内的进程处在新的会话与进程组中，发给外层 bwrap 进程组的 SIGTERM 到不了命令，命令的处理函数不运行（外层退出后整个命名空间被直接杀死）。应以 `--json-status-fd` 取得 `child-pid`，它就是内层进程组号：对它发 SIGTERM，处理函数运行；忽略 SIGTERM 的命令继续存活，对外层进程组发 SIGKILL 后 7 ms 内全部结束，无残留 |
| 9 | 环境变量白名单：沙盒中 `env` 的输出 | 只有白名单中的变量 | 修复之后通过 | 通过：`--clearenv` 后只有 `HOME`、`LANG`、`PATH`、`TERM`，以及 shell 自己设置的 `PWD` |
| 10 | 在仓库位于 `$HOME` 之内、之外两种布局下重复 2–4 | 结果相同 | 修复之后通过（另加 `/tmp` 布局） | 通过（第 3 项的不符在两种布局下相同） |

**结论**：两种环境中完整 profile 都能以非特权用户运行，隔离目标都能达到；原生 Ubuntu 24.04 必须先处理 AppArmor。三处写法需要按实测调整，已写入 M2Design v1.10：
敏感文件用空的普通文件遮蔽，不用 `/dev/null`；`--tmpfs /tmp` 排在仓库挂载之前；SIGTERM 发给 `--json-status-fd` 报告的内层进程组，SIGKILL 发给外层。

可用的最低配置：`bubblewrap 0.9.0`。AppArmor 的修复步骤（写入使用说明）：首选在 `/etc/apparmor.d/bwrap` 写入下面的 profile，再运行 `sudo apparmor_parser -r /etc/apparmor.d/bwrap`，它只放开 bwrap，全局限制保持不变；

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

后备方法是 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`，它放开整台机器，并且重启后失效。

### 3.2 DeepSeek 思考模式（任务 S0-T-2）

**环境**：M1 使用的模型定义 `deepseek-flash@v1.0.0` 与 `deepseek-v4-pro@v1.0.0`；OpenAI 兼容接口 `https://api.deepseek.com/chat/completions`，2026-10-31 调用。
结果对两个模型相同，有差别处单独注明；采样次数不大，比例只说明这一次观察。

| # | 检查项（M2Design 第 9.4、14.1 节） | 预期 | 结果 |
|---|---|---|---|
| 1 | 带工具的多轮请求中回传之前各轮的 `reasoning_content` | 正常返回 | 正常返回 |
| 2 | 带工具的多轮请求中不回传思考内容 | 记录是返回 400、静默停止还是正常 | 取决于服务端是否记得这次工具调用：思考开启时由 API 产生的 `tool_call_id`，不回传也返回 200；把编号改掉、或编号由客户端构造，同样的请求返回 400（"`reasoning_content` … must be passed back"）。没有观察到静默停止。回传内容与原文不同也返回 200，内容不被校验。**依赖服务端的记忆不可靠（保留时长未知），按必须回传处理** |
| 3 | 历史中某一轮没有思考内容（例如那一轮关闭了思考），以空字符串补齐 | 记录 API 的实际行为 | 带工具调用的轮不带字段时 400，补空字符串时 200。没有工具调用的纯文本轮不带字段也是 200（官方文档写的是必须回传）。**一律补空字符串** |
| 4 | 收尾调用：只提供结束控制工具、`tool_choice = auto`、思考开启 | 记录模型调用结束工具的比例 | flash 10/10，v4-pro 5/5 |
| 5 | 收尾调用重试：关闭思考、强制工具选择 | 与 M1 的行为一致 | 关闭思考加按名称强制：flash、v4-pro 各 3/3 成功，与 M1 一致。**思考开启时**按名称强制或 `required` 都返回 400（"Thinking mode does not support this tool_choice"），重试必须关闭思考 |
| 6 | 思考强度：API 是否支持分档；支持哪些取值 | 给出 `none`、`low`、`high`、`max` 到 API 参数的映射；不支持分档时写明降级方式 | 接受 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（其他值 422）。官方文档的映射：`minimal`、`low` → low；`medium`、`high`、`xhigh` → high；`max` → max；缺省为 high。映射：`none` → `thinking: disabled`；`low`、`high`、`max` → `thinking: enabled` 加同名 `reasoning_effort`。**不要用 `reasoning_effort: none` 关闭思考**：同时写了 `thinking: enabled` 时仍然思考。不写 `thinking` 字段时缺省开启。v4-pro 的提示 token 随档位变化（low 18、high 97、max 110），flash 各档都是 44；flash 三次采样中只有 `max` 的思考量明显偏高 |
| 7 | 用量：思考 token 是否计入输出用量、计价方式 | 写明额度估算（Monitor 的 `est`）应当如何计入 | **计入**：`completion_tokens` 包含 `completion_tokens_details.reasoning_tokens`；思考用尽 `max_tokens` 时 `finish_reason = length`、没有回复内容。`est` 不需要另加思考量，但 `maxOutputTokens` 要给思考留足。官方定价页没有单列思考 token，按输出计价是由用量字段得出的推断，未对账 |
| 8 | 提示词缓存：同一前缀的连续请求（末尾追加）的缓存命中量；带相同工具定义、`tool_choice = none` 的摘要请求是否命中同一缓存、是否仍会调用工具；不设 `tool_choice`、只在指令中要求不调用工具时的行为（DeepSeek Harness 的写法）；摘要请求关闭思考与开启思考时的命中量是否不同；关闭思考的请求中历史仍带 `reasoning_content` 时是接受、忽略还是报错（M2Design 第 9.2、9.6 节） | 记录 `prompt_cache_hit_tokens`；给出摘要请求的可行写法与 `summaryReasoningEffort` 的缺省值 | 只在末尾追加：约 99% 命中（约 3 万 token 的前缀）。**关闭思考的摘要首次命中 0**（各种写法、两个模型都如此），可见思考开关改变了前缀。思考开启且 `tool_choice = none`：`prompt_tokens` 少约 250（工具定义不再计入），命中不稳定（同档时 75%–99%，跨档时为 0）。思考开启、**工具定义保留、不设 `tool_choice`**、指令要求不调用工具：约 99% 命中，跨档也命中（仅 v4-pro 的 high 接 max 一次为 73%），观察到的摘要请求全部没有调用工具。`tool_choice = none` 时从未调用工具，即使用户要求调用（v4-pro 6/6、flash 10/10）。关闭思考而历史带 `reasoning_content`：返回 200。可行写法见结论 |
| 9 | 用量中的输入 token 是否包含缓存命中的部分；限流与过载时是否返回 `Retry-After` 及其格式 | 写明压缩的估算（M2Design 第 9.6 节）应当取哪个用量字段；写明 `retryAfterMs` 的来源（M2Design 第 7.4 节） | `prompt_tokens` 包含命中部分：全部 275 条用量都满足 `prompt_cache_hit_tokens + prompt_cache_miss_tokens = prompt_tokens`，压缩的估算取 `prompt_tokens`。`Retry-After` 未观察到：3 波各 20 个并发请求全部 200，响应中没有任何限流相关的头。官方文档只说超限返回 429（flash 并发 2500、v4-pro 500），不提 `Retry-After`。限流时的实际响应**没有测到** |

**结论**：

- `ThinkingFeature`（两个模型相同）：`replayReasoning = 'REQUIRED'`，`missingReasoningFill = 'EMPTY_STRING'`，`reasoningCountsAsOutput = true`；`effortMapping` 见第 6 项。第 3、6、7、9 项的结果已写入 Definitions 与 ExecutorSet。
- 收尾调用按 M2Design 第 9.4 节的两步可行，第二步必须关闭思考。
- `retryAfterMs`：按 ExecutorSet 第 7 节解析 `Retry-After`（两种格式），没有这个头时省略，按指数退避重试。这是对未观察到的响应的防御性实现。
- 摘要请求：原写法（`tool_choice = none`、关闭思考）首次不命中缓存，约 3 万 token 输入的成本约为命中时的 50 倍。M2Design v1.11 改为保留工具定义、不设 `tool_choice`、思考开启，`summaryReasoningEffort` 缺省 `low`；API 不保证模型不调用工具，调用时按摘要不合格处理。

### 3.3 阶段 6 实测：DeepSeek 搜索与抓取接口（任务 S6-T-1）

DeepSeek 在 2026-10-17 开放了自研的搜索与抓取接口（`POST https://api.deepseek.com/v1/tools/search`、`/v1/tools/fetch`，与模型共用 API key，各 0.75 美元 / 千次成功请求，搜索 100 QPS、抓取 25 QPS；规格以 <https://api-docs.deepseek.com/guides/search> 为准）。
它可能代替 Tavily 作为 `web_search` 的提供方，并省去 `web_fetch` 中的正文提取。官方文档没有写明的事项很多，**在实测证明可用之前，不得把它定为阶段 6 的提供方**；结论由 Cary 决定。

**官方文档没有写明、必须实测的事项**：抓取是否渲染 JavaScript、是否遵守 robots.txt、页面大小与超时上限、搜索词与 URL 的留存与隐私、敏感话题的结果、`rerank_score` 与 `authority` 是否有区分度。第三方文章中的限流数字（每秒 5 次）与官方不一致，以实测为准。

**实验**（脚本 `apps/control-plane/test/acceptance/web-eval/run-web-eval.ts`，与 `write-eval` 同样需要 `--yes` 才运行，密钥取自 `DEEPSEEK_API_KEY`，不打印、不写入记录；原始记录写入 `<out>/records.jsonl`，只含请求、状态码、耗时、结果摘要）：

| 编号 | 实验 | 通过标准 |
|---|---|---|
| W-T1 | 协议：以官方规格各调用一次；故意制造 401（错误 key）、400（查询超过 128 字符、`count` 越界）、404（不存在的地址）、403（私网、回环、元数据地址、`file://`）；空结果；请求体多出未知字段 | 状态码与错误体和官方文档一致；私网与回环地址不返回任何正文；空结果为 `results: []` 且 HTTP 200 |
| W-T2 | 搜索质量：不少于 20 个查询，覆盖中文与英文、代码报错信息、某个库的最新版本号、官方 API 文档、`site:` / `-site:` / `lang:` / `after:` / `before:` 算符、含敏感词的查询；每个查询记录结果数、前 3 条是否与问题相关（人工按预先写下的判据标注）、`date` 是否存在与是否合理、`rerank_score` 的分布 | 有明确答案的查询中，前 3 条含相关结果的不少于 80%；算符有效（`site:` 的结果全部在该域名内，`after:` 的结果日期不早于给定日期）；记录敏感词查询的空结果比例，不作为通过条件 |
| W-T3 | 抓取：不少于 20 个地址，覆盖静态文档站、GitHub 的 README、源码文件与 issue、需要 JavaScript 渲染的单页应用、PDF、超过 1 MB 的长页面、中文页面、多次重定向、404、禁止抓取的页面、需要登录的页面；每个地址记录是否成功、Markdown 的质量（标题、链接、代码块、表格是否保留）、耗时、是否被截断 | 静态文档站与 GitHub 页面的成功率不少于 90%，代码块与标题保留；其余类别如实记录，用于决定是否保留本地抓取（S6-EX-2） |
| W-T4 | 时延与限流：搜索与抓取各 30 次串行的耗时（p50、p95）；抓取以 30 个并发突发一次，观察 429 与 `Retry-After` | p95 在 10 秒以内；超限时返回 429 且可由重试恢复 |
| W-T5 | 计费：调用前后各读一次账户余额，成功 100 次、空结果 20 次、失败 20 次 | 扣费与"只对成功且有结果的请求计费"一致；空结果与失败不扣费 |
| W-T6 | 内容安全：以本地固定内容服务器之外的公开页面，取一个含"忽略之前的指示"类文字的测试页；用接口抓取，并确认返回的正文原样出现，由我们的封装标为不可信内容 | 正文不被接口改写；封装在工具结果中标出来源与"不可信"；模型在评测中不执行其中的指示 |
| W-T7 | 对照：用最小的本地实现（HTTP 取回、readability 提取、HTML 转 Markdown）抓取与 W-T3 相同的地址 | 记录成功率与质量差异，作为"保留或删除本地抓取"的依据 |

**费用**：不超过 200 次请求，按官方价目约 0.15 美元以内；只有 `--yes` 才运行，`--budget` 给出上限。

**结论的写法**：实测完成后，把汇总表、原始记录的位置和下列结论之一写在本节，并在 M2OpenDecisions 记录 Cary 的决定：

| 结果 | 阶段 6 的做法 |
|---|---|
| W-T1 至 W-T6 全部通过，W-T3 的各类别都可用 | `web_search` 与 `web_fetch` 都以 DeepSeek 为默认提供方；本地抓取不做，S6-EX-2 只保留地址检查、重定向检查与结果封装 |
| 搜索通过，抓取只覆盖静态页面（JavaScript 页面、PDF 等失败） | 搜索用 DeepSeek；抓取先用 DeepSeek，失败的类别回退到本地抓取（S6-EX-2 完整保留） |
| 搜索质量或限流不达标 | 搜索改用 Tavily，DeepSeek 抓取是否保留看 W-T3 |
| W-T1 或 W-T5 不达标（协议与文档不符、计费不符） | 不用 DeepSeek 的接口，按原方案使用 Tavily 与本地抓取 |

**实测结果（2026-11-07）**：见 [Evaluation/Stage6WebProviders](Evaluation/Stage6WebProviders.md)。搜索通过（16/16 相关、算符有效、p95 约 0.5 秒）；抓取静态页面与 GitHub 可用，PDF、reddit、长列表页有缺口，Markdown 丢链接与代码围栏，GitHub 页约 10 秒；计费与隐私无法由实验证明。落在上表第二行，提供方由 Cary 决定。

无论结论如何，`web_search` 与 `web_fetch` 都经提供方端口（`SearchProvider`、`FetchProvider`）调用，提供方可以替换；搜索词与抓取的地址是数据离开本机的通道，授权（`web.search`、`web.fetch`）、审计、密钥扫描与地址检查不因提供方而减少。留存与隐私的结论写入 [M2Security](M2Security.md) 的网络部分。
## 4. 新增依赖

每项依赖在所属阶段的文档门中确定版本与用途，并按 M1TechStack 第 13 节的规则评审。

| 用途 | 阶段 | 状态 |
|---|---|---|
| 终端界面（三个区域、活动区刷新、输入队列） | 1 | 已定：Ink 8.0.0（及其依赖 React 19.3.1；测试用 ink-testing-library 4.0.0）；只在 `apps/cli` 中使用，UserInteraction 经 `ConsoleView` 表达终端要求，不依赖 Ink（[Module/UserInteraction](Module/UserInteraction.md) 第 3 节） |
| 影子 git 快照（调用系统 `git`，不引入库） | 2 | 已定：系统 `git` |
| 沙盒（调用系统 `bwrap`，不引入库） | 3 | 已定：系统 `bwrap` |
| 命令的语法树拆分（M2Design 第 5.2 节） | 3 | 已定：`web-tree-sitter` 0.27.1 与 `tree-sitter-bash` 0.25.1 的 WebAssembly 语法文件（`tree-sitter-bash.wasm` 随包提供，不需要原生编译；`pnpm-workspace.yaml` 中 `allowBuilds` 对 `tree-sitter-bash` 为 `false`，不运行它的构建脚本），只在 ExecutorSet 的 `command/parse/` 中使用；E-EX-3 已引入（2026-11-05，Windows 与 Ubuntu 24.04 上测试通过） |
| 网页检索与抓取的提供方（DeepSeek 搜索与抓取接口，或 Tavily） | 6 | 待定：由第 3.3 节的实测（S6-T-1）证明可用后，Cary 决定；两者都经 `SearchProvider`、`FetchProvider` 端口调用，不引入 SDK，直接使用 Node 的 `fetch` |
| HTML 转 Markdown | 6 | 待定：M2Design 第 8.4 节倾向于把纯函数复制到 `vendor/` 并注明来源与许可证 |
| 模板 YAML 解析 | 1 | 不新增：沿用 AgentToolPool 已有的 YAML 1.2 core schema 解析（M1），内置模板与使用者模板都由它解析 |

## 5. 测试环境

- 沙盒、影子 git 与进程组相关的测试只在 Ubuntu 24.04 与 WSL2 中运行；在其他平台上跳过，并在测试报告中注明。
- 网页相关的测试只使用本地固定内容服务器，不访问真实网络。
- 真实模型评测只在阶段退出与发布时运行；日常测试使用确定性的 fake 模型。
