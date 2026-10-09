# M1 会议纪要（2026-10-04 晚）

- 参会：Cary（主持）、field、meti
- 记录：meti 根据录音转写整理。转写没有标发言人，归属按上下文判断，如有出入请指正
- 逐段记录和详细分析见 `2026-10-04-m1-scope-and-kernel-architecture-meeting.m`；执行层的完整设计建议见 `06-执行层设计建议.md`；会后的 Lease 机制草稿原文见 `07-Lease机制草稿.txt`

## 1. 结论速览

| # | 议题 | 结论 | 状态 |
|---|---|---|---|
| 1 | M1 是否分两阶段（先单 Agent，再加 Planner） | **M1 完成 Planner 和 CodeViewer 两个 Agent，不分阶段交付**；实现顺序上先做 CodeViewer，再加 Planner 和 handoff（会后确认） | 已定 |
| 2 | 同轮多个工具调用 | **M1 串行执行**；协议上仍允许模型一轮发多个调用 | 已定 |
| 3 | 程序退出与意外终止 | **不支持继续未完成的运行；正常退出时卸载模块；每次启动清空上次数据** | 已定 |
| 4 | 运行上限与额度 | **实现轮次上限 + API 额度软、硬两个阈值**：软阈值让 Agent 生成报告后结束，硬阈值立即终止；Monitor 发现、Gateway 驳回 | 已定 |
| 4 | 单次 API 调用的限制 | 思考过长、耗时过长也要能截断；暂定终止本次调用、丢弃结果；由谁判断待定 | 未定 |
| 5 | 工具形态 | **所有操作必须通过工具；不给 bash**；以后写文件怎么做再议 | 部分已定 |
| 6 | 用户流程 | **单次输入、单次输出；运行中用户只能终止或授权；访问仓库前问一次 Y/N**；回答 N 时怎么处理待定 | 已定 |
| 7 | 模型回复 → Unit（#14） | 采纳 #14 流程；重新生成最多 3 次；技术错误由执行层重试最多 3 次，其余交 Workflow 判断；同轮调用全部有结果后再调用模型；错误由 ContextEngine 放进上下文；handoff 单向，交出后即结束 | 已定 |
| 8 | Gateway 与 Core 分工 | **Gateway 能判断就不进内核**：带 Lease 的 Unit 按快照检查后直接返回；申请 Lease 时陷入内核，Core 签发后直接交给 Workflow 并更新 Gateway 快照；内核的返回不经过 Gateway | 已定 |
| 8 | 请求与结果的传递路径 | 会上暂定“发送方先找 Gateway 检查，再经 Fabric 直接交给接收方”；**已被议题 13 的 Lease 机制取代**（Lease Check → 执行层 → Result Check → 结果交回 Workflow） | 已更新 |
| 9 | Scheduler 是否并入 Execution | 随议题 10 的宏内核结论，Scheduler 和 Execution 都在内核内；内部怎么划分由 field 定 | 随议题 10 解决 |
| 10 | Scheduler 调度什么 | **只调度占用 API 的 Unit**；其他 Unit 依赖满足就直接执行；前两三版需要调度的资源只有外部 API | 已定 |
| 10 | Execution 是否放进 Kernel | **宏内核：M1 把 Execution 放进 Kernel，内核内部做权限隔离**；field 认为项目结构要因此调整；Cary 认为三人负责的部分已经完全解耦 | 已定 |
| 11 | 权限怎么判定（#13） | 倾向**两层校验**：Workflow 按 Agent 定义检查工具是否合法，Gateway 按 Lease 检查具体范围；Lease 在 AgentRun 创建时向内核申请；Planner 不需要仓库权限；模型 API 调用算不算权限、申请权限是否做成给模型的工具、Workflow 能否直接读 Agent 定义未定 | 讨论中 |
| 12 | Unit 是什么 | Unit 是结构化执行请求；Unit → Tool → Executor；MODEL、CONTEXT 是不暴露给模型的内部 Unit | 已澄清 |
| 13 | 控制流与 Lease 机制 | 按控制流图和 Lease 机制草稿：**每个 Unit 提交前做 Lease Check**；不通过时 Core 检查，按敏感程度询问用户并签发；**用户交互只有一处**；**Lease 实体只在 Core**；Workflow 只校验工具是否存在。草稿中“CONTEXT、API Unit 越过 Tool 默认允许”等几处待修正 | 草稿，待修正 |
| 14 | ORIENT 与 ContextEngine 的边界 | **仓库概览（ORIENT）和搜索从 ContextEngine 分离，由读仓库的执行者完成，和 `file-read` 一样要过 Lease 检查；ContextEngine 只组装上下文，不碰用户仓库**（会上讨论，会后确认；定义改动见 #20） | 已定 |

## 2. 各议题要点

### 议题 1：M1 是否分两个阶段

Cary 提问：第一阶段只做 CodeViewer，单 Agent 单循环跑通，之后再加 Planner 和 Agent 间移交（对应 meti 在 #15 的建议）。会上没有继续讨论。

**会后确认**：M1 完成两个 Agent，不分阶段交付。`repository-analysis-agent` 拆成 Planner 和 CodeViewer 两份定义，Agent 定义里声明开始时自动执行的 Unit（`startUnits`），Workflow 按定义启动 AgentRun，多一个 Agent 主要是多一份 prompt 和定义。实现顺序上先做 CodeViewer（测试里直接创建它的 AgentRun，跑通 F1），再加 Planner 和 handoff。`M1Plan.md` 的“单 Agent”要相应修改。

