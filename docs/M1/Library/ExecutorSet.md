# MultiAgentOS M1 ExecutorSet

## 1. 定位

ExecutorSet 是静态库 `@multiagentos/executor-set`（目标位置 `packages/libraries/executor-set`），提供 M1 Unit 的原子执行行为。
每个 Executor 实现 [M1Interface](../M1Interface.md) 第 8 节的 `Executor` 接口，由 Supervisor 按 `executionKind`
装配并运行（见 [Supervisor](../Kernel/Supervisor.md)）。长期规划见 [ExecutorSet 架构](../../Architecture/Library/ExecutorSet.md)，
技术选择见 [M1TechStack](../M1TechStack.md) §8、§9。

Executor 只接收 Execution 解析后的输入与 Core 派生的范围约束，不持有 ArtifactStore、Lease、额度或运行状态，
不调用 Kernel、Workflow 或 UserInteraction。

## 2. Executor 清单

| executionKind | 实现 | 目录（`packages/libraries/executor-set/src/`） | scope.kind | 产物 |
|---|---|---|---|---|
| `REPOSITORY_ORIENT` | `RepositoryOrientExecutor` | `repository-orient/` | `REPOSITORY` | ORIENT ContextPack |
| `REPOSITORY_SEARCH` | `RepositorySearchExecutor` | `repository-search/` | `REPOSITORY` | SEARCH ContextPack |
| `FILE_READ` | `FileReadExecutor` | `file-read/` | `REPOSITORY` | 读取的文本 |
| `CONTEXT_ASSEMBLE` | `ContextAssembleExecutor` | `context-assemble/` | `NONE` | ASSEMBLE ContextPack |
| `MODEL` | `ModelCallExecutor` | `model-call/` | `MODEL` | `ModelRawOutput` |

三个仓库 Executor 共用 `repository-access/`。旧系统的文件读取、检索与 Provider 调用已从仓库移除，
可在提交 `e9bb4c3` 的 `apps/executor`、`packages/context-engine` 与 `packages/kernel` 中查阅；它们基于旧协议，只供参考，不得原样搬回。

`REPORT_PUBLISH` 不属于 ExecutorSet，由 Kernel 的 Execution 直接完成（见 [Execution](../Kernel/Execution.md) 第 5 节）。

包导出：

| 导出 | 用途 |
|---|---|
| `createExecutorRegistry(): ExecutorRegistry` | 组合根调用后把注册表注入 Supervisor；Kernel 包不导入 ExecutorSet。`ExecutorRegistry` 是按 `executionKind` 索引的对象（M1Interface 第 8 节） |
| `DEFAULT_EXCLUSIONS` | 硬编码的危险文件规则（第 3.2 节），与 Core 的默认排除规则相同 |

## 3. 仓库访问

`REPOSITORY_ORIENT`、`REPOSITORY_SEARCH`、`FILE_READ` 共用以下规则，实现为同一个 `RepositoryAccess` 模块。

### 3.1 文件集合与快照

- 文件集合：仓库根目录（`scope.repositoryRoot` 的 realpath）下的全部普通文件；不跟随符号链接；排除命中 `scope.exclusions`
  或 `DEFAULT_EXCLUSIONS` 的路径；排除二进制文件（前 8 KiB 含 NUL 字节）。M1 不读取 `.gitignore`，也不调用 git。
  遍历时跳过整棵被排除的目录（规则形如 `<前缀>/**`），不可读的目录与文件不进入集合。
- 文件数超过 `limits.maxFiles` 时返回 `REJECTED(LIMIT_EXCEEDED)`，遍历在超出时立即停止。
- 快照摘要：对文件集合按路径的 UTF-16 码元顺序排序（不使用 locale 排序），取每个文件的 `{ path, size, sha256 }`，
  计算规范 JSON 的 SHA-256；`snapshotId = 'snp_' + 摘要`。同一内容的仓库得到相同的 `snapshotId`。
- 注册表持有一个按 `(dev, ino, size, mtime, ctime)` 索引的摘要缓存，同一进程内重复检索只重新计算变化过的文件。
- 路径一律相对仓库根目录，使用 `/` 分隔。

### 3.2 路径检查