### 议题 2：串行还是并行

- Cary：一轮读 5 个文件就是 5 个 Unit，现在串行执行，M0 已验证可以跑通
- field：M1 先不做并行；Scheduler 目前就是很简单的串行调度
- 结论：M1 串行；Scheduler 已有的 API 保留

### 议题 3：程序退出与意外终止（#19）

- Cary：意外终止后，下次启动如果有残留（Artifacts、ContextEngine 的运行数据）怎么办？会不会导致第二次无法启动？
- field：正常退出要做，按顺序卸载模块；异常崩溃 M1 不做恢复。为了保证意外退出后能正常启动，每次启动都清空，不区分正常、意外退出
- 结论：Cary 同意按此实现

### 议题 4：运行上限与额度

- Cary 起初预想第一版都不需要；field 提出 Monitor 只维护额度，额度不足立即终止
- Cary：要实现真实功能，不能只是壳；直接终止会让用户拿不到任何输出，所以设软、硬两个阈值
- field 理解为：Monitor 发现超限后通知 Gateway，Gateway 驳回后续请求，Workflow 按驳回原因处理
- Cary 补充：Gateway 只能挡住下一个 Unit，挡不住正在进行的调用，所以还要有单次调用的限制；field 暂定终止本次调用、丢弃结果，再考虑归属
- 结论：M1 实现轮次上限和 API 额度上限（软 + 硬）

### 议题 5：工具形态

- 工具由模型自己选择，模型倾向于用命令行
- field：所有操作都必须通过工具；命令行也要封装成工具；bash 权限太大，不能给；如果以后给 bash，怎么用由负责 prompt 的人写提示词
- Cary：以后写文件是给模型工具，还是交给 Kernel？再想一下
- Cary 提议“判定方式和 M0 一样”，具体指什么需要确认

### 议题 6：用户流程与人类在环

- Cary：启动后输入 prompt；之后用户只能终止或授权；不支持中途改方向，也不支持拿到报告后追问
- 访问仓库前询问用户该地址能否访问、是否安全，用户回答 Y/N；回答 N 时怎么处理还没定

### 议题 7：模型回复如何变成 Unit（#14）

Cary 讲解，大家没有异议：

1. Workflow 初始化后创建第一个 AgentRun（目前默认是 Planner），先排入“组装上下文”和“调用模型”两个 Unit
2. 模型回复有三种：工具调用、handoff、提交结果；ModelExecutor 包装为 ModelTurnOutput 交回 Workflow
3. Workflow 检查格式、工具是否存在、历史是否满足要求；不合法时把错误放进上下文重新生成，最多 3 次，仍失败则本次 WorkflowRun 失败结束
4. handoff 单向：A 交给 B 后 A 结束，不等待 B 的结果
5. 技术错误（连接失败、超时等）由执行层重试最多 3 次，仍失败交给 Workflow；模型给出的回复，执行层不处理，直接交给 Workflow
6. 同一轮的工具调用全部有结果后（包括失败的），再一起交给模型

### 议题 8：Gateway、Core 与结果传递

- 结果返回路径：field 认为 Gateway 不应中转；Cary 认为请求经 Gateway、结果不经 Gateway 不对称。最终 field 拍板“不中转”：发送方先找 Gateway 检查，再经 Fabric 直接交给接收方，先检查再上信道
- Gateway 与 Core 分工（field 讲原则，Cary 同意）：Gateway 持有 Lease 快照，能判断的直接判断，不进内核；判断不了（如申请新 Lease）才陷入内核；内核的返回不经过 Gateway，最多通知 Gateway。Gateway 目前主要拒绝“Lease 不满足”的请求

### 议题 9、10：Scheduler 与 Execution 的归属

- Cary 提议 M1 把 Scheduler 并入 Execution；field 表示要想一想
- 关于 Scheduler 调度什么：起初两人说的不是一个层面（field 说操作系统进程并发，Cary 说 Unit 在有限 API 下的排队）。澄清后一致：只有占用 API 的 Unit 需要调度，其他 Unit 依赖满足就可以执行
- 关于 Execution 是否放进 Kernel：
  - field：Scheduler 和 Execution 高度绑定，硬拆开要用通信粘合，代价大；Monitor 在内核里却要频繁从 Execution 收集用量，之前想用专用高速信道。field 本想做分布式系统，不想做“宏内核、管家式”系统，但 API 资源必须由内核管理，这里存在矛盾
  - Cary：Execution 还负责把结果写进 Artifacts；如果都放进内核，除 Workflow 和 UserInteraction 外的事都归内核了。建议先选一种，做完 M1 再评估
  - field：M1 不做复杂调度，看不出优劣。提议 M1 直接把 Execution 放进内核，内部做一层权限隔离，这也是他最初的设计
- 会议末尾：field 认为整个项目结构要因此大改；Cary 认为三人负责的部分是完全解耦的

### 议题 11：权限怎么判定（#13）

- Cary（推断）：提交 Unit 时如果权限不够，再触发申请权限的机制，这个逻辑算不算闭合？
- field（推断）：重要的不是逻辑是否闭合，而是现在根本不知道权限怎么判定。M1 的任务很明确：Planner 不需要读仓库，所以不需要任何权限
- 讨论：调用模型 API 算不算权限？一种说法是 API 调用只算额度、不算权限；另一种说法是只要是 Agent 就必须有这个权限，否则等于“脑子被挖掉”。会上表示之前没想过这个问题
- 会上准备让 Codex 跑一遍，参考它给出的权限清单
- Cary：审核不通过时，当作上一轮回复的错误，生成提示让 Agent 重新生成工具调用。又提议：要不直接把（申请）工具当成 Agent 的权限？
- Cary 指出一个矛盾：Gateway 因权限不符拒绝、再交给内核，这一步在系统正常时根本不会发生，因为 Workflow 本来就知道调用合不合规，可以自己决定
- field 解释校验逻辑：系统初始化时没有任何 Lease。AgentRun 创建时向内核发系统调用申请 Lease，内核读取 AgentToolPool 的静态定义后签发；之后 Workflow 每次执行都带着 Lease 交给 Gateway，**Workflow 不用自己检验，由 Gateway 检验**。原因之一是以后 Lease 可能加密：怎么保证 Lease 不是伪造的？校验密钥一份在内核，内核把快照给 Gateway，由 Gateway 校验（这是很后面的事）
- Cary：模型返回工具调用列表后，即使不看 Lease，Workflow 也要审核这些工具是否合法（是否在该 Agent 的定义里），那为什么不顺便直接检查 Lease？
- 讨论后形成“两层校验”：**第一层，Workflow 按 Agent 定义检查工具是否合法；第二层，Gateway 按 Lease 检查这个工具具体能做什么**。即使 Workflow 和内核的版本没对齐、判断错了，Gateway 也会拦住
- field 提出：在宏内核设计下，Agent 定义只能由内核读，Workflow 要读应向内核申请。Cary：没必要，静态的东西谁需要就读；Workflow 创建 AgentRun 本来就要读
- field：那 Lease 还有什么意义？Cary 举例说明 Lease 的意义：用户只同意了仓库 A 的只读访问，没同意仓库 B，内核就只能签发 A 的 Lease，不管 Agent 定义怎么写；如果 Agent 需要读 B，还要再申请。同样是 `read` 工具，Lease 决定能读哪些文件
- Cary 复述并确认分歧点：工具和 Lease 是两层，Lease 不是“给 read”，而是“read 加上哪些文件夹”，是加在工具上的权限。Cary 的想法是 **Workflow 同时审核这两层**
- Cary 提出要决定的问题：**申请权限要不要做成一个专门的工具给模型？** 两种方式：
  - 做成工具：模型主动调用“申请权限”
  - 不做成工具：只告诉模型有 `read`，模型想读什么就调用；Lease 里没有就由系统去申请，有就直接用
- Cary 接着问：仍以仓库 A、B 为例，新 Agent 启动时，**要不要告诉它“你只能读仓库 A，可以申请读仓库 B”**？还是只告诉它“你能读仓库”，由它决定要读哪些文件，系统检查是否符合，不符合再去问用户？有人提到之前查到的说法：Lease 的内容不能告诉 Agent
- Cary 描述按 Unit 签发的流程并请大家确认：模型一轮发出三个搜索调用，Workflow 预先生成三个 Unit；第一个 UnitIntent 交给 Gateway，Gateway 和内核核对权限。**安全权限**直接签发，Unit 交给执行层；**需要用户审核的危险权限**，由内核在 Unit 还在内核里时向 UserInteraction 发起询问，允许就签发并交给执行层，不允许就退回 Workflow；Workflow 视为失败，下一次调用模型时把“工具失败、没有权限”告诉模型，让模型重新选择
- 结论：*讨论中*。倾向两层校验：Agent 定义决定“有没有这个工具”，Lease 决定“这个工具能用在哪里”；按 Unit 触发签发的流程基本成立；申请权限是否做成工具、要告诉模型哪些权限信息、Workflow 能否直接读 Agent 定义未定

### 议题 12：Unit 是什么、怎么执行

- 看 Agent 定义里的工具列表时，有人指出：模型 API 调用不是工具，是 Unit；不可能把“调用 API”作为工具告诉 Agent
- field 问：Unit 怎么落地、执行机制是什么？Unit 是自然语言描述，还是一段代码？
- Cary：Workflow 把 Unit 交给内核（现在相当于交给执行层），执行层去调用 API。对“Unit 是不是自然语言”的问题没有理解
- field：不是所有 Unit 都属于工具。如果“工具”是给 Agent（模型）用的，设计就坏了，是不是还得改？之前和 Cary 确认过的关系是 **Unit → Tool → Executor**，一直以为一个 Unit 必定是一次工具调用
- field（推断，转写较乱）提出一种区分方式：Unit 是运行单位；执行链中**有 Tool 时，表示这条执行链需要权限审核和 Lease 签发；跳过 Tool（Unit 直接到 Executor）时，表示这是开发者默认授予的权限**，例如调用模型 API
- Cary：听懂了，但觉得这个说法很奇怪：没有 Tool 封装，就表示开发者默认允许
- 结论：*未定*（见第 6 节）

### 议题 13：控制流与 Lease 机制（会上画图，会后形成草稿）

会上从 AgentRun 创建开始画了一遍控制流，会后整理成 Lease 机制草稿（原文 `07-Lease机制草稿.txt`）。要点：