| 顺序 | 检查 | 不通过时 |
|---|---|---|
| 1 | `scope.kind` 为 `REPOSITORY` 且 `repositoryRoot` 为绝对路径 | `VIOLATION(SCOPE_MISSING)` |
| 2 | 输入路径为相对路径，不含 NUL，规范化后不含 `..` 段 | `REJECTED(OUT_OF_SCOPE)` |
| 3 | 命中 `DEFAULT_EXCLUSIONS` 或 `scope.exclusions` | `REJECTED(OUT_OF_SCOPE)` |
| 4 | 路径存在 | `REJECTED(NOT_FOUND)` |
| 5 | `realpath` 位于 `repositoryRoot` 内，且其相对路径同样不命中排除规则 | `REJECTED(OUT_OF_SCOPE)` |
| 6 | 是普通文本文件 | `REJECTED(UNSUPPORTED_FILE)` |
| 7 | 以 `O_NOFOLLOW` 打开；描述符的 `(dev, ino)` 与第 5 步 `stat` 的结果一致；Linux 上 `/proc/self/fd/<fd>` 指向的路径也与第 5 步一致 | `VIOLATION(PATH_ESCAPE)` |

`DEFAULT_EXCLUSIONS` 为 `.git/**`、`**/.env*`、`**/*.pem`、`**/*.key`、`**/id_rsa*`、`**/id_dsa*`、`**/id_ecdsa*`、`**/id_ed25519*`、
`**/node_modules/**`。
这些规则硬编码在 Executor 中，是 Core 权限裁决之后的最后一道防线；Core 只能追加排除规则，不能删除它们。
防护逻辑自身出现不一致（例如规范化后的路径在字面上越出根目录）时返回 `VIOLATION(GUARD_FAILURE)`。