- **执行链**：`Unit -> (tool)* -> executor | [executors] -> process | [processes]`，Lease 挂在 Tool 上
- **Tool 是权限封装层**：执行链里有 Tool，表示需要权限审核（签发 Lease）；越过 Tool，表示开发者默认授予的权限
- **用户交互有且只有一处**：“根据敏感程度上报 UserInteraction 并签发 Lease”这个节点
- **Lease 实体只在 Core**：Core 持有权威 Lease，外部没有 Lease 实体，访问 Lease 即 panic
- **流程**：
  1. Workflow 创建 AgentRun，必然包含两个 Unit：ContextEngine 和 API（模型调用）
  2. 提交 ContextEngine UnitIntent（越过 Tool，默认允许）→ 提交 API UnitIntent（同上），返回后续工具请求链
  3. Workflow 生成 Unit 列表：**只在这里审核工具是否存在，与 Lease 无关**
  4. 提交下一个 UnitIntent → 发送 Lease Check 系统调用
     - 成功 → 执行层创建 UnitAttempt → 执行完成 → Result Check 系统调用 → 成功则结果交回 Workflow；失败则异常交回 Workflow
     - 失败 → Core 检查权限 → 成功则按敏感程度上报 UserInteraction 并签发 Lease → 执行层创建 UnitAttempt；失败则异常交回 Workflow
  5. Workflow 处理结果或异常后提交下一个 UnitIntent；一轮的 Unit 都处理完后，再提交 API UnitIntent，生成新的 Unit 列表

### 议题 14：ORIENT 与 ContextEngine 的边界（会上讨论，会后确认）

- 按 Lease 机制，组装上下文的 CONTEXT Unit 不读用户仓库；如果仓库概览（ORIENT）在 ContextEngine 里生成，概览会在用户回答 Y/N 之前随模型调用发出去
- **结论**：ORIENT 和搜索从 ContextEngine 分离，由读仓库的执行者完成，声明和 `file-read` 相同的读仓库能力，经 Gateway 检查，必要时询问用户；ContextEngine 只按 StepRecord 组装上下文，只读本次输入里列出的 Artifact
- 对应的定义改动：`context-build` 拆成 `repository-orient`、`repository-search`、`context-assemble` 三个 Unit；CodeViewer 的 `startUnits` 为 `[repository-orient]`，Planner 为空（见 #20）
- 这样 CodeViewer 的第一个 Unit 就是读仓库，Y/N 自然发生在第一次碰仓库之前；Planner 不会触发询问

## 3. 未决问题

| 问题 | 建议负责人 |
|---|---|
| 单次 API 调用限制由执行层还是 Monitor 判断（议题 4） | field |
| 用户回答 N 时的处理（议题 6） | Cary |
| “判定方式和 M0 一样”具体指什么（议题 5） | Cary |
| 宏内核内部的权限隔离怎么做（执行者能拿到什么）；Scheduler 在内核中的位置（议题 9、10） | field |
| 结果方向上，执行层交还结果前向 Kernel 确认什么（议题 8） | field |
| ContextEngine 读 Artifact Store 时由谁检查读取范围 | field、meti |
| M1 的 Lease 包含哪些权限、怎么判定；模型 API 调用算不算权限（议题 11） | field，Cary 确认 |
| Lease 机制草稿：CONTEXT、API Unit 是否也要做 Lease Check（议题 13；影响硬阈值和中止能否拦住模型调用） | field |
| Lease 机制草稿：用户拒绝的分支、“敏感程度”的分类、首次允许时签发的范围、拒绝后是否再询问（议题 13） | field |
| Lease 机制草稿：Result Check 检查什么（议题 13） | field |
| ContextEngine 如何拿到从 Lease 投影出的范围摘要（仓库根目录、排除规则），而不接触 Lease 实体（议题 13） | field、meti |
| AgentRun 由 Workflow 创建、内核不管理其生命周期，但内核要知道 AgentRun ID（Lease 绑定、用量归属），AgentRun 结束时 Workflow 通知内核让 Lease 失效（会后整理，待确认） | Cary、field |
| 错误信息分三层记录（StepRecord 里的错误摘要、Artifact 里的失败产出、只给开发者的诊断）；Lease 检查失败和用户拒绝都记成 `REJECTED` 结果（见 #20） | Cary、field |

## 4. 行动项

| 负责人 | 事项 |
|---|---|
| field | 把“M1 采用宏内核、Execution 放进 Kernel”写成一条 issue（含内部权限隔离的做法和以后重新评估的触发条件），再据此修改 Kernel 相关文档 |
| field | Monitor 用量账本与硬阈值；Gateway 按 Lease 快照和额度快照检查 |
| field | 启动时清空上次数据；正常退出时卸载模块 |
| field | 在 #17 写明三种交互方式（可信信息传递、系统调用、持 Lease 调用）和请求、结果、用量各走哪条路，最好附时序图 |
| Cary | Workflow 实现轮次上限、软阈值收尾，处理 Gateway 的“额度不足”驳回 |
| Cary | 修改 #15：同轮调用改为串行；额度从“只记录”改为软、硬阈值；去掉暂停 / 恢复 |
| Cary | 更新 #17 边界第 1 条“Workflow 不直接调用 Execution”（视 Execution 归属结论而定） |
| field | 修订 Lease 机制草稿（补用户拒绝分支、敏感程度分类、Result Check 内容；确定 CONTEXT、API Unit 是否做 Lease Check），发到 #13 |
| meti | 按会议结论修改并发出运行上限 issue，具体数值在那里讨论 |
| meti | 和 Cary 确定 StepRecord / AssembleInput；和 field 确定 Executor 接口中 ContextEngine 的部分 |
| meti | 发出 #20：Agent 定义新增 `startUnits`、拆分 `context-build`、拆成 Planner 和 CodeViewer 两份定义、错误信息记录方式；大家同意后修改 AgentToolPool 定义 |
| meti | 固定任务集加“分流”题（简单问题应由 Planner 回答，代码问题应移交 CodeViewer） |
| Cary | `M1Plan.md` 的“单 Agent”改为 Planner + CodeViewer（单向 handoff） |

## 5. 需要同步到 GitHub

- #14：问题 3“串行还是并行”按议题 2 关闭
- #15：同轮工具调用改为串行；“额度只记录不限制”改为软、硬两个阈值；M1 不做暂停 / 恢复；单次输入、单次输出
- #13：贴出 Lease 机制（修订后），并据此回答正文问题 1–5
- #17：三种交互方式、结果传递路径、Execution 归属；议题 8 的暂定路径已被 Lease 机制取代
- #15：meti 追加评论——M1 完成两个 Agent、Y/N 在第一次碰仓库前询问、评测加分流题
- #20（新）：startUnits、拆分 context-build、两份 Agent 定义、错误信息三层记录
- #19：问题 7（不支持继续运行）、问题 9（启动时清空）记为已定；与暂停相关的问题移出 M1；落盘表中“步骤记录、审计、用量只追加落盘”与“启动清空”冲突，需说明以哪个为准

## 6. 会后补充意见

以下是整理时的分析，供下次讨论参考，不是会议结论。

**关于“项目结构要大改”（field）**

- 文档层面：现有架构早已区分“可信的运行管理代码”和“不可信的 Executor 实现”（`Overall.md` 第 3 节、`Execution.md` §1）。如果把运行管理划进 Kernel、Executor 留在外面，需要改的大约是 6 个文件，以改归属和措辞为主，没有需要重写的文档（清单见 `06-执行层设计建议.md` 第 8 节）
- 代码层面：`feat/M1` 上 Kernel 约 176 行、Workflow 约 93 行，还没有单独的 Execution 包，M1 本来就要用 M0 代码替换。**现在是改结构代价最低的时候**
- ~~议题 8 的暂定结论和 `Overall.md` 第 16 节不变量冲突~~ **已由宏内核结论（议题 10）解决**：执行在内核内，结果由内核写入并交回 Workflow，符合“Workflow 不得绕过 Kernel”“结果先由 Kernel 校验”

**关于“三人负责的部分完全解耦”（Cary）**

模块归属上是解耦的，但有几处接口必须两人或三人一起定，定下来之前各自的实现会互相等待：

| 接口 | 涉及 | 内容 |
|---|---|---|
| StepRecord / AssembleInput | Cary、meti | 历史记录格式、调用与结果配对、`notice`（#18） |
| 收尾与上限 | Cary、meti、field | 软阈值由 Workflow 判断；最后一次调用的 `tool_choice` 放进 MODEL Unit 输入；硬阈值由 Monitor / Gateway 执行 |
| Executor 接口 | field、meti | ContextEngine 作为 CONTEXT Unit 的执行者：输入、输出、错误，以及可读取的 Artifact 范围 |
| Lease 范围 | field、Cary | 开始时的 Y/N 要同时覆盖“读仓库”和“把代码发给模型服务” |
| 错误码与 `REJECTED` | 全员 | 哪些错误交还模型、哪些重试、哪些结束运行 |

这些都在 `packages/contracts` 里，建议按 M1Process 的顺序先做 C-05（contracts），再各自实现。

**对 Execution 归属的建议**（详见 `06-执行层设计建议.md`）

> 已定宏内核（议题 10）。下面的划分仍可作为**内核内部权限隔离**的参考：有状态的执行控制和无状态的执行者分开，执行者只拿到输入。

按“谁持有权威状态、谁处理不可信输入”划分：执行控制（UnitAttempt、重试、写 Artifact、上报用量）放进 Kernel；各 Executor（ModelExecutor、FileReadExecutor、ContextEngine）留在 Kernel 外，不保存状态，接口只有 `input → { output, usage, error }`。这样 Scheduler、Monitor 和执行控制都在内核里，不再有“跨两层”和“专用信道”的问题；Workflow 只和 Kernel 交互，结果由内核写入并计算 hash，不需要额外的核验机制；经常变动的工具和模型都在内核外，加工具不用改 Kernel。

**关于权限怎么判定（议题 11）**

- **“权限不够再申请”在 M1 里不需要。** M1 的仓库权限在 CodeViewer 开始时一次签发（议题 6、14），运行中用户只能终止或授权。这时 Gateway 拒绝的只会是越界请求（仓库外的路径、`.env` 等），应该作为 `REJECTED` 结果交还模型，而不是发起新申请。逻辑这样就闭合了，Workflow 也不需要“等待授权”的状态。运行中申请权限留到有写操作的版本
- **模型 API 调用既是权限，也是额度，两件事互不替代。** 额度管“用多少”；权限管“能不能把什么数据发到哪个外部服务”。真正需要用户同意的是**把仓库代码发给 DeepSeek**，这就是议题 6 的 Y/N 要说明的内容
- **建议的 M1 Lease：**

  | 权限 | 授权依据 | Planner | CodeViewer |
  |---|---|---|---|
  | `model.invoke`：调用配置好的模型服务 | 系统配置（Agent 定义里声明了模型，就默认授予） | 有 | 有 |
  | `repo.read`：读取仓库，范围为解析后的真实路径，默认排除 `.env`、密钥文件 | 用户在开始时回答 Y | 无 | 有 |
  | `repo.egress`：把仓库内容发给模型服务 | 同一次 Y（提示里写明） | 无 | 有 |

  这样 Cary 说的“没有模型权限等于脑子被挖掉”和“API 只算额度”都对得上：调用模型的权限按配置默认给，用户只需要对“读仓库并发给模型”回答一次。`M1KernelRange.md` §4.2 已写“本地用户或系统配置提供授权依据”，和这个划分一致