规则的匹配语义（[#24](https://github.com/CaryHe-maker/MultiAgentOS/issues/24)）：规则相对仓库根目录；`**` 是完整路径段，
匹配零个或多个段；`*` 匹配一个段内的任意字符，`?` 匹配一个字符；以点开头的段同样参与匹配；区分大小写；其余字符按字面量匹配。
不使用 Node 的 `path.matchesGlob`：它的 `**` 不进入点目录，会使 `.hidden/key.pem` 绕过默认规则。

第 2 步还拒绝含反斜杠或盘符的路径，使同一路径在各平台含义相同。第 7 步比较文件身份而不是只看 `/proc`：
检查之后替换文件或其路径上的目录必然改变 inode，在 macOS 上也能检测与测试。超过 16 MiB 的文件返回 `REJECTED(LIMIT_EXCEEDED)`。

### 3.3 检索

| mode | 方法 |
|---|---|
| `TEXT` | 固定字符串匹配 |
| `PATH` | 在文件集合的路径中做子串匹配 |
| `SYMBOL` | 正则匹配声明（见下） |
| `AUTO` | `PATH` 与 `TEXT` 的结果合并，按得分排序；同一文件中行范围重叠的两条只保留得分高的一条 |

`SYMBOL` 的查询必须是 ASCII 标识符（可含 `.` 与 `::`），否则为 `INVALID_QUERY`。声明模式由以下几种择一组成，
只使用两个引擎含义相同的写法（无环视、ASCII 字符类，空白写作 `[ \t]`）：

- `\b(function|class|interface|type|const|let|var|def|fn|func|struct|enum|trait|namespace|module)[ \t]+<名称>\b`；
- `\bfunc[ \t]*\([^)]*\)[ \t]*<名称>\b`（Go 方法）；`#[ \t]*define[ \t]+<名称>\b`（C 宏）；
- 第 0 列开始的 `<类型> <名称>(`（C/C++ 函数）；带 `public`、`static`、`async` 等修饰符的 `... <名称>(`（Java、C#、TypeScript 方法）。

`TEXT` 为固定字符串匹配；查询是不含大写字母的 ASCII 时只折叠 A–Z 做大小写不敏感匹配，否则区分大小写。

- 检测到系统 `rg` 时（经 runner 执行一次 `rg --version`，按 runner 缓存），以参数数组调用：
  `--json --no-follow --no-ignore --hidden --no-config --text --sort path --max-filesize 1M`，每条排除规则加一个 `-g '!<规则>'`，
  区分大小写的 `TEXT` 模式加 `--fixed-strings`，大小写不敏感时改用 `(?i-u)` 加转义后的查询，`SYMBOL` 的 `\b` 写作 `(?-u:\b)`，
  最后为 `-- <模式> .`，工作目录为仓库根目录。`--no-config` 使用户的 `RIPGREP_CONFIG_PATH` 不影响结果；
  `--text` 把二进制判定交给文件集合（`rg` 会跳过 8 KiB 之后才出现 NUL 的文件）；`--sort path` 使输出被截断时保留的匹配固定
  （多线程的 `rg` 输出文件的顺序不定）。
  `rg` 经 `ExecutorEnvironment.subprocess` 启动，取消时由 Supervisor 终止；输出超过 `maxOutputBytes` 时只用完整的记录，结果标记为截断。
- 未检测到 `rg`、或 `rg` 以退出码 2 且无输出结束时，对第 3.1 节的文件集合做确定性扫描，每 32 个文件让出一次事件循环。
  两种后端都跳过超过 1 MiB 的文件；这些文件仍在快照中，可以用 `read_file` 分段读取。
- 每个命中都必须属于文件集合，并在读取片段时再做 realpath 与内容摘要核对（第 3.2 节第 2–5 步），不通过的命中直接丢弃。
- 两种后端只给出“哪一行匹配”，片段、得分与排序都由同一段代码根据文件内容计算，因此结果逐条相同。
- 得分（[#26](https://github.com/CaryHe-maker/MultiAgentOS/issues/26) E17）：`base × 次数因子 × 路径因子`，截断到 0–1 并保留 4 位小数。
  `base`：SYMBOL 1.0、PATH 0.9、TEXT 0.7；次数因子 `min(1, 0.6 + 0.1 × 文件内匹配行数)`；PATH 的文件名（或去掉扩展名后）
  与查询相同乘 1.1；路径含 `test` 乘 0.9；路径含 `dist`、`build`、`out`、`target`、`coverage`、`vendor` 段乘 0.8。
  `TEXT`/`AUTO` 模式下，若匹配行本身是该标识符的声明，这条命中记为 `SYMBOL`，使按名称检索时定义排在引用之前。
  排序为得分降序、路径、起始行，同一快照与查询得到相同结果。
- 查询去掉首尾空白后为空，或 `SYMBOL` 模式下不是标识符时，返回 `REJECTED(INVALID_QUERY)`。

## 4. 各 Executor 的行为

### 4.1 RepositoryOrientExecutor

计算文件集合与快照；生成深度 2 的目录树，以及 README 和包清单文件的前 40 行，写成 ORIENT ContextPack 的 `ORIENT` 段条目
（`provenance.retrieval = 'TREE'`）；按 `tokenBudget` 裁剪。输出 `RepositoryOrientOutput`，产物为该 ContextPack。

- 目录树条目：首行为快照、文件数与字节数；目录在前、文件在后，目录标出所含文件数。放不进预算时依次减少每层显示的条目
  （根 100/子 30 → 60/12 → 40/4 → 25/0 → 10/0），省略处写 `… N more`。树条目的 provenance 为 `path = '.'`。
- 摘录：根目录下的 README（`README` 或 `README.<扩展名>`，大小写不敏感）以及 `package.json`、`pyproject.toml`、`setup.py`、
  `Cargo.toml`、`go.mod`、`pom.xml`、`build.gradle`、`CMakeLists.txt`、`Makefile`，依次加入，放不下的跳过并计入 `droppedCount`。
  正文带行号；provenance 的 `contentSha256` 是这些行原文（与 FILE_READ 同一范围的返回内容相同）的摘要。
- `summary` 为文件数、字节数、根目录条目与已摘录的文件。

### 4.2 RepositorySearchExecutor

按第 3.3 节检索，命中前后各取 2 行作为片段，写成 SEARCH ContextPack 的 `SEARCH_HIT` 条目（带 `score` 与 `provenance`），
按 `maxItems` 与 `tokenBudget` 截断。输出 `RepositorySearchOutput`，产物为该 ContextPack。

### 4.3 FileReadExecutor

按第 3.2 节检查路径。缺省读取第 1 行到第 400 行；一次最多返回 400 行且不超过 `limits.maxOutputBytes`，
超出时截到满足两者的最后一个完整行，并在 `endLine` 中给出实际结束行；第一行本身就超过 `maxOutputBytes` 时返回 `REJECTED(LIMIT_EXCEEDED)`。
`startLine > endLine` 或 `startLine` 超出文件行数时返回 `REJECTED(INVALID_RANGE)`；空文件（0 行）且未给出行范围时返回空内容，
`startLine = 1`、`endLine = 0`、`totalLines = 0`。换行统一为 LF。输出 `FileReadOutput`，产物为读取的文本。

### 4.4 ContextAssembleExecutor

按 M1Interface 6.3 的段顺序生成 ASSEMBLE ContextPack：

| 段 | 内容 | 角色 |
|---|---|---|
| INSTRUCTIONS | `instructions` | system |
| TOOLS | `toolSpecs`（final 时只有 finish 控制工具） | system |
| OBJECTIVE | `objective` | user |
| HANDOFF | `handoff`（存在时） | user |
| ORIENT | `orientPack` 的条目（存在时） | user |
| HISTORY | `history`：MODEL_TURN 为 assistant 条目（带 `toolCalls`）；TOOL_RESULT 与带 `toolCallId` 的 FEEDBACK 为 tool 条目；其他 FEEDBACK 为 user 条目 | 见左 |
| STATUS | `status` 的说明文字 | user |

- 用 contracts 的 `estimateItemTokens` 计算每个条目；总量超过 `tokenBudget` 时按 M1Interface 6.3 的顺序裁剪，
  并设置 `truncated`、`droppedCount` 与 `elidedRequestIds`。HISTORY 与 ORIENT 可以裁剪至空，启动时的额度校验保证不可裁剪段小于预算，
  因此裁剪必然成功；预算配置错误使不可裁剪段本身超出时返回 `REJECTED(LIMIT_EXCEEDED)`。“整轮”按 `step.round` 分组。
- 某个 `toolCallId` 没有对应的 tool 条目，或 tool 条目找不到发出它的 MODEL_TURN 时，返回 `FAILED(INTERNAL, retryable = false)`，这表示 Workflow 有缺陷。
- `prefixSha256 = sha256(canonicalJson({ instructions, toolSpecs }))`。输出 `ContextAssembleOutput`，产物为该 ContextPack。

渲染格式（[#26](https://github.com/CaryHe-maker/MultiAgentOS/issues/26) D）。依据是 M0 的消融实验
（`experiments/minimal-agent-loop/RUNS.md`）：只追加的消息列表使重复读取从 8/10 降到 2/10，纯文本工具结果比 JSON 再省 18% 输入。

| 内容 | 写法 |
|---|---|
| 段的稳定性 | STATUS 之前的段在同一 AgentRun 内不变，HISTORY 只在末尾追加，provider 的前缀缓存可以命中；STATUS 是唯一每轮变化的段 |
| TOOLS | `content` 为空，工具定义在 `toolSpecs` |
| OBJECTIVE、HANDOFF | `User question:` 加目标；交接写成任务、`Focus areas`、`Open questions` 三部分 |
| HISTORY 顺序 | 每个 MODEL_TURN 之后按其工具调用的顺序各跟一条 tool 条目，然后才是本轮不带 `toolCallId` 的 FEEDBACK（provider 不允许工具调用与结果之间插入 user 消息）；同一调用有多条结果时合并为一条 |
| 没有工具调用的 MODEL_TURN | `content = '(no tool call)'`（StepRecord 不保存模型正文，部分 provider 拒绝空的 assistant 消息） |
| 读取结果 | `<path> (lines a-b of N)` 后接带行号的正文，未读完时提示下一次的 `startLine`；带 `provenance`（`retrieval = 'FILE_READ'`） |
| 检索结果 | `N matches:` 后接各命中的 `path:a-b [kind, score]` 与带行号片段；无命中时建议改写查询 |
| REJECTED、FAILED | `Error <CODE>: <原因与下一步>`，例如 `NOT_FOUND` 提示先用 `search_repository` 的 PATH 模式定位 |
| FEEDBACK | `[<code>] <message>` |
| STATUS | 已用轮数、额度状态；剩余不超过 2 轮或额度不为 NORMAL 时提醒收尾；final 时写明原因并要求调用控制工具 |
| 省略的正文 | 固定的省略说明，并去掉该条目的 `provenance` |

### 4.5 ModelCallExecutor

- 把 ContextPack 转为 provider 请求：INSTRUCTIONS 为 system 消息，TOOLS 为工具参数，其余条目按 `role` 转为消息。
  `final = true` 时强制调用唯一的控制工具；否则由模型自行选择。
- `max_tokens = limits.maxOutputTokens`；思考模式按 `scope.thinking` 设置；`environment.signal` 触发时中止请求。
- 直接调用 provider 模型的 `doGenerate` 而不是 `generateText`：它不做任何重试（相当于 `maxRetries: 0`），并按 provider 原文返回工具参数，
  `ModelRawOutput` 因此能逐字保存参数，解析失败也能以 `INVALID_JSON` 交给 Workflow。
- DeepSeek（`provider = 'deepseek'`）的思考开关由传给 SDK 的 `fetch` 写入请求体（`thinking: { type }`，开启时附 `reasoning_effort`）；
  Anthropic 协议使用 SDK 的 `reasoning` 选项。用量中的缓存命中优先取 SDK 的 `cacheRead`，否则取 DeepSeek 的 `prompt_cache_hit_tokens`。
- `final = true` 时按名称强制调用控制工具。Anthropic 协议开启 extended thinking 时不允许强制工具，M1 的 Agent 都关闭思考，此限制不会出现。
- 凭据只经 `environment.credentials.apiKeyFor(scope.provider)` 取得，不写入输出、日志或产物。
- 成功时输出 `ModelCallOutput`（工具调用参数按 JSON 解析，解析失败时 `arguments = null`、`argumentsError = 'INVALID_JSON'`），
  产物为 `ModelRawOutput`，`requestState = 'SENT'`，并带 provider 返回的用量。

| 情况 | outcome | reasonCode | requestState | retryable |
|---|---|---|---|---|
| 连接、DNS 或 TLS 在请求发出前失败 | FAILED | `PROVIDER_UNREACHABLE` | `NOT_SENT` | true |
| HTTP 429 | FAILED | `PROVIDER_RATE_LIMITED` | `NOT_SENT` | true |
| HTTP 401、403 | FAILED | `PROVIDER_AUTH` | `NOT_SENT` | false |
| HTTP 400 | FAILED | `INTERNAL` | `NOT_SENT` | false |
| HTTP 5xx，或响应流中断 | FAILED | `PROVIDER_ERROR` | `UNKNOWN` | false |
| 收到中止信号 | 尽快返回，`requestState` 为请求是否已发出的判断 | — | `NOT_SENT` 或 `UNKNOWN` | false |
| `apiKeyFor(provider)` 没有密钥 | FAILED | `PROVIDER_AUTH` | `NOT_SENT` | false |
| HTTP 404、413、422 等其他 4xx | FAILED | `INTERNAL` | `NOT_SENT` | false |
| HTTP 408 | FAILED | `PROVIDER_ERROR` | `UNKNOWN` | false |
| 状态 200 但响应体无法解析 | FAILED | `PROVIDER_ERROR` | `UNKNOWN` | false |
| 正常返回 | COMPLETED | — | `SENT` | — |

“请求发出前失败”指 `fetch` 因名称解析、连接或 TLS 握手失败（`ENOTFOUND`、`EAI_AGAIN`、`ECONNREFUSED`、`ENETUNREACH`、`EHOSTUNREACH`、
`UND_ERR_CONNECT_TIMEOUT`、证书错误）而拒绝；连接被重置等其他传输错误视为可能已处理（`UNKNOWN`）。
工具调用超过 32 个时 `ModelCallOutput` 只保留前 32 个，产物中保留全部原始调用。

`NOT_SENT` 表示 provider 没有处理该请求，不产生消耗。provider 返回的用量超过 `max_tokens` 或输入估算时，
按结算异常处理（见 [Monitor](../Kernel/Monitor.md) 3.4），不属于安全违规。

## 5. 执行点检查的两类结果

| 情况 | 例子 | Executor 返回 | 后续 |
|---|---|---|---|
| 正常越界 | 读取 `.env`、仓库外路径、输出超限、行范围不合法 | `REJECTED(原因码)` | Core 交付 UnitReport REJECTED，Workflow 按 `failurePolicy` 处理 |
| 安全违规 | 范围约束缺失、检查后文件被替换、防护失效 | `VIOLATION(原因码)` | Supervisor 上报，Execution 隔离输出，Core 以 VIOLATION 停止运行 |

M1 只运行可信的内置 Executor；引入不可信 Executor 时须改由访问器或操作系统沙箱强制。

Executor 从不抛出异常：收到中止信号时尽快返回 `FAILED(INTERNAL, retryable = false)`（MODEL 另带 `requestState`），
Supervisor 按 [Supervisor](../Kernel/Supervisor.md) 第 4 节把宽限期内返回的执行报告为 `TERMINATED`，这里的原因码不会交付；
其他意外错误同样返回 `FAILED(INTERNAL, retryable = false)`。

## 6. 测试

| 覆盖 | 内容 |
|---|---|
| 路径检查 | 第 3.2 节每一步的反例，包括 symlink 指向仓库外、`..`、绝对路径、排除规则、二进制文件、检查后替换文件 |
| 快照 | 同一内容得到相同 `snapshotId`；排除的文件不影响摘要 |
| 检索 | `rg` 与内置扫描对同一 fixture 结果一致；排除文件不出现在命中中；取消时子进程被终止。系统没有 `rg` 时一致性用例跳过（CI 安装见 [#25](https://github.com/CaryHe-maker/MultiAgentOS/issues/25)） |
| 组装 | 段顺序、裁剪顺序（含整轮移除与裁剪至空）、`elidedRequestIds`、`prefixSha256` 稳定、裁剪前后工具调用与 tool 条目一一对应 |
| 模型 | 用假的 provider 覆盖第 4.5 节表中每一行；`final` 时强制控制工具；SDK 不自动重试 |
| 读取 | 按 400 行与 `maxOutputBytes` 截断到完整行；首行超限；空文件 |
| Contract | 每个 Executor 的输出通过对应 Schema 校验 |

`packages/testing` 为上表提供三样共用的东西，ExecutorSet 的测试必须使用它们，使 fake 与真实实现按同一标准验收：

| 导出 | 用途 |
|---|---|
| `describeExecutorContract(name, fixture)` | 对注册表中的五种 Executor 逐一检查：完成时能组成合法的 ExecutionFact（输出类型、产物媒体类型、MODEL 的 `requestState`）；产物与输出一致（ContextPack 的 `operation`、`snapshotId`、`contextPackId`、`prefixSha256`、token 数；读取文本的 `contentSha256`；模型原始输出的工具调用）；相同输入得到相同输出；收到中止信号时仍返回合法结果而不抛出异常 |
| `createFixtureRepository(root, outside)` 与 `FIXTURE_FILES` | 一个固定的小仓库：普通文本、空文件、命中默认排除规则的文件、二进制文件，以及指向仓库外的符号链接（平台不允许创建时为空） |
| `repositoryGuardExpectations(repository, environment)` | 第 3.2、3.3、4.3 节对该仓库要求的结果清单（`OUT_OF_SCOPE`、`NOT_FOUND`、`UNSUPPORTED_FILE`、`INVALID_RANGE`、`INVALID_QUERY`、`LIMIT_EXCEEDED`、`SCOPE_MISSING` 等），作为 `fixture.expectations` 传入 `describeExecutorContract` |

真实 Executor 还可以放进整条链路运行：`createFakeExecutorRegistry(undefined, { FILE_READ: 真实实现 })` 只替换其中几种，
或在 `composeSystem` 的 `parts.createExecutorRegistry` 中直接使用 `createExecutorRegistry`；fake Kernel 会经 Supervisor
调用它们。需要真实运行 `rg` 时，把 `@multiagentos/kernel` 的 `createSubprocessRunner()` 传给 `createFakeSupervisor({ subprocess })`，
或直接放进 `ExecutorEnvironment.subprocess`。

### 6.1 真实模型评测

`packages/libraries/executor-set/eval/` 在产品 Workflow 与 Kernel 就绪之前，用真实的 ExecutorSet、目录中的 code-viewer
Prompt 与 Tool 定义和真实模型衡量检索与上下文的效果。它按 [Workflow](../Module/Workflow.md) 第 4–10 节的规则驱动单个 Agent
（解释模型返回、Validation、重复调用、无进展、final-call、来源核验），使用 M0 的 C 审查题、问题与答案清单
（`fixtures/c-review`、`fixtures/c-review-answer-key.json`），因此结果可以直接与
`experiments/minimal-agent-loop/RUNS.md` 中 M0 与 mini-agent 的数字比较。

```bash
DEEPSEEK_API_KEY=... pnpm --filter @multiagentos/executor-set run eval -- --repeat 10 --label m1-draft
```

每次运行输出调用次数、输入与缓存命中 token、输出 token、费用、耗时、core/subtle 得分、已核验结论比例、读取与重复读取次数，
结果写入 `eval/runs/`（不提交）。按 M1TechStack 第 11 节，每份结果另记录 provider、模型、思考设置、预算与 Agent 上限、
用到的全部定义的 digest 和当前 commit；费用按 AgentToolPool 的 `modelCallCost` 以每次调用的时间计算高峰价。它不属于质量门；离线用例 `eval/agent-loop.test.ts` 用脚本化的假模型检查这条循环本身。
真实链路可以运行之后（Workflow 计划 T19），评测改为经过完整的权威调用链。