- **两层校验是对的，两层查的不是同一件事。**

  | | 第一层：Workflow | 第二层：Gateway |
  |---|---|---|
  | 查什么 | 工具在不在这个 Agent 的定义里、参数格式对不对 | Lease 是否覆盖这次操作：哪个仓库、哪些文件、是否过期 |
  | 依据 | Agent 定义（静态、带版本） | Lease（运行时、来自用户同意） |
  | 不通过时 | 作为 `REJECTED` 交还模型（议题 7） | 同样作为 `REJECTED` 交还模型，并记一条异常日志 |
  | 目的 | 给模型有用的错误提示、构造 Unit | 真正的权限执行 |

  Cary 说的“系统正常时 Gateway 不会拒绝”，对第一层的内容成立（`Overall.md` 不变量 4 要求内核也查成员关系，这是纵深防御）；对第二层不成立：路径是否在仓库内、是否命中 `.env` 排除规则，这些是 Lease 的内容，**建议只在 Gateway 实现一份，Workflow 不复制这套规则**，否则两份路径规则迟早不一致。Gateway 拒绝后照常交还模型即可。
- **Lease = Agent 定义 ∩ 用户同意 ∩ 系统策略。** Cary 的仓库 A / B 例子正好说明 Lease 的意义：定义给的是能力上限（“能读”），Lease 给的是实际范围（“只能读仓库 A，排除 `.env`，本次运行内有效”）。field 问的“Lease 还有什么意义”，答案就在这里。
- **Workflow 可以直接读 Agent 定义，同意 Cary。** 定义不可变、带 digest，读到的内容可以校验；而且 `Overall.md` 不变量 7 已写明“目录声明不构成执行授权”，读定义不会获得任何权限。#17 里 Workflow 本来就直接读 AgentToolPool（创建 AgentRun 时固定版本）。内核签发 Lease 时读同一个固定版本即可。
- **M1 里 Lease 不需要加密，也不会被伪造。** 单进程里 Workflow 只持有一个 Lease ID，Gateway 用 ID 查自己的快照，内容根本不在 Workflow 手里，无从伪造。field 说的密钥方案准确地说是“签名”（如 HMAC），不是加密，只在 Lease 要跨进程、跨信任边界传递时才需要。
- **M1 是单仓库，读仓库 B 不需要“再申请”。** 一次运行只分析用户给出的一个仓库（议题 6），模型要读仓库外的文件就是越界，作为 `REJECTED` 交还模型。Cary 的 A / B 例子适合说明 Lease 的意义，但运行中追加申请建议留到以后。
- **申请权限不要做成工具，选“系统发起”。** 理由：
  - **范围精确**：系统按模型实际要读的那个路径发起申请；做成工具的话，模型可以申请 `/`、`~` 这样的大范围
  - **防注入**：仓库里的注入指令（#6 的 README 陷阱）可能诱导模型调用“申请权限”工具，借用户之手扩大权限
  - **少一个工具**：工具越少，模型越不容易选错，提示也越短（#4 的原则）

  系统发起也要加两条限制，否则模型乱试路径会不停打扰用户：只有落在用户指定过的范围内的路径才可能触发申请，其他直接拒绝；同一范围只问一次。
- **“Workflow 同时审核两层”可以，但第二层不要自己实现，而是问 Gateway。** Gateway 拒绝时返回明确的原因码，例如“缺少 Lease、可以申请”和“禁止访问、不可申请”；Workflow 按原因码决定是发起申请，还是作为 `REJECTED` 交还模型。这样 Workflow 在执行前就知道结果（Cary 要的），路径规则仍只有 Gateway 一份（避免两份规则不一致），也回答了 #13 的问题 3 和问题 5。
- **告诉模型“能在哪里工作”，不告诉它“Lease 本身”，也不告诉它“可以申请什么”。**
  - **要说**：仓库根目录、路径相对于根目录、哪些文件不可读（如 `.env`）。模型不知道范围就只能猜路径，猜错一次就浪费一轮调用；M0 的任务消息里一直写着仓库范围
  - **不说**：Lease ID、签名、到期时间这类凭证信息。“Lease 的内容不能告诉 Agent”指的是这一类——#13 正文问题 4 也写了“上下文中不放真实凭证”
  - **不说**：“你可以申请读仓库 B”。这等于提示模型去扩大权限，注入指令也会利用它；M1 是单仓库，更没必要
  - 越界时的错误说明写清楚怎么改，例如 `Error PATH_OUTSIDE_REPOSITORY: Paths must be inside <root>`（与 #14 meti 回复的纠错格式一致）
  - 这部分由 ContextEngine 渲染：范围说明放在稳定前缀里（M1 的 Lease 整个运行不变，不影响缓存）；以后如果运行中 Lease 有变化，在消息末尾追加一条说明，不改前缀
- **M1 仍不需要运行中申请其他范围。** 按议题 6 和议题 14，M1 只在 CodeViewer 第一次碰仓库前问一次 Y/N，签发用户给出的那个仓库的 Lease；越界一律 `REJECTED`。上面的“系统发起申请 + 原因码”是 M2 以后的设计，M1 先把原因码定义好、只用到“禁止访问”这一种即可。
- ~~**Y/N 的时机可以放在 handoff 时。**~~ （已由议题 14 统一：在 CodeViewer 第一次碰仓库前询问，也就是它的第一个 Unit `repository-orient`；效果上等于 handoff 之后马上问） Planner 只有 `model.invoke`，简单问题由 Planner 直接回答，不需要问用户（#15：简单问题不需要申请仓库权限）；Planner 移交给 CodeViewer 时才问 Y/N 并签发 `repo.read`。这样只在真正需要读仓库时才打扰用户。
- **Cary 描述的按 Unit 触发签发，逻辑是闭合的，但要改四处：**
  1. **每个 Unit 都检查，但不是每个 Unit 都签发。** 用户第一次允许时，签发覆盖整个范围的 Lease（“本次运行可以读仓库 A”），而不是只放行这一个 Unit；否则三个搜索会问用户三次。之后的 Unit 由 Gateway 按快照直接放行，这正是 field 说的“Gateway 能判断就不进内核”
  2. **不是所有缺权限的请求都可以问用户。** Core 按策略分三类：系统默认的（`model.invoke`）直接签发；用户指定范围内的（仓库 A）可以询问；其他（仓库外、`.env`）直接拒绝，不问用户。否则模型乱试路径就会不停打扰用户
  3. **被拒绝要记住。** 用户拒绝后，同一范围在本次运行内不再询问；后面两个搜索直接返回 `REJECTED`（原因 `USER_DENIED`），模型下一轮重试也不会再弹出询问
  4. **读仓库和发给模型服务要一起问。** 读到的内容在下一次 MODEL 调用时会发给 DeepSeek（`repo.egress`）；如果只问了读取，下一次调用模型还要再问一次。询问时写明“读取仓库 A，并将内容发送给 DeepSeek”
- **发生的位置：** 都在 Gateway 和内核里，Workflow 只是在等这个 Unit 的结果：

  ```text
  Unit → Gateway 查快照
    ├─ 已覆盖 → 交给执行控制层
    ├─ 策略禁止 → 直接返回 REJECTED
    └─ 未覆盖但可以申请 → 陷入内核，Unit 暂留在内核
         → Core 通过 UserInteraction 询问
         ├─ 允许 → 签发范围 Lease，更新 Gateway 快照 → 放行这个 Unit
         └─ 拒绝 → 记录拒绝 → 返回 REJECTED（USER_DENIED）给 Workflow
  ```

  M1 是串行执行，Workflow 本来就在等每个 Unit 的结果，所以“等用户回答”对 Workflow 来说只是这个 Unit 慢了一点，**Workflow 不需要专门的等待状态**。需要处理的是：询问期间用户按了中止，这个 Unit 要以“已中止”结束
- **这样“什么时候问用户”就自然解决了：** Planner 只用到 `model.invoke`，永远不会触发询问；CodeViewer 第一次读文件时才问。不需要在 handoff 时专门安排询问，也符合 Cary 说的“运行中用户只能终止或授权”
- **Codex 可以参考，但要看它的结构，不是照抄清单。** Codex 把权限分成两个维度：能碰什么（只读 / 可写工作区 / 完全访问）、什么时候问用户。M1 对应的是“只读 + 信任仓库时问一次”

**关于 Unit 是什么（议题 12）**

- **Unit 既不是自然语言，也不是代码，而是一条结构化的执行请求（数据）**，类似系统调用的参数或任务队列里的一条消息。代码事先写好在各个 Executor 里，Unit 只说明“用哪个定义、输入是什么”：

  ```ts
  { unitId, agentRunId, kind: 'FILE_READ', definitionRef, input: { path: 'src/parser.c', startLine: 1, endLine: 80 }, idempotencyKey }
  ```

- 自然语言只出现在 Unit 的**输入或输出里**：比如 MODEL Unit 的输入引用一份 ContextPack（里面是提示词和历史），输出是模型的回复
- **Unit 分两类**，这正是会上“API 调用不是工具”的意思：

  | | 模型可见的工具 | 内部 Unit |
  |---|---|---|
  | 例子 | `file_read`、搜索、`submit_report` | CONTEXT（组装上下文）、MODEL（调用模型） |
  | 谁发起 | 模型发出 tool_call，Workflow 校验后转换成 Unit | Workflow 按循环自己创建 |
  | 是否出现在模型的工具列表里 | 是 | 否 |

  #14 正文已写“组合上下文和调用模型也可以是内部 Unit，但不需要作为 tool 提供给模型”，问题 1 也提出要分清这两种叫法。建议 Agent 定义里分开写：`modelRef`（用哪个模型，对应 MODEL Unit）和 `toolRefs`（模型可见的工具）
- **设计不用改，是“Tool”这个词有两个意思。**
  - 架构里的 Tool（`Overall.md`：“Unit 对应一个 Tool 粒度的操作；Tool 封装权限需求和执行序列”）是**内部的执行封装**：声明需要什么权限、输入输出是什么、由哪些 Executor 执行
  - 模型 API 里的 tool 是**暴露给模型的函数**（function calling）
  - #14 问题 1 已经点出这个混淆：“PR #7 中的内部 Tool 还有执行封装的含义，这两种 tool 的叫法和映射需要分清”
- **按架构的意思，field 说的“一个 Unit 必定对应一次 Tool 调用”是对的，MODEL 和 CONTEXT 也不例外**：

  | Unit | 内部 Tool（执行封装） | 需要的权限 | Executor | 暴露给模型？ |
  |---|---|---|---|---|
  | MODEL | `model.invoke` | `model.invoke`、`repo.egress` | ModelExecutor | 否 |
  | CONTEXT | `context.assemble` | 无（只读本次运行的 Artifact） | ContextEngine | 否 |
  | FILE_READ | `file_read` | `repo.read` | FileReadExecutor | **是** |
  | SUBMIT_REPORT | `submit_report` | 无 | （Workflow 验收） | **是** |

  Unit → Tool → Executor 的关系完全保留，只需要给 Tool 加一个属性：**是否暴露给模型**
- **Agent 定义里分两个列表：** `unitRefs`（这个 Agent 允许执行的全部 Unit，内核按它检查成员关系，对应 `Overall.md` 不变量 4）和 `exposedToolRefs`（其中暴露给模型的那部分，是前者的子集）。模型只看到后者；Workflow 自己创建的 MODEL、CONTEXT 在前者里、不在后者里
- **用词建议：** 文档里 “Tool” 保留架构含义；暴露给模型的叫“模型可见工具”（或 Action）。Unit 有两个来源：模型的 tool_call 经 Workflow 转换，或 Workflow 按循环直接创建
- **不建议用“有没有 Tool”来表示“要不要权限检查”（同意 Cary 觉得奇怪）。** 理由：
  - **默认放行，容易出错**：规则变成“没包 Tool 就不检查”，以后有人新增一个 Unit 忘了包 Tool，它就悄悄绕过了权限检查。安全设计应该默认拒绝，而不是默认放行
  - **模型调用恰恰不能算“开发者默认”**：MODEL Unit 会把仓库内容发给 DeepSeek，需要 `repo.egress`，而这项来自用户的 Y/N，不是开发者能默认授予的。而且 MODEL Unit 还要经过额度检查（硬阈值）和运行状态检查（是否已中止），本来就必须过 Gateway
  - **和现有文档冲突**：`Overall.md` 写“Unit 对应一个 Tool 粒度的操作”，不变量 4 要求内核验证 Agent → Unit → Tool 成员关系；跳过 Tool 的 Unit 无法做这项验证
- **field 想要的效果可以显式表达：** 每个 Unit 都有 Tool，Tool 里写明 `requires`（需要的权限）。“开发者默认”就是 `requires` 里的权限由系统配置在创建 AgentRun 时默认签发（例如 `model.invoke`）；完全不需要权限的就写 `requires: []`，Gateway 直接放行。检查路径只有一条，是否需要权限一眼可见
- 两类 Unit 走同一条执行路径：Workflow → Gateway（按 Lease 检查）→ 执行控制层 → 对应的 Executor（ModelExecutor 发 HTTP 请求；FileReadExecutor 读文件）→ 结果写进 Artifact → 引用交回 Workflow

**关于 Lease 机制草稿（议题 13）**

骨架和控制流图一致，“用户交互只有一处”“Lease 实体只在 Core”是好的原则。需要修正：

- **必须改：CONTEXT 和 API Unit 也要做 Lease Check。** 按草稿，这两个 Unit 越过 Tool、默认允许、不做检查。那么议题 4 定的“硬阈值由 Gateway 驳回”和用户中止，对最花钱的模型调用都不起作用；而且模型调用会把仓库代码发给 DeepSeek，需要用户同意（`repo.egress`），不能算开发者默认。改法：所有 Unit 都做 Lease Check；Tool 写明 `requires`，默认权限（`model.invoke`）在创建 AgentRun 时由 Core 按系统配置签发，完全不需要权限的写 `requires: []`
- **`(tool)*`**：文档写“Unit 对应一个 Tool 粒度的操作”，建议改为恰好一个 Tool，一个 Tool 里可以有多个 Executor
- **“访问 Lease 即 panic”太重**：panic 留给可信基础失守；越权访问应拒绝并记审计。另需一个由 Kernel 生成的、不含凭证的范围摘要，随 CONTEXT Unit 交给 ContextEngine，否则模型不知道仓库在哪、哪些文件不能读
- **Workflow 审核不通过的调用**：要记一条 `REJECTED` 结果，否则下一轮会出现没有对应结果的调用
- **用户拒绝的分支没有写**：应记录拒绝，返回 `USER_DENIED`，同一范围本次运行内不再询问
- **签发范围**：第一次允许时签发覆盖整个仓库的 Lease，而不是只放行当前 Unit
- **“敏感程度”**：建议定义为三类：系统默认的直接签发；用户指定范围内的询问；其他直接拒绝、不询问
- **Result Check**：写明检查什么；如果执行层已在内核里（议题 10），可以简化为内核内部提交
- **还缺的分支**：提交报告、handoff、轮次上限与软阈值、硬阈值与中止

**几处细节**

- 每次启动清空：与评测、审计需要的运行记录冲突；同样简单的替代是每次运行写入 `runs/<runId>/`，启动时不读旧目录
- 软、硬阈值之间至少要留出一次完整报告调用的余量（M0 最终报告约 5k 输出 token），或者软阈值按调用次数触发
- 单次调用限制可以写在请求里（`max_tokens` 和超时），由 ModelExecutor 设置；M1 不做流式输出，调用进行中无法监控用量；被截断的调用仍要上报用量
- 404 等 4xx 错误重试结果不会变，不应重试；请求已发出后超时最多重试 1 次，用量记为“未知”
- 一轮中某个调用的工具名不存在时，建议只把该调用记为 `REJECTED`、其他调用照常执行，与“执行失败”走同一条路径（#14 Cary 的结论），而不是整条回复重新生成
- 用量可以随结果一起上报，不需要专用信道：一次运行只有十几次模型调用，用量在每次调用结束时才知道
- Y/N 之前先解析仓库的真实路径（防符号链接）；只读 Lease 默认排除 `.env` 等密钥文件（#6）
