# MultiAgentOS M2 编排架构：MissionTree、后台任务、休眠与 checkpoint

> 状态：草稿（phase 2 文档门），2026-11-12。作者：CaryHe-maker。
> 本文是 phase 2 编排的总体架构。它改变了 [M2Design](M2Design.md) v1.35 的若干设计（Turn、节点与 AgentRun 的关系、
> `run_subagents` 的语义、非目标清单等），第 13 节逐条列出。评审通过后先发布 M2Design 的新版本吸收这些改变，
> 再修改组件文档与 `Interface/`；在那之前，本文与 M2Design 冲突处以 M2Design 为准，本文只是待评审的提案。
> 2026-11-12：M2Design v1.36 已吸收定位与非目标的改变（自主编排为缺省、嵌套派生与任务间消息属于 M2），phase 2 的目标与对照实验见 [Phase2Plan](Phase2Plan.md)。
> 本文的机制是**执行底座**：它们不规定流程的形状。第 10 节的例子与 `mission` 模板是范式的样例，不是必须遵守的流程（D22）。

## 1. 目标与已定决定

phase 2 要让一个任务可以由很多 Agent 有结构地协作完成，例如"设计一个分布式系统"时，负责人主动分出前端组与后端组，
各组再分给自己的工人，它们并行运行、互相传递接口约定、在后台跑服务与测试，人可以随时回到某个 checkpoint 重来。
为此本文引入或改变五样东西：

1. **MissionTree**：从 TaskGraph 推出的任务继承树。业务层判断"是不是同一个任务"只看 MissionTree 节点；
2. **后台命令**：长时间运行的命令以 Unit 的形式存在，归属于 MissionTree 节点而不是 AgentRun；
3. **休眠与唤醒**：任务等后台命令、子任务、消息、定时或用户时结束当前 AgentRun，被唤醒时登记新的 AgentRun；
4. **跨任务消息**：任务沿树向父、子、兄弟发消息，由 Workflow 投递给对应节点当前的 AgentRun，必要时唤醒；
5. **checkpoint**：取代 Turn。所有编排在重要时刻自动保存一致的切面，回溯与现在的 `/undo` 是同一套逻辑。

负责人（Cary）2026-11-12 的决定：

| # | 决定 |
|---|---|
| D1 | MissionTree 节点对应 TaskGraph 上的一条线性链路：Turn-chat 中各轮的 main 是同一个节点；派生出的子 Agent 是子节点 |
| D2 | 每个 TaskGraph 有且只有一个长期存在的根节点，它是这个任务唯一的负责人（不一定叫 main），其余节点都由它展开 |
| D3 | AgentRun 是 Kernel 运行层的概念；业务层（TaskGraph、MissionTree）对同一个任务的 Agent 以其 MissionTree 节点判定 |
| D4 | 只有子任务把结果交回父任务时，这个树节点才算结束；等待时可以休眠或定时，休眠前后是两个 AgentRun，属于同一个节点 |
| D5 | 后台命令对齐 dsh、OpenCode、Claude Code 的标准：与前台命令同样的权限与沙盒，立即返回任务号，可读输出、可停止，结束时通知 |
| D6 | Turn-chat 只是编排的一种，与其他编排同一层次，不是特例 |
| D7 | Turn 不再是系统实体，只是界面上的说法；系统实体是 checkpoint，Turn-chat 的每一轮就是它的 checkpoint |
| D8 | checkpoint 列表以 Session 为单位保存；回溯与 `/undo` 同一套逻辑；Turn-chat 与其他编排的 checkpoint 逻辑完全一致 |
| D9 | checkpoint 不等后台命令；只等在途的、会改文件的 Unit（写入与前台命令），并扣住新的这类 Unit |
| D10 | 自动 checkpoint 的时机：根任务派生子任务、人类节点答复、模板声明；Turn-chat 只在用户的每条消息 |
| D11 | 进程退出或崩溃后重开 Session，用户确认后从最近的 checkpoint 续跑编排 |
| D12 | 后台命令结束、定时到点或收到消息时唤醒休眠的节点（包括 Turn-chat 里等用户的根节点），没有人类输入时连续唤醒有上限 |
| D13 | 放开嵌套派生，至多 3 层 |
| D14 | `run_subagents` 不阻塞：立即返回，父任务继续工作或休眠等待子任务 |
| D15 | 模板声明 owner：标为 owner 的步骤是根任务的各段，其余 AGENT 节点是根任务的子任务 |
| D16 | 结束工具按任务角色决定，Agent 定义只声明结果的 Schema |
| D17 | 写权限包 = 写入范围 + 能否运行命令；派生时由父任务转让，必须是它当前持有部分的子集；借出的部分在交还前只有借入方能写，父任务仍可写没借出的部分，它的命令把借出的部分挂为只读（第 8.2 节） |
| D18 | 每个非根任务带一句分工（`role`），存在 MissionTree 节点上；每个任务看得到祖先链、父任务、兄弟任务与自己的子孙（精简树 + 变化通知 + 只读查询工具 `view_tasks`），分工是材料，不带权限（第 3.7 节） |
| D19 | 父任务可以用 `stop_subagents` 停止自己的子任务（连同它们的子树与后台命令）（第 5.1 节） |
| D20 | 送达分两类。非中断：任务在运行就随下一次组装交给它，休眠就唤醒（子任务结果按 `sleep` 的条件，其他一律唤醒，受连续唤醒上限约束）。中断：在途的工作按暂停的规则停下，这一段以 `YIELDED` 结束，立即接上新的一段，信息放在上下文末尾并醒目标出（第 5.2 节） |
| D21 | 中断只能自上而下：用户可以中断任何任务，父任务可以中断自己的子任务；兄弟与子任务之间只发非中断消息 |
| D23 | 上下文按任务隔离保留为缺省；通信系统 = 公开的计划书 + 点对点的通信工具，加上派生合同（授权）、通讯录（裁剪后的任务树）、仓库文件（共享事实）（第 5.3 节） |
| D24 | root 在第一次派生之前必须写计划书，作为所有任务的公开资料；放进上下文还是作为文件由实验决定（第 5.3 节） |
| D25 | `send_message` 升级为通信工具：`inform`、`request`、`reply`，必填摘要，工具调用作为附件按需读取；未答复的请求有兜底（第 5.3 节） |
| D26 | 可见范围：父任务、兄弟、直接子任务；其余任务不透露（第 5.3 节）。取代 D18 中"祖先到根"的可见范围 |
| D27 | 派生的上下文模式 `fresh`（缺省）与 `fork`（只限同类型 Agent）由实验决定是否实现（第 5.3 节） |
| D28 | 逐个唤醒（2026-11-12）：`sleep` 等子任务时缺省每个子任务结束都唤醒负责人（`children` 的 `mode` 缺省 `any`），`all` 只在负责人明确要等一整批时用；子任务失败或被停止时，无论等的是什么都立即唤醒；新增 `siblings` 条件（指名的兄弟，缺省全部结束才唤醒）；只用定时器休眠而兄弟仍在运行时提示改用 `siblings`；缺省兜底超时从 1800 秒改为 600 秒。对照：dsh 的作业通知缺省 `wakeup`，每次完成都唤醒空闲的负责人；Claude Code 以 `<task-notification>` 逐个通知 |
| D22 | 编排不写死（2026-11-12）：缺省是负责人自主分解；系统只写死底线（权限、写入范围与借出、额度、深度与唤醒上限、子任务没结束不能交付、checkpoint）；固定工作流降为范式，按固定图执行保留为用户显式选择的严格模式（[Phase2Plan](Phase2Plan.md) 第 1、2 节） |

## 2. 概念层次

```text
{System}  → [SystemRuntime]                     一个进程，唯一的 Kernel
{Session} → [WorkflowRun] → [TaskGraph]          Session 内的 WorkflowRun 依次进行，同一时刻至多一个
            ├ MissionTree   (业务层，Workflow)   从 TaskGraph 推出；节点 = 一个任务
            │   └ MissionScope (治理层，Kernel)  每个树节点一份：能力上限、写入占用、账本、后台命令、取消边界
            └ Checkpoint 列表 (Session 级)       一致的切面：日志位置 + 工作区快照
{Agent}   → [AgentRun]                          运行层：一个树节点的一段执行；同一节点同一时刻至多一个
{Unit}    → [UnitRun] → [UnitAttempt]           UnitRun 归 Workflow；后台命令启动之后，它的执行尝试归树节点
```

| 层 | 实体 | 回答的问题 | Owner |
|---|---|---|---|
| 业务 | TaskGraph | 什么时候做什么、谁等谁 | Workflow |
| 业务 | MissionTree 节点（下称"任务"） | 这是不是同一个任务、谁对谁负责、上下文的范围 | Workflow（由图推出） |
| 治理 | MissionScope | 这个任务最多能做什么、在哪里写、还能花多少、取消时连带谁 | Kernel.Core（账本归 Monitor） |
| 运行 | AgentRun | 现在由哪一次模型循环在执行这个任务 | Kernel 登记，Workflow 推进 |
| 运行 | UnitRun、UnitAttempt | 一次动作与它的执行尝试 | Workflow、Kernel.Execution |
| 恢复 | Checkpoint | 可以回到哪里 | Kernel.Execution（快照与索引），Workflow（日志位置） |

"Turn"不再是系统实体（D7）。界面里的"第 N 轮"是本 Session 中由用户消息触发的 checkpoint 的序号；
原来按 Turn 保存的东西各自换了归属，见第 9.6 节。

## 3. MissionTree

### 3.1 定义

一个**任务**是 TaskGraph 上一条线性的 AGENT 节点链：链上的每个节点是这个任务的一**段**，每段对应一个 AgentRun。
段有两种接法：

- **步骤**：上一段把自己的事做完了（Turn-chat 的 `reply`、模板 owner 的 `complete_step`），任务按图继续，
  下一段是图上另一个属于同一任务的节点（中间通常夹着人类节点）；
- **延续**：上一段没做完就去等了（`sleep`、`ask_user`），被唤醒时追加的下一段与上一段之间有一条 `CONTINUES` 边。

```text
Turn-chat：  prompt₁ → main·1 → prompt₂ → main·2 → prompt₃ → main·3 …        根任务 main 的三个步骤
派生：       main·2 ─DELEGATE→ frontend·1 ─CONTINUES→ frontend·2               子任务 frontend 休眠过一次
```

- **根任务**：每个 TaskGraph 有且只有一个（D2）。它是这个任务唯一的负责人，图上所有其他任务都由它展开。
  Turn-chat 的根任务是 main；模板的根任务是模板声明的 owner（第 3.5 节）。
- **子任务**：由某个任务的一段经 `run_subagents` 派生，或由模板编译时挂在根任务之下（第 3.5 节）。
  父任务是派生它的那一段所属的任务。
- **任务的结束**：只有任务的最后一段以结束工具成功收尾（子任务交回结果）或以失败结束时，任务才结束（D4）。
  一段因为休眠、等用户、等子任务而结束，任务不结束。

### 3.2 在图上的表示

图仍然是 Workflow 的唯一事实源，MissionTree 是它的纯函数。为此 `GraphNodeRecord` 增加一个字段，`GraphEdge` 增加一种边，
日志增加一种记录：

| 新增 | 含义 |
|---|---|
| `GraphNodeRecord.mission` | AGENT 节点所属的任务：`{ id, parentId? }`，`id` 前缀 `msc`（契约中预留的 `missionScopeId`），根任务没有 `parentId`；HUMAN 节点没有。父任务在节点创建时写下（派生时是调用方的任务，模板编译时是根任务），不靠推断 |
| `CONTINUES` 边 | 从休眠的一段到唤醒时追加的下一段。不参与就绪判定（下一段在追加时就绪）；它让"读这一段的边"能找到接手的那一段（第 3.3 节） |
| `MISSION_ENDED` 记录 | `missionId`、`status`（`SUCCEEDED`、`FAILED`、`INTERRUPTED`）：任务结束的唯一依据 |

段号不写进记录：一个任务的段按 `NODE_STARTED` 的先后排列，由于同一任务同一时刻至多一段在运行（第 3.4 节），这个顺序是全序。

**任务 ID 由路径派生**（沿用 M2Design 第 3.2 节的确定性 ID）：

| 任务 | 路径 |
|---|---|
| 根任务 | `<sessionId>/root/<模板 id>`：同一个 Session 中同一种编排的根任务跨 WorkflowRun 不变，Turn-chat 重开后仍是同一个 main |
| 派生的子任务 | `<父 missionId>/<发起派生的 toolCallId>/<任务名>` |
| 模板编译出的子任务 | `<根 missionId>/template/<节点名>#<迭代号>`：循环每展开一次是一个新任务 |

**MissionTree 由图推出**：

```text
parent(m)   = 任一属于 m 的节点的 mission.parentId（同一任务的节点写的都一样，校验保证）
segments(m) = mission.id = m 的 AGENT 节点，按 NODE_STARTED 的先后
depth(m)    = 根任务为 0，其余为 depth(parent(m)) + 1
ended(m)    = 有 MISSION_ENDED(m)
```

`DELEGATE` 边原有的含义不变（派发者与被派发者的来历，`ask_user` 的 HUMAN 节点也用它）；原来的 `RESUME` 边删除，
"子任务回来了"改由唤醒表达（第 4 节）。节点状态中的 `WAITING` 删除：一段要等待，就结束这一段。

### 3.3 段的结束方式与边的读取

`NODE_ENDED.status` 增加 `YIELDED`：这一段没做完就去等了，会由唤醒追加的下一段接手。它对节点是终态，对任务不是。

| 段怎样结束 | 节点状态 | 任务 |
|---|---|---|
| `sleep`、`ask_user` | `YIELDED` | 休眠，等唤醒（第 4 节） |
| Turn-chat 根任务的 `reply`；模板根任务非末步的 `complete_step` | `SUCCEEDED` | 继续：这一步做完了，下一步按图到来 |
| 子任务的 `finish_subagent`；模板根任务末步的 `complete_step` | `SUCCEEDED`（`blocked` 为 `FAILED`，M2Design 第 3.7 节） | 结束（`MISSION_ENDED`） |
| 失败、熔断、额度收尾后以失败收尾 | `FAILED` | 子任务结束；根任务见下 |
| 中止 | `INTERRUPTED` | 子任务结束；根任务见下 |
| 回溯、续跑（第 7.5、7.6 节） | 切面时在运行的段记为 `YIELDED`（原因 `ROLLED_BACK`、`RESUMED`），立即追加接手的下一段 | 继续 |

根任务只在两种情况下结束：模板根任务末步的 `complete_step`，或运行收敛（此时 Workflow 为它追加 `MISSION_ENDED`）。
Turn-chat 的根任务某一步失败或被中止，与现在相同：下一个 `HUMAN(prompt)` 以 `all_done` 照常到来，下一步仍属于同一个任务。

**读到 `YIELDED` 的边看接手的那一段**：一条边的起点是 `YIELDED` 的段时，`edgeState` 沿 `CONTINUES` 边找到接手它的最后一段再判定，
与现在循环边"只读最后一次迭代"的做法相同（`effectiveSource`）；还没有接手的段（任务在休眠）时边为 `WAITING`。
所以模板里"子任务 A 完成后 B 开始"无论 A 中间休眠几次都成立，下游也不会因为 A 休眠而被跳过。
`SUCCEEDED` 的步骤照常被读取：Turn-chat 中 `main·1` 回复之后 `prompt₂` 就绪，与现在一样。

### 3.4 一个任务的性质

- **同一时刻至多一个 AgentRun**：任务的一段结束之前，不会登记它的下一段（不变量 M1，第 11 节）。
- **上下文以任务为范围**：任务的投影是它全部段的步骤，加上投递给它的通知（子任务结果、后台命令结束、消息、用户答复）。
  原来 main 跨 Turn、跨 WorkflowRun 的投影规则推广到所有任务；子任务被唤醒时看到自己之前的全部工作。
- **压缩以任务为对象**：`CONTEXT_COMPACTED.target` 改为 `{ missionId }`，原来的 `MAIN` 与 `AGENT_RUN` 两种取消。
- **`read_output` 与交接以任务为范围**：任务能读自己所有段的工具输出；交接登记的接收方 `to` 改为 `{ missionId }`。
  原来代码中以 `agent.id === 'main'` 判断"顶层"的五处（M2Baseline 缺口 13）全部改为按任务判断，根任务按 `parent` 为空判断。
- **拒绝仍绑定 AgentRun**：用户拒绝某项能力后，只对这一段生效；下一段可以重新询问（与现在"下一个 Turn 可以改主意"一致）。

### 3.5 模板中的根任务（owner）

模板必须声明 owner（D15），编译规则如下：

```yaml
id: research
version: v1.0.0
owner: { agent: main }
checkpoints: { onHuman: true, onRootSpawn: true }   # 第 7.2 节；缺省即此值
nodes:
  - { name: plan,   kind: AGENT, role: owner, goal: "写出调研简报并派生 explorer 调研" }
  - { name: review, kind: HUMAN, request: { type: review, artifactFrom: plan }, dependsOn: [plan],
      loop: { to: plan, when: { field: verdict, equals: reject }, maxIterations: 3 } }
  - { name: verify, kind: AGENT, agent: explorer, goal: "核对报告中的引用", dependsOn: [review] }
  - { name: report, kind: AGENT, role: owner, dependsOn: [verify], output: true }
```

- `role: owner` 的节点是根任务的步骤（`mission.id` 为根任务）。校验：owner 节点之间必须有全序
  （任意两个 owner 节点之间都有依赖路径），否则 `OWNER_NOT_LINEAR`；这同时保证前一个 owner 步骤休眠时，
  后一个不可能就绪（它的入边经前一步读到 `WAITING`），根任务因此不会同时有两段在运行。
  循环展开复制的 owner 节点仍属于根任务。
- 其他 AGENT 节点是根任务的子任务（`mission.parentId` 为根任务，每个节点、每次迭代一个任务）。它们的结果照常沿依赖边交给后继，
  同时登记一次交给根任务的交接，并作为通知在根任务的下一段出现，所以根任务是名副其实的负责人。
- 根任务的一步以 `complete_step` 收尾后，下一个 owner 节点就绪时就是它的下一步。最后一个 owner 节点（标 `output: true` 的那个，
  校验要求恰有一个，并且是 owner 节点）的 `complete_step` 结束根任务。
- 根任务结束、并且图上没有可以就绪的节点时，运行收敛；必有报告的规则不变（M2Design 第 7.3 节）。

**Turn-chat 是一个普通的模板**（D6）：owner 是 main；它只有一条生长规则——根任务的一段以 `reply` 结束后，
追加一个 `HUMAN(prompt)` 节点，答复唤醒根任务的下一段。它的 checkpoint 策略是 `{ onHuman: true, onRootSpawn: false }`。
原来写在代码里的 `chat` 生长规则变成"owner 在 `reply` 之后等开放输入"这一条通用规则的实例，不再有专门的分支。

在 Turn-chat 中执行 `/run <模板> <目标>` 时，模板实例作为 main 的一个子任务运行：模板的 owner 成为它的根，
挂在 main 之下（这就是 M2ReleasePlan RP3-ORCH-1"预置工作流作为子图供 Turn-chat 调用"的机制）。

### 3.6 沿树收窄的规则

| 项 | 规则 | 由谁强制 |
|---|---|---|
| 能力上限 | 子任务的 MissionScope 上限不超过父任务的；每段 AgentRun 的上限不超过它的 MissionScope | Kernel |
| 写入范围 | 子任务的 `writeScope` 落在父任务的范围内；同时运行的任务写入占用两两不相交（按任务，而不是按 AgentRun） | Workflow 校验，Kernel 强制 |
| 派生 | 任务的深度至多 `maxMissionDepth`（缺省 2：根任务 0、组长 1、工人 2，共三层，D13）；`agent.spawn` 只在 `depth < maxMissionDepth` 时出现在能力上限中 | Kernel |
| 额度 | 子任务的账本来自父任务一段的委派，结束时剩余返还父任务的 MissionScope（第 8.3 节） | Kernel |
| 取消 | 任务被中止或失败时，它的整棵子树一并结束，后台命令一并停止 | Kernel 执行，Workflow 记录 |

### 3.7 分工与可见性（D18）

- `run_subagents` 的每个任务可以写 `role`（≤80 个字符，例如"负责前端""负责后端存储"）；没写时取 `goal` 的开头。它写在节点的 `spawn` 上，
  `projectMissions` 读出，所以和任务树一样是图的函数。根任务没有分工，它的"分工"就是用户的目标。
- 每个任务看得到：祖先链（直到根任务）、父任务、兄弟任务、自己的子孙；每个一行：名字、分工、状态（运行中、休眠、已结束及结果状态）。
  **（2026-11-12，D26，已实现：可见范围改为父任务、兄弟、直接子任务，祖先链与孙子以下不再显示；全局结构由计划书提供，见第 5.3 节。）**
  - 第一段开头放一份当时的树（日志在那个位置的纯函数）；
  - 之后兄弟任务开始或结束时，追加一条通知；子任务结束本来就交来结果；
  - 想看此刻的全貌时调用只读控制工具 `view_tasks`，结果是此刻的树。树的行数有上限，超出时只给数量。
- 分工与树都是 Agent 写的材料，和消息一样不带任何权限。

## 4. 休眠与唤醒

### 4.1 控制工具

所有等待都通过结束当前段来表达（D4、D14）。AgentRun 不再"挂在一个工具调用上等"，所以 AgentRun 没有等待状态，
节点也没有 `WAITING`。

| 工具 | 谁可用 | 效果 |
|---|---|---|
| `run_subagents(tasks)` | 能力上限含 `agent.spawn` 的任务 | 校验与额度划拨同现在（M2Design 第 3.6 节）；**立即返回**"已启动 frontend、backend"，调用方可以继续工作 |
| `sleep({ until, timeoutSeconds?, note })` | 所有任务 | 结束本段，任务休眠，直到 `until` 中任一条件满足（第 4.2 节）。`note` 写给下一段的自己（≤1000 个字符） |
| `ask_user(...)` | main、worker、lead | 参数同现在；派发 HUMAN 节点并结束本段，答复唤醒下一段 |
| `send_message({ to, text })` | 所有任务 | 第 5 节 |
| `reply(text)` | Turn-chat 的根任务 | 发布回复，结束本段，等用户的下一条消息 |
| `complete_step(result)` | 模板的根任务 | 结束本段；是最后一个 owner 步骤时结束根任务 |
| `finish_subagent(result)` | 子任务 | 交回结果，结束任务 |
| `update_todos` | 同现在 | 待办改为按任务保存，下一段从投影里看到 |

结束工具由任务的角色决定（D16）：同一个 Agent 定义可以当根任务也可以当子任务，定义只声明结果的 Schema。
一段的工具列表 = Agent 定义允许的普通工具 + 该角色的结束工具 + 休眠、消息等控制工具。

模型只写文字不调用工具时的规则不变（M2Decisions 第 4 节）：反馈指出本角色的结束工具。

### 4.2 唤醒条件

```ts
type WakeCondition =
  | { kind: 'children'; mode: 'all' | 'any'; names?: string[] }   // 缺省：本任务全部未结束的子任务、all
  | { kind: 'jobs'; mode: 'all' | 'any'; jobIds?: string[] }       // 缺省：本任务全部未结束的后台命令
  | { kind: 'message' }                                            // 任意一条发给本任务的消息
  | { kind: 'timer'; seconds: number }                             // 1–3600，只在本次 WorkflowRun 内有效
  | { kind: 'human'; nodeId: string };                             // 由 ask_user、reply、模板生成，模型不能直接写
// sleep 的 until 是 WakeCondition[]，任一满足即唤醒；timeoutSeconds 到了也唤醒（缺省 1800，上限 3600）
```

- `sleep` 没有任何可能满足的条件（没有未结束的子任务和后台命令、没有定时、不等消息）时不执行，以 FEEDBACK 退回。
- Workflow 在追加 `SEGMENT_YIELDED { nodeId, until }` 之后才发出相关请求（定时向 Kernel 登记，第 8.5 节）。

每种等待的唤醒条件是固定的，模型只能为 `sleep` 选择：

| 等待 | 唤醒条件 |
|---|---|
| `sleep({ until })` | `until` 中的条件，加上 `timeoutSeconds` |
| `ask_user` | 只有这个答复（`human`） |
| Turn-chat 根任务 `reply` 之后等下一条消息 | 下一条消息；以及本任务的后台命令结束（D12，第 4.4 节） |
| 模板根任务的步骤之间 | 不是休眠：下一个 owner 节点按图就绪 |

### 4.3 唤醒

满足条件时 Workflow 依次：

1. 追加 `MISSION_WOKEN { missionId, causes }`，`causes` 按日志顺序列出触发它的事件（子任务结束、后台命令结束、消息、定时、答复、超时）；
2. 追加 `GRAPH_EXTENDED(source: WAKE)`：新的一段，`CONTINUES` 边从上一段指向它；由人类答复唤醒时另有一条从 HUMAN 节点到它的 `DEPENDS` 边；
3. 新的一段就绪，按普通 AGENT 节点启动：登记新的 AgentRun，带同一个 `missionId`。

**新一段看到什么**：它的投影末尾是"唤醒说明"，按 `causes` 的顺序列出：

- 子任务全部结束：汇合结果，按 `run_subagents` 中任务的书写顺序排列（保留现在的规则：上下文可复现、前缀缓存可命中）；
  `mode: 'any'` 时只列已结束的，其余标"仍在运行"；
- 后台命令结束：第 6.4 节的结束通知；
- 消息：第 5 节的格式；
- 定时、超时：一行说明，以及当前仍在运行的子任务与后台命令。

**没有被休眠接住的事件**：任务正在运行时收到的通知（子任务结束、后台命令结束、消息），在它下一次组装上下文时出现在末尾，
与运行中插话（`steer`）的投递方式相同。任务已经结束时，发给它的消息以 FEEDBACK 告诉发送方"对方已结束"。

### 4.4 唤醒的上限与等用户的根任务

- **连续唤醒上限**（D12）：由后台命令、消息、定时触发的唤醒，每个任务在两次人类输入之间至多 `maxConsecutiveWakes` 次（缺省 3）。
  超过之后这类事件只积累通知，不再唤醒；本运行中任何一次人类输入（答复、插话、新消息）使所有任务的计数复位。
  子任务结束、人类答复触发的唤醒不计数：它们是任务本来就在等的东西。
- **等开放输入的根任务**（Turn-chat 中 `reply` 之后）会被自己的后台命令结束唤醒（D12）。Workflow 先以
  `withdrawHuman` 请 Kernel 收回开放输入的请求（运行离开 AWAITING_INPUT，界面保留输入框里的内容；用户恰好已经提交时，
  Kernel 以 `HUMAN_ALREADY_ANSWERED` 拒绝，这次唤醒改为把通知积累给答复唤醒的那一段），再追加根任务的下一段；
  这一段处理完再 `reply` 时重新请求开放输入。这一段是 Turn-chat 中唯一不由用户消息开启的一步，界面标为"后台任务结束后的跟进"。
- **等局部询问的任务**（`ask_user` 之后）只由答复唤醒：后台命令与消息只积累通知，避免同一个问题被问两遍。
- **停滞检测**：运行中没有活动的 AgentRun、没有在途 Unit、没有运行中的后台命令与定时、没有待答复的人类请求，
  却有任务在休眠时，Workflow 以 `causes: [STALLED]` 唤醒根任务，说明哪些任务在等什么。根任务自己就在等子任务时同样被唤醒。
  这保证编排不会互相等死。

## 5. 跨任务消息

```ts
send_message({
  to: 'parent' | 'children' | 'siblings' | string;   // string 为子任务或兄弟任务的任务名
  text: string;                                        // ≤4000 个字符
})
```

- **只沿树传递**：父、子（全部或按名字）、兄弟（同一个父任务的其他子任务）。不能跨层，也不能发给自己。
  根任务没有 `parent` 与 `siblings`。目标不存在时以 FEEDBACK 退回。
- **记录**：Workflow 追加 `MISSION_MESSAGE { messageId, from: missionId, to: missionId[], source: { modelTurnRequestId, toolCallId } }`，
  正文就在模型输出里，不复制。工具结果是一行"已发送给 backend"。
- **投递**：对每个接收任务，按第 4.3 节——正在运行就在下一次组装上下文时出现在末尾；在休眠并且 `until` 含 `message`
  就唤醒（受第 4.4 节的上限约束）；在等局部询问就积累；已结束就告诉发送方。
- **接收方看到的**：`[来自任务 frontend 的消息] …`。消息是**材料，不是指令**：发送方可能读过被注入的网页或文件，
  所以消息与工具结果同一信任级别，也不带任何权限；能力、写入范围与额度都不随消息流动。
- **限量**：每段至多 `maxMessagesPerSegment` 条（缺省 10）；每个任务在两次人类输入之间收到的消息超过 50 条时，
  之后的只积累、不再唤醒。
- **用途**：兄弟之间传递接口约定（前端告诉后端它要的 API 形状）、子任务向父任务汇报阶段性结果或提问。
  需要回复时，发送方 `sleep({ until: [{ kind: 'message' }] })`。父任务对子任务的回复同样是一条消息。

接口约定这类需要长期共享、可以追溯的内容，仍然应该写进仓库里的文件（在某个任务的写入范围内），
消息只用于通知"约定在哪里、改了什么"。这与会议记录里"共享介质就是仓库本身"的结论一致。

### 5.1 停止子任务（D19）

`stop_subagents({ names, reason })`：父任务停止自己的子任务（`names` 为任务名，`["all"]` 为全部未结束的子任务）。被停止的任务：
在运行的段按暂停的规则停下在途工作（第 5.2 节），休眠的直接结束，还没开始的不再开始；任务记为 `INTERRUPTED`，
它的整棵子树一起停止；父任务收到结果通知（"被停止：原因"，以及它改过的文件）。只能停止自己的子任务。

### 5.2 送达的两类（D20、D21）

| 送达 | 任务正在运行 | 任务在休眠 | 任务在等 `ask_user` 的答复 |
|---|---|---|---|
| 非中断：用户插话、父任务或其他任务的消息、后台命令结束 | 下一次组装时出现在末尾 | 唤醒（受连续唤醒上限约束） | 积累到答复唤醒时 |
| 非中断：子任务结束的结果 | 同上 | 按 `sleep` 的 `children` 条件；没写时等全部 | 同上 |
| 中断：父任务的 `send_message(interrupt: true)`、用户的中断 | 在途的工作按暂停的规则停下（读与模型调用取消，写入等它写完，前台命令取消并说明），这一段以 `YIELDED` 结束（原因 `INTERRUPTED`），立即接上新的一段 | 立即唤醒，不受上限约束 | 收回询问，立即唤醒 |

中断的信息放在新一段上下文的**末尾**，醒目标出（"⚠ 打断：……请先处理"），而不是开头：开头是系统提示词和整段历史，
在那里插入会让前缀缓存全部失效。中断只能自上而下（D21）：子任务和兄弟任务只能发非中断消息，否则一个被注入的任务就能反复打断它的负责人。
中断一个任务不会停止它的子任务；要停止子任务，用 `stop_subagents`。

### 5.3 上下文与通信的架构（D23–D27，2026-11-12 定）

**上下文按任务隔离（现状，保留为缺省）。** 每个任务的上下文由会话日志按任务投影，互不共享：

| 任务看得到 | 任务看不到 |
|---|---|
| 系统提示词与工具；项目说明（根目录 `AGENTS.md`）；运行环境 | 父任务的对话历史 |
| 任务说明：名字、Agent、`goal`、`acceptance`、`writeScope`、`inputs`（产物引用） | 父任务读过的文件与工具结果（除非作为 `inputs` 或附件给出） |
| 依赖任务的结果；开工时的任务树快照（裁剪到可见范围） | 兄弟与子孙的工作过程 |
| 自己全部段的历史；发给它的消息、通知；子任务交回的结果（摘要 + 引用） | 可见范围之外的任务（下文） |

隔离的理由：上下文窗口有限，注意力不被稀释，注入不沿上下文扩散，每个任务看到什么由日志确定、可以重放。
要省的不是"写简报"（按 deepseek-flash 的价格，500 个输出 token 约等于 2000 个未命中的输入 token），而是子任务重新调查父任务已经知道的东西。

**完整的通信系统由两层加三样已有的东西组成：**

| 组成 | 是什么 | 为什么不能用别的代替 |
|---|---|---|
| **计划书**（公开层，D24） | root 在第一次派生之前写的计划：交付物、整体方案、分工、接口归属、全局约束。所有任务都能看到 | 全局目标与结构只有一份，不该由每个父任务各转述一遍 |
| **通信工具**（点对点层，D25） | 任务之间传递信息、索要信息：摘要 + 附件列表，接收方按需读取 | 部门层（上级交代的细节）与横向层（平级之间对齐）都通过它传递 |
| 派生合同（已有） | 目标、意图、验收、写入范围、额度：由 Kernel 校验并只能收窄 | **权限不是信息**：消息不带权限，写入范围与额度必须走派生，由 Kernel 执行 |
| 通讯录（已有，裁剪） | 开工时的任务树快照：父任务、兄弟、直接子任务的名字、角色、状态 | 不知道一个任务存在，就无法联系它；内容靠通信去问 |
| 仓库文件（已有） | 会多次修改的共享事实（如接口约定 `api/API.md`）放在负责方写入范围内的文件里，改后发通知附指针 | 消息是一次性的，来回传会乱版本；写入范围就是所有权，不需要另造公告板 |

**计划书（D24）。** `run_subagents` 在本任务树还没有计划书时被拒绝，提示先写。计划书登记为运行的公开资料，所有子孙任务都能看到。
它是直接放进上下文（放在系统提示词之后、最前面，同类 Agent 之间前缀相同，可以命中缓存），还是作为文件只在任务说明中给出路径，
由对照实验决定（[Phase2Plan](Phase2Plan.md) 第 4 节）；折中是上下文中放摘要、全文作为文件。

**通信工具（D25）。** `send_message` 升级为：

```ts
send_message({
  to,            // parent、某个兄弟、某个直接子任务，或 siblings / children
  kind,          // inform 通知 | request 索要 | reply 答复
  summary,       // 必填，短：接收方的上下文里只放它
  body?,         // 详细内容
  references?,   // 自己做过的工具调用编号：作为附件，接收方用 read_output 读取
  replyTo?,      // 答复哪一个 request
  interrupt?,    // 仍只能向下（D21）
})
```

- 附件复用交回结果的机制（登记引用、`ref_N/toolCallId`、`read_output`）：接收方的上下文里只出现摘要与附件清单（编号、工具、一句说明）；
- `request` 不阻塞发送方，发送方通常休眠等答复（唤醒条件 `message`）。系统记下未答复的请求：接收方结束时仍未答复，系统通知请求方"对方已结束，未答复"；
  互相等待由停滞检测唤醒较高层的任务；每个任务同时未答复的请求有上限；
- 消息是材料，不是指令，也不带权限（与现在相同）。

**可见范围（D26）。** 一个任务的通信对象与它能看到的组织结构是**父任务、兄弟、直接子任务**；祖先（父任务以上）、叔伯、孙子及更远的任务都不透露。
孙子由子任务管理，结果逐级汇总，经理不越级。叶子任务看不到全局结构由计划书补上。跨分支的沟通经各自的上级转达；
以后如果代价大，可以由共同的上级"引荐"，临时开通一条通道（未定）。这也缩小了被注入的任务能联系的对象。

**派生时的上下文模式（D27，待实验）。** `fresh`（缺省）：任务说明 + 指针 + 计划书；`fork`：只允许派生与自己同类型的 Agent，继承父任务的历史前缀。
前缀缓存要求请求前缀完全一致，不同类型的 Agent 系统提示词与工具不同，继承在最开头就断了缓存，所以 `fork` 只对同类型的分身有意义。
两种模式在大任务集上比较 token、通过率与压缩次数后再决定是否实现。

## 6. 后台命令

### 6.1 Unit 形式

后台命令必须以 Unit 的形式存在（D5）。它仍是 `run-command` Unit，输入多一个字段，执行方式不同：

```ts
run_command({ command, workdir?, timeoutMs?, network?, runInBackground?: boolean })
```

| | 前台命令（现状） | 后台命令 |
|---|---|---|
| 提交 | 发起的 AgentRun 提交 | 同样由发起的 AgentRun 提交（`submitUnit` 带 `background: true` 与 `missionId`），进程起来之后这次尝试脱离该 AgentRun 的队列，归属于任务 |
| UnitRun 的路径 | `<agentRunId>/round-<n>/<序号>` | 同前台；另有任务内的编号 `job_<n>`（本任务第 n 个后台命令，由日志推出） |
| 工具结果 | 命令结束后的输出 | Kernel 发出 `UnitStarted` 后，Workflow 以"已在后台启动任务 job_3"作为这次工具调用的结果，本轮因此可以结束 |
| 结束 | `UnitReport` 交给发起的 AgentRun | `UnitReport` 带 `missionId`，作为结束通知交给归属的任务（第 6.4 节） |
| 执行超时 | `timeoutMs`，至多 10 分钟 | 没有执行超时；受 `jobMaxSeconds`（缺省 3600）与运行收敛约束 |
| 能力、授权、沙盒 | 第 5、6 节 | **完全相同**：同样的两步判定、同样的资源键、同样的 bwrap 与可写路径；写入只能在任务的写入范围内 |
| 全局 EXEC 互斥 | 占用 | 启动之后不占用；另受 `maxBackgroundJobs`（每个运行缺省 4）约束 |

**前台超时转后台**（对齐 dsh 的 `promoteOnTimeout`）：前台命令到达 `timeoutMs` 时不杀，Kernel 把这次尝试转为该任务的后台命令，
工具结果是"命令超过 N 秒，已转到后台任务 job_4"。`run_command` 的 `promoteOnTimeout?: boolean` 缺省 `true`。

### 6.2 工具

| 工具 | 种类 | 效果 |
|---|---|---|
| `job_output({ jobId, wait?, timeoutMs? })` | READ Unit `job-output` | 返回自上次读取以来的新输出，末尾带 `[status: running \| exited(0) \| killed …]`。`wait: true` 时等到结束或 `timeoutMs`（上限 600000），收到人类插话时提前返回。读取位置记在日志里，重放结果相同 |
| `job_list()` | 控制工具，由日志推出 | 本任务的后台命令：编号、命令摘要、状态 |
| `job_kill({ jobId, reason? })` | Unit `job-kill` | 停止并确认，走现有的停止升级顺序（M2Design 第 4.7 节）；无法确认仍是停机级故障 |

一个任务只能看到与操作自己的后台命令；父任务读子任务的输出要通过子任务交回的引用（`ref_N/…`），与现在的交接规则相同。

### 6.3 生命周期

| 事件 | 后台命令 |
|---|---|
| 发起它的那一段结束（休眠、`reply`） | 继续运行：它属于任务，不属于 AgentRun |
| 任务结束（交回结果、失败） | 停止，结束通知写进任务的最后记录 |
| 暂停 | 继续运行（与 dsh、Claude Code 一致；暂停只停 Agent 的推进） |
| 中止 | 全部停止 |
| checkpoint | 不等它（D9），把运行中的命令记进 checkpoint |
| 回溯 | 回溯点之后启动的、以及 checkpoint 记录为运行中的都停止；还原会覆盖它们在快照之后写入的文件（第 7.5 节） |
| 运行收敛、切换 Session、进程退出 | 全部停止；bwrap 带 `--die-with-parent`，进程退出时没有幸存者 |
| 打开 Session 时的修复 | 日志里没有结束记录的后台命令记为 `LOST` |

**开放输入不要求后台命令结束**：Turn-chat 中 main `reply` 之后，后台命令可以继续跑，用户照常输入。
Kernel 的静止条件因此改为"没有活动的 AgentRun、没有在途的前台 Unit"（第 8.4 节）。

### 6.4 结束通知

```text
后台任务 job_3（npm run test:e2e）已结束 [exited(1)，耗时 412 秒]。未读输出：
…（≤2048 字节时整段内联；更长时只给末尾一段，并注明用 job_output 或 read_output 读完整内容）
```

通知按第 4.3 节投递：任务运行中就进入下一次上下文；休眠并且唤醒条件含这个后台命令（`sleep` 的 `jobs`，
或 Turn-chat 根任务等下一条消息时的隐含条件，第 4.2 节）就唤醒，受第 4.4 节上限约束；其余情况积累到下一次唤醒。完整输出按工具输出的规则保存（预览长期保留，完整输出 7 天，M2Design 第 8.2 节）。

### 6.5 实现方式与差别

- **脱离而不是另起一种 Unit**：后台命令仍是一次 `run-command` 尝试，走同样的准入、授权、沙盒与 EXEC 队列。进程起来后（或前台到达 `timeoutMs` 时），沙盒把进程**交给 Supervisor 的作业表**，这次尝试以"已在后台启动"结束，EXEC 互斥随之释放。作业以它脱离的那次执行的 `executionId` 为键（`jobKey`），任务内的名字 `job_N` 由 Workflow 写在 `JOB_STARTED` 里。
- **结束与读取**：作业结束时 Supervisor 发 `JobEndedFact`（地址 `kernel-core.job-facts`），Kernel 转成给 Workflow 的 `JobEnded`；`job_output` 与 `job_kill` 走新的系统调用 `controlJob`，Kernel 原样交给 Supervisor。作业表保留每个作业输出的最后 4 MiB，结束的作业仍可读。读取位置记在 `JOB_READ`。
- **`job_output` 不等待**：与第 6.2 节不同，没有 `wait`。等待一律用 `sleep`（`jobs` 条件），与"等待就是休眠"一致，也不会让 Workflow 卡在一次调用上。
- **作业工具是控制工具**：和其它控制工具一样必须单独调用；一次读取至多 12000 字节（要放进工具调用的答复，`FEEDBACK` 的上限因此提到 16000）。
- **没做的**：打开 Session 时把没有结束记录的作业记为 `LOST`（现在运行结束即视为停止，`job_list` 显示"随运行停止"）；作业停止无法确认时只在结束记录里标出，不升级为停机级故障；后台命令在尝试结束后写入的文件不进入变更扫描（写入仍受沙盒的可写范围约束）。

## 7. Checkpoint

### 7.1 定义

checkpoint 是一个**一致的切面**：日志中的一个位置，加上该位置对应的工作区快照。

```ts
interface Checkpoint {
  checkpointId: string;          // 前缀 ckp
  seq: number;                   // 本 Session 中 checkpoint 的序号；界面的"第 N 轮"是 kind = HUMAN_PROMPT 的序号
  workflowRunId: string;
  kind: 'HUMAN_PROMPT' | 'HUMAN_ANSWER' | 'ROOT_SPAWN' | 'TEMPLATE';
  label: string;                 // 界面用："第 3 轮：把登录改成…"、"派生 frontend、backend"、"审阅 plan"
  cutSeq: number;                // 日志切面：此位置及之前的记录属于切面之前
  triggerSeq?: number;           // 触发它的记录（答复、派生），回溯时与切面之后的记录一起被取代
  snapshot: string;              // 影子 git 中的快照
  heldUnits: string[];           // 屏障期间被扣住、尚未执行的 requestId
  runningJobs: string[];         // 切面时仍在运行的后台命令
}
```

**快照照旧**：影子 git、独立 `GIT_DIR`、排除规则、16 MiB 上限都不变（M2Design 第 4.6 节），变的只是何时拍。

### 7.2 何时拍

checkpoint 策略写在模板里（`checkpoints`），Turn-chat 与其他编排走同一套代码（D8）：

| 时机 | `kind` | 适用 | 触发记录（`triggerSeq`） | 回溯后回到 |
|---|---|---|---|---|
| 开放输入得到答复（含 `mas run` 的目标、Turn-chat 的每条消息） | `HUMAN_PROMPT` | `onHuman`；Turn-chat 只有这一种 | `HUMAN_ANSWERED` | 等这条输入的状态，用户可以重写它 |
| 局部询问得到答复 | `HUMAN_ANSWER` | `onHuman` | `HUMAN_ANSWERED` | 等这个答复的状态 |
| 根任务调用 `run_subagents` | `ROOT_SPAWN` | `onRootSpawn`；嵌套层的派生不拍（D10） | 发出这次派生的 `MODEL_TURN` | 这次派生之前：根任务重新决定要不要派生、怎样派生 |
| 模板节点声明 `checkpoint: true` | `TEMPLATE` | 模板 | 无 | 该节点启动之前 |

**触发的后果在 checkpoint 之后才发生**：Workflow 收到触发事件（答复、派生）后先请求 checkpoint，
等 `CHECKPOINT_TAKEN` 记下之后，才启动被唤醒的段、登记子任务、启动声明了 checkpoint 的节点。
所以在触发记录与切面之间，被触发的任务没有任何记录，回溯时只需把触发记录与切面之后的记录一起取代。
为了让切面干净，`run_subagents` 仍然不能与普通工具出现在同一次模型输出中（`CONTROL_MIXED` 保留）。

这条规则保证 Turn-chat 的回溯与现在的 `/undo` 一致：回到上一条消息发出之前，用户可以重写这条消息，
被回退的文件只是这一轮改过的那些。

### 7.3 屏障

Workflow 决定拍 checkpoint 时追加 `CHECKPOINT_REQUESTED`，再向 Kernel 发 `requestCheckpoint`。Kernel：

1. 进入屏障：**只扣住会改文件的 Unit**（D9）——新的 WRITE 与前台 EXEC 不派发，留在队列里；READ、网页、MODEL 照常；
2. 等在途的 WRITE 与前台 EXEC 结束（后台命令不等）；
3. 拍快照，写 checkpoint 索引；
4. 发出 `CheckpointTaken { checkpointId, snapshot, heldUnits, runningJobs }`，解除屏障，被扣住的 Unit 依次派发。

Workflow 收到后追加 `CHECKPOINT_TAKEN`，它的日志位置就是 `cutSeq`。

**为什么这样仍是一致的**：屏障期间工作区只可能被在途的写入与命令改动，它们的结果记录都在 `CHECKPOINT_TAKEN` 之前；
被扣住的 Unit 还没有执行，它们的提交记录在切面之前、结果在切面之后，回溯时按"从未执行"处理（`heldUnits` 就是这份清单，第 7.5 节第 6 步）。
MODEL 与 READ 不改文件，它们的记录落在切面哪一边都与快照一致；落在切面之后的，回溯时随之被取代。
唯一的例外是后台命令（D9）：它们在快照之后的写入不在快照里，checkpoint 记下它们，回溯时先停止再还原。

屏障期间有授权询问挂起的 WRITE 或 EXEC 不算在途（与现在"等待授权不占并发"相同），不会让屏障等用户。
屏障的等待上限是 `checkpointBarrierMs`（缺省 600000）；超过时放弃这次 checkpoint，记 `CHECKPOINT_SKIPPED`，运行照常。

### 7.4 索引与 Session 级的列表

Kernel 的 `snapshot-index.jsonl` 改为 `checkpoint-index.jsonl`（Session 级，跨 WorkflowRun）：

```ts
type CheckpointIndexLine =
  | { kind: 'TAKEN'; checkpointId: string; seq: number; workflowRunId: string; ckpKind: Checkpoint['kind'];
      snapshot?: string; at: string }
  | { kind: 'SEALED'; checkpointId: string; sealSnapshot?: string;
      changedFiles: { path: string; change: 'ADDED' | 'MODIFIED' | 'DELETED' }[]; at: string }
  | { kind: 'EPOCH'; repositoryRoot: string; at: string }
  | { kind: 'ROLLED_BACK'; toCheckpointId: string; revertedCheckpointIds: string[]; forced: boolean;
      backupSnapshot?: string; at: string };
```

一个 checkpoint 在下一个 checkpoint 拍下、或运行静止（等开放输入、收敛）时被**封口**（`SEALED`）：
记下封口时的快照与这段时间改动过的文件。这正是原来 `TURN_STARTED` 与 `TURN_ENDED` 的一对，只是不再叫 Turn。
回溯的"外部修改检查"用封口快照比较（M2Design 第 4.6 节第 2 步）。

### 7.5 回溯

**条件**：运行处于等开放输入或暂停（没有在途的前台 Unit）。现在 `/undo` 只能在等输入时执行；
暂停时也可以回溯，是因为任何编排都可能需要在运行中途回到某个 checkpoint。

**步骤**（与现在的 `/undo` 第 1–6 步相同，"被回退的 Turn"换成"切面之后的全部 checkpoint 区间"）：

1. 结束所有活动的 AgentRun（`INTERRUPTED(ROLLED_BACK)`），停止切面之后启动的后台命令，以及 checkpoint 记录为运行中的后台命令；
2. 确定范围：切面之后各区间改动过的文件的并集，加上被停止的后台命令写过的文件；
3. 外部修改检查、询问"强制回退或取消"、兜底快照、写入前复查：完全照旧；
4. Kernel 在索引中追加 `ROLLED_BACK`，发出 `RolledBack`；Workflow 追加 `ROLLED_BACK { toCheckpointId, revertedCheckpointIds, forced, externalFiles, backupSnapshot? }`；
5. 投影：`cutSeq` 之后的记录与 `triggerSeq` 被一条说明取代（"已回到 checkpoint 3：派生 frontend、backend 之前"）。日志只追加；
6. **图从切面恢复**：切面时正在运行的段记为 `YIELDED`（原因 `ROLLED_BACK`），各自立即追加接手的下一段（同一个任务，新的 AgentRun），
   从任务的投影接着做；那一段在切面时还没有结果的工具调用（`heldUnits`，以及结果落在切面之后的）不重新提交，
   而是作为"回溯前未执行"的说明交给新的一段，由它决定是否重做；切面时在休眠的任务仍在休眠，等的东西照旧；
   Kernel 关闭切面之后打开的 MissionScope，切面时打开的子任务按原委派的份额从父任务重新划拨（不足时按余额划拨，
   余额为零的子任务以额度收尾）；
7. 回溯之后运行处于暂停（`HUMAN_*` 的切面则重新发出那个人类请求）。用户 `/continue`（可以附加说明）继续。

额度不退回：回溯前花掉的 token 照常计入运行级账本（与现在相同，`/undo` 不退钱）。授权条目保留：它们属于 WorkflowRun。

**指令**：

| 指令 | 效果 |
|---|---|
| `/checkpoints` | 列出本 Session 尚未被回退的 checkpoint：序号、种类、标签、改动的文件数 |
| `/undo` | 回到最近一个 checkpoint 之前的那个状态，可以连续执行；Turn-chat 中等于现在的 `/undo` |
| `/rewind <序号>` | 回到指定的 checkpoint |
| `/diff [序号]` | 该 checkpoint 区间的改动（缺省最近一个） |

不提供 redo；被覆盖的内容在兜底快照中（与现在相同）。

### 7.6 重开与续跑

打开一个 Session 时，如果它最后一个 WorkflowRun 没有收敛（进程退出、停机），Workflow 先按现在的规则修复日志
（未完成的 Unit 记为 `INTERRUPTED`，M2Design 第 10.3 节），然后由界面问用户（D11）：

| 选择 | 效果 |
|---|---|
| **从 checkpoint 续跑**（缺省） | 回溯到最近的 checkpoint（第 7.5 节，含外部修改检查），开启新的 WorkflowRun，从切面恢复图，进入暂停；用户 `/continue` |
| **不续跑** | 编排记为 `INTERRUPTED`，文件保持原样；Session 以 Turn-chat 继续，结果与中断说明出现在 main 的历史里 |

Turn-chat 的最近 checkpoint 就是"等最后一条消息"，所以正常退出后重开不需要询问：直接回到等输入。
只有上一轮做到一半时才询问，此时"续跑"会还原那半轮的改动，"不续跑"保留它们（即现在的行为）。

续跑是跨进程的：Kernel 的运行状态（授权条目、Lease、账本、在途尝试）不跨进程的规则不变——新的 WorkflowRun 重新计算一切，
授权由人重新签发。跨越的只是图与任务，它们本来就是日志的投影。

## 8. Kernel 的变化

Kernel 仍然与业务无关、与拓扑无关（M2Design 第 7 节）：它看到的 `missionId` 与父子关系只是不透明的 ID 与引用，
用于能力、额度、写入与取消，不用于理解任务图。

### 8.1 MissionScope

每个任务一份，Kernel.Core 在内存中维护（不跨进程，续跑时重建）：

```ts
interface MissionScope {
  missionId: string;
  parentMissionId?: string;
  depth: number;
  capabilityCeiling: Capability[];   // 由 Agent 定义、父任务的上限、预设与深度计算；之后不变
  writeRoots: string[];              // 写入占用；减去已委派给子任务的部分（第 8.2 节）
  ledger: Ledger;                    // 第 8.3 节
  jobs: string[];                    // 本任务的后台命令
  wakeTimers: { timerId: string; at: string }[];
  status: 'OPEN' | 'CLOSED';
}
```

| 请求 | 说明 |
|---|---|
| 打开 | 任务的第一段登记时打开（`registerAgentRun` 带 `mission: { id, parentId? }`，没有这个 MissionScope 时就打开它）：根任务在运行开启后，子任务在它第一次就绪时。`reserveDelegation` 只为子任务划拨额度（带各任务的 `missionId`），不打开 MissionScope，所以彼此有依赖、写入范围重叠的兄弟任务不会因为同时"打开"而冲突 |
| `registerAgentRun` 带 `mission` | MissionScope 不能是 CLOSED；该任务没有活动的 AgentRun（`MISSION_BUSY`）；父任务的 MissionScope 是 OPEN 的（父任务可以在休眠，不要求父 AgentRun 还在）。AgentRun 的能力上限 = MissionScope 上限与预设的交集，每段重新计算 |
| `closeMissionScope` | 任务结束时：剩余额度返还父任务，释放写入占用，停止后台命令与定时 |

原来 AgentRun 上的 `parentAgentRunId`、`delegationId`、`taskName` 移到 MissionScope 上：父子关系属于任务，不属于某一段。

### 8.2 写入占用按任务

- 运行中的任务（OPEN 的 MissionScope）写入占用两两不相交，**休眠的任务也算**：否则兄弟任务可以趁它休眠写进它的范围；
- **写权限包**（D17）：写入范围 + 能否运行命令。派生时父任务从自己持有的范围里划出子集交给子任务（`writeScope`；
  `commands: false` 表示不给命令，缺省给，仍受 Agent 定义的上限约束）。子任务可以再划给孙任务。权限包是上限，不是授权：
  具体的命令仍按第 5 节询问用户。
- **借出的部分在交还前只有借入方能写**：父任务写已借出路径以 `WRITE_SCOPE_DELEGATED` 拒绝；没借出的部分照常写。
  父任务的命令照常运行，沙盒把借出的路径挂为只读（已存在的路径；还不存在的目录挂不上，这一点写入限制）。
- 子任务结束时它借的部分交还；一次派生的任务全部结束时 Workflow 交还委派（`releaseDelegation`）。

### 8.3 额度

```text
WorkflowRun 账本（budget.runTokenLimit）
  └─ 根任务的 MissionScope 账本 = 运行级账本
       └─ 段：每个 AgentRun 登记时从它的 MissionScope 划出一份（segmentShare，缺省为 Agent 的份额），结束时剩余返还
            └─ 子任务的 MissionScope 账本：由这一段的 run_subagents 委派划出
                 └─ 子任务的段 …
```

- 根任务每段的份额是 Agent 的缺省份额（`segmentShare`）；子任务每段的份额是它的 MissionScope 当前的全部余额：
  子任务的总花费由委派时划给它的份额封顶，休眠不改变这个上限；
- 根任务一段的份额就是原来"一个 Turn 的份额"的对应物：Turn-chat 中用户每条消息唤醒根任务的一段，这一段连同它委派出去的，
  受这一份额约束，与原来按 Turn 划分额度的效果相同；
- 收尾保留、一次 final-call 仍按 AgentRun（M2Design 第 7.3 节）；
- `BudgetView` 改为 `{ agentRun, mission, run }`。

### 8.4 静止、开放输入与计时

- **静止**：没有活动的 AgentRun，并且没有在途的前台 Unit。后台命令与定时不影响静止（第 6.3 节）。
- **开放输入**（`requestHuman(prompt)`）仍要求静止；受理时运行进入 AWAITING_INPUT，并封口当前 checkpoint（第 7.4 节）。
  原来"受理时结束当前 Turn"的动作删除，`TurnClosed` 事件删除。
- **活动时限**（取代 Turn 超时）：一个活动期从运行离开 AWAITING_INPUT 起（开放输入得到答复、运行开启、
  等输入的根任务被后台命令唤醒），到下一次请求开放输入或运行收敛为止，不计暂停与"全部工作都在等人类"的时间，
  上限 `activityTimeoutSeconds`（Turn-chat 1800；其他编排 14400，因为它们是长任务）。到点按中止处理，与原来的 Turn 超时相同。
- **暂停**：原来的不变量"PAUSED 时在途尝试数为 0"改为"PAUSED 时在途的前台尝试数为 0"，后台命令不受暂停影响（第 6.3 节）。
- **AgentRun 的墙钟**照旧；休眠的任务没有 AgentRun，不计墙钟。

### 8.5 定时与屏障

| 请求或事件 | 说明 |
|---|---|
| `scheduleWake({ missionId, timerId, seconds })`、`cancelWake` | Kernel 计时（时间归 Kernel），到点发出 `WakeDue { missionId, timerId }`；只在本运行内有效 |
| `requestCheckpoint({ kind, label, triggerSeq? })` | 第 7.3 节；屏障期间再来的请求合并为同一个 checkpoint |
| `CheckpointTaken`、`CheckpointSkipped`、`RolledBack` | 第 7.3、7.5 节 |
| `UnitStarted { requestId, missionId, jobId }` | 只用于后台命令与前台转后台 |
| `withdrawHuman({ humanRequestId })` | Workflow 请求收回待答复的开放输入（第 4.4 节）；Kernel 让运行离开 AWAITING_INPUT 并通知界面；已被答复时以 `HUMAN_ALREADY_ANSWERED` 拒绝 |

### 8.6 删除的东西

`TurnRecord`、Turn 账本、`TurnClosed`、`HumanAnswered.turnId`、`registerAgentRun` 的 `NO_OPEN_TURN`、
`AGENT_RUN_ACTIVE`（开放输入的拒绝改为 `NOT_QUIESCENT`）、`snapshot-index.jsonl` 的 `TURN_*` 行。

## 9. Workflow 的变化

### 9.1 日志记录

| 记录 | 变化 |
|---|---|
| `GRAPH_EXTENDED` | `source` 增加 `WAKE`；AGENT 节点带 `mission`；边增加 `CONTINUES`，删除 `RESUME` |
| `NODE_ENDED` | `status` 增加 `YIELDED` |
| `MISSION_ENDED` | 新增：`missionId`、`status` |
| `NODE_RESUMED` | 删除（等待改为休眠） |
| `SEGMENT_YIELDED` | 新增：`nodeId`、`until: WakeCondition[]`、`timeoutSeconds`、`noteRef?` |
| `MISSION_WOKEN` | 新增：`missionId`、`causes`（事件的日志位置与种类） |
| `MISSION_MESSAGE` | 新增：第 5 节 |
| `JOB_STARTED`、`JOB_ENDED` | 新增：`jobId`、`missionId`、`requestId`、退出状态；`JOB_OUTPUT_READ` 记录读取位置 |
| `CHECKPOINT_REQUESTED`、`CHECKPOINT_TAKEN`、`CHECKPOINT_SKIPPED`、`ROLLED_BACK` | 新增：第 7 节 |
| `TURN_STARTED`、`TURN_ENDED`、`WORKSPACE_REVERTED` | 删除；后者由 `ROLLED_BACK` 取代 |
| `AGENT_RUN_REGISTERED` | 带 `missionId` |
| `REFERENCES_REGISTERED.to`、`CONTEXT_COMPACTED.target` | 改为 `{ missionId }` |
| `CONTEXT_COMPACTION_REVOKED.reason` | `TURN_REVERTED` 改为 `ROLLED_BACK` |

### 9.2 推进规则

M2Design 第 3.3 节的处理顺序保留，第 6 步"唤醒"改为：

```text
6. 对每个休眠的任务 m，若 until(m) 中任一条件满足、且未超过唤醒上限 → 追加 MISSION_WOKEN，再追加它的下一段（GRAPH_EXTENDED: WAKE）
7. 若运行停滞（第 4.4 节）→ 以 STALLED 唤醒根任务
```

`edgeState` 增加"读取任务的最后一段"（第 3.3 节），`withWaiting` 与 `wakeableNodes` 删除，
新增纯函数 `missionTree(graph)`、`wakeableMissions(graph, view, events)`。属性测试照旧：对任意日志前缀，重放得到的就绪集合、
唤醒集合与 MissionTree 都与运行时一致。

### 9.3 派生

`run_subagents` 的参数与校验保留（M2Design 第 3.6 节），变化：

- 立即返回（D14）。返回之后调用方可以继续调用工具；它对子任务范围的写入被拒绝（第 8.2 节）；
- 汇合结果不再是这次工具调用的结果，而是 `children` 唤醒时的唤醒说明（第 4.3 节）；调用方不休眠、一直工作到收尾时，
  `complete_step`、`finish_subagent`、`reply` 之前必须等它派生的子任务全部结束：仍有未结束的子任务时以 FEEDBACK 退回，
  提示先 `sleep({ until: [{ kind: 'children', mode: 'all' }] })`。这保证"子任务交回结果，父任务才算结束"（D4）。
  这条规则只针对它用 `run_subagents` 派生的子任务；模板编译出的子任务由图的依赖约束，不受它影响；
- 能派生的任务：能力上限含 `agent.spawn`，即 `depth < maxMissionDepth`（第 3.6 节）；派生次数与任务数的上限从"每个 Turn"改为"每个任务"
  （`maxSpawnCallsPerMission` 缺省 4，`maxChildrenPerMission` 缺省 12），另设运行级的 `maxMissionsPerRun`（缺省 60）；
- 任务名在同一个父任务的全部子任务中唯一（原来是一次调用内唯一），因为消息按名字寻址。

### 9.4 内置 Agent

| Agent | 变化 |
|---|---|
| `main` | 可以当 Turn-chat 的根任务（`reply`）或模板的根任务（`complete_step`） |
| `lead`（新增） | 组长：读、检索、在 `writeScope` 内写与编辑、命令（不联网）、派生（受深度限制）、消息。用于"前端组""后端组"这类自己再分工的子任务 |
| `worker`、`explorer` | 不变；增加 `sleep`、`send_message`、后台命令（explorer 没有命令能力，因此没有后台命令） |

具体的提示词与派生准则在 RP2-PA-1 中按评测迭代。

### 9.5 投影

- 任务的投影 = 它所有段的历史（按日志顺序）+ 投递给它的通知 + 唤醒说明。根任务的投影跨 WorkflowRun（同一个 missionId）；
- 每段开头一行运行时说明："你是任务 frontend 的第 2 段；上一段以休眠结束，原因见末尾"，让模型知道自己是被唤醒的；
- **谱系**：子任务的第一段投影开头放精炼的谱系——父任务的目标、自己的目标与验收标准、兄弟任务的名字、目标摘要与写入范围
  （每项限长）。这是 MissionTree 对多 Agent 协作的直接用处：每个 Agent 知道自己在整体中的位置与边界。
  谱系出自父任务写的派生参数，同样是材料，不是指令。

### 9.6 原来按 Turn 保存的东西

| 原来 | 现在 |
|---|---|
| Turn 的开启与结束 | 不再是实体；开放输入的答复是 `HUMAN_PROMPT` checkpoint，静止时封口 |
| Turn 账本 | 根任务每段的份额（第 8.3 节） |
| Turn 超时 | 活动时限（第 8.4 节） |
| 开始、结束快照与快照索引 | checkpoint 的快照与封口快照（第 7.4 节） |
| `/undo`、`/diff` 按 Turn | 按 checkpoint（第 7.5 节） |
| 派生上限按 Turn | 按任务（第 9.3 节） |
| `registerAgentRun` 需要开启中的 Turn | 需要 OPEN 的 MissionScope、运行在 RUNNING |
| Session 列表的 `turnCount` | `promptCount`（`HUMAN_PROMPT` checkpoint 的数量），界面仍叫"轮" |
| `read_output` 不读被回退 Turn 中的调用 | 不读被回溯取代的记录中的调用 |

## 10. 例子：设计一个分布式系统

用户在 Turn-chat 中说："实现一个带 Web 前端的分布式 KV 存储，后端用 Go，前端用 React。"

```text
main·1   读仓库，写出总体设计 docs/design.md；派生（checkpoint 不拍：Turn-chat 只在用户消息拍）
         run_subagents: backend(lead, writeScope: server/), frontend(lead, writeScope: web/)
         → 立即返回；sleep(until: [children all, message])                main 休眠
backend·1   写 server/api.md（API 约定）；send_message(siblings: "API 约定在 server/api.md")
            run_subagents: raft(worker, server/raft/), storage(worker, server/storage/)
            run_command("go test ./... -run Integration", runInBackground) → job_1
            sleep(until: [children all, jobs any, message])             backend 休眠
frontend·1  下一次组装上下文时看到消息 → 读 server/api.md → 写 web/
            run_command("npm run dev", runInBackground) → job_2
            send_message(parent: "前端需要 /keys 支持分页，是否由后端提供？"); sleep(until: [message])
main·2      被消息唤醒（main 的第 1 次连续唤醒）：
            send_message(backend: "/keys 加分页，见 frontend 的要求"); send_message(frontend: "后端会加，先按 api.md 草稿做")
            sleep(until: [children all, message])
backend·2   被 main 的消息唤醒：更新 api.md 与实现；sleep(until: [children all, jobs any])
frontend·2  被 main 的消息唤醒 → 完成页面 → finish_subagent（job_2 随任务结束停止）
backend·3   被 raft、storage 结束与 job_1 结束唤醒：看到汇合结果与测试失败输出 → 修复 → finish_subagent
main·3      被 children all 唤醒：汇合结果（backend、frontend 按书写顺序）→ reply
```

用户觉得前端方向不对时，`/undo` 回到这条消息之前重写需求；如果这是一个声明了 `onRootSpawn` 的模板，
还可以 `/rewind` 到"派生 backend、frontend 之前"那个 checkpoint，附一句说明后让 main 重新分工。

### 10.1 任务导向的长任务：内置模板 `mission`

编排的主要用法不是预先画好的固定流程，而是像一家外包公司：接到一个目标（"按这些要求写一篇论文""做出一个完整的项目"），
负责人自己理解需求、拆分、找人、并行推进、验收、交付，过程中不需要用户一轮一轮地对话。

为此内置一个最小的模板 `mission`，`mas run "<目标>"` 不指定模板时就用它：

```yaml
id: mission
version: v1.0.0
owner: { agent: main }
checkpoints: { onHuman: true, onRootSpawn: true }
nodes:
  - { name: deliver, kind: AGENT, role: owner, output: true, goal: "完成用户给出的目标并交付" }
```

图上只有一个 owner 步骤，全部结构都在运行时由根任务长出来：派生组长与工人（至多三层）、休眠等待、
沿树传消息、后台跑构建与测试、在必要时 `ask_user`。根任务以 `complete_step` 交付时运行收敛，交付物就是运行结果。
因为它是一个普通模板，checkpoint、回溯、续跑、额度与活动时限（缺省 4 小时）都和其他编排一样。

固定流程的模板（`research`、`paper`、`task`）仍然可以写，适合确实需要固定人类审阅点的场景；它们与 `mission` 用同一套机制。
"像外包公司"体现在 Agent 与提示词上，而不是图上：

| 角色 | 由谁担任 | 职责 |
|---|---|---|
| 负责人 | `main`（`mission` 的 owner） | 澄清目标（必要时 `ask_user`）、写出总体方案与验收标准、按方案分组派生、协调、验收、交付 |
| 组长 | `lead` | 负责一个子系统或一个章节：细化方案、派生工人、在组内验收、把结果交回负责人 |
| 工人 | `worker` | 在自己的写入范围内实现、写作、运行验证 |
| 调研 | `explorer` | 只读调研：仓库、网页、资料 |

负责人的提示词给出通用的工作方法（先方案后分工、按写入范围不相交切分、接口约定写进文件并用消息通知、
每组交回结果时附验证证据、最后统一验收），而不是某一类任务的固定步骤。
写论文与做项目的差别只在目标与验收标准里，由负责人自己决定怎样分工。

## 11. 不变量与冻结测试

新增或改写的不变量（编号在 M2Design 新版本中统一）：

| # | 不变量 | 测试 |
|---|---|---|
| M1 | 同一个任务同一时刻至多一个活动的 AgentRun | 单元测试（Kernel 的 `MISSION_BUSY`）+ 属性测试 |
| M2 | 每个 TaskGraph 恰有一个根任务；每个非根任务的父任务由图唯一确定；深度 ≤ `maxMissionDepth` | 图的属性测试 |
| M3 | 任务只在最后一段以结束工具成功收尾或失败时结束；有未结束子任务的任务不能成功收尾 | Workflow 单元测试 |
| M4 | 子任务的能力上限、写入范围不超过父任务；OPEN 的任务（含休眠）写入占用两两不相交 | Kernel 单元测试 + 被攻陷假模型的对抗用例 |
| M5 | 消息只沿树传递，不带任何权限；消息内容以不可信材料进入上下文 | 对抗用例：被注入的子任务给兄弟发"去删除 X" |
| M6 | 运行停滞时根任务一定被唤醒；没有人类输入时每个任务的连续唤醒不超过上限 | 属性测试 |
| J1 | 后台命令与前台命令的授权、沙盒、可写路径完全相同；任务结束、中止、收敛、进程退出后没有幸存进程 | 冻结的系统测试（Ubuntu） |
| C1 | 屏障期间没有 WRITE 与前台 EXEC 被派发；`CHECKPOINT_TAKEN` 之前的记录包含快照中全部的文件改动（后台命令除外，且被记录） | Kernel 单元测试 + 故障注入 |
| C2 | 回溯只还原切面之后改动过的文件；外部修改不经确认不被覆盖 | 沿用 `/undo` 的用例，扩展到非 HUMAN 切面 |
| C3 | 回溯或续跑后的投影，等于把切面之后的记录与触发记录替换为说明之后的投影 | 属性测试 |
| C4 | Turn-chat 与其他编排使用同一个 checkpoint 实现；Turn-chat 的 `/undo` 行为与 v1.35 相同 | 回归：现有 `/undo` 用例全部保留 |

M2FrozenTests 的清点、被攻陷假模型的用例要相应补齐：被注入的任务试图经消息、后台命令、休眠唤醒越权，系统都必须拦住。

## 12. 实施

按 M2ReleasePlan 第 4.1 节的四道工序：

1. **文档门**：本文评审 → M2Design 新版本（第 13 节）→ `Interface/WorkflowKernel`、`Interface/Persistence`、Kernel/Core、
   Module/Workflow、Library/AgentToolPool、ExecutorSet 的对应章节。
2. **契约门**（一个 PR）：日志记录与图的 Schema（`mission`、`CONTINUES`、`YIELDED`、新记录）、Kernel 请求与事件、
   `packages/testing` 中的 fake（假 Kernel 的 MissionScope、屏障、定时；假 Supervisor 的后台进程）。
3. **并行实现**（各自只改自己的目录）：

| 工作流 | 任务 |
|---|---|
| WF | 图的纯函数（MissionTree、最后一段的边、唤醒集合、停滞）；休眠与唤醒；消息；`run_subagents` 不阻塞；模板 owner 编译；Turn-chat 改为普通模板 |
| KC | MissionScope、按任务的写入占用与额度、定时、checkpoint 屏障、静止与活动时限；删除 Turn |
| KX | 后台命令的执行、前台转后台、`job-output`、`job-kill`；checkpoint 索引、回溯、续跑 |
| PA、TPL | `lead` 定义；各角色的结束工具与提示词；`research`、`task` 模板改写为 owner 形式 |
| UI | MissionTree 的活动区、`/checkpoints`、`/rewind`、续跑询问、后台命令的显示 |
| SC | 第 11 节的对抗用例 |

4. **集成与退出**：Turn-chat 的全部验收回归（包括 phase 1 的基线 2 不得劣化）；P4、P5、G、O 组；
   新的编排任务集（并行写入冲突、被注入后的破坏范围、成本可预期、可复现、人的控制，见下文）。

**评测**：phase 2 的基线 2 以 dsh 的子 Agent、Agent 团队与 workflow 工具为对照，除成功率、token、耗时之外，
记录并行写入的冲突与覆盖、被注入后能做到什么、额度超支与方差、回溯是否成立。这些是本架构相对 dsh 的差别所在。

## 13. 对现有设计的改变

评审通过后，M2Design 发布新版本吸收以下改变：

| M2Design 位置 | 改变 |
|---|---|
| 1.3 非目标 | 删除"嵌套派生""Agent 之间的直接消息传递""按节点回退""跨进程续跑"（后者改为"从 checkpoint 续跑，Kernel 状态仍不跨进程"）；"无人值守"保留，但写明后台命令、消息、定时触发的有上限唤醒不属于无人值守 |
| 1.4、2.1 概念层次 | Turn 删除；增加 MissionTree、MissionScope、Checkpoint |
| 2.2 两种模式 | Turn-chat 是一个普通模板（owner = main） |
| 2.3 生命周期 | Turn 的开启与结束删除；静止的定义去掉后台命令；活动时限取代 Turn 超时；重开时的续跑 |
| 3.1 节点与边 | `WAITING`、`RESUME` 删除；`YIELDED`、`CONTINUES`、节点的 `mission`、`MISSION_ENDED` 增加 |
| 3.3 推进规则 | 唤醒与停滞（第 9.2 节） |
| 3.5、3.6 控制工具与派生 | 休眠、消息、角色决定的结束工具、`run_subagents` 不阻塞、嵌套派生 |
| 3.8 模板 | `owner`、`role: owner`、`checkpoints`、节点的 `checkpoint: true`；`chat` 不再写在代码里 |
| 4.6 回退与差异 | 按 checkpoint；暂停时可以回溯；`/checkpoints`、`/rewind` |
| 5、6 授权与沙盒 | 写入占用按任务；父任务派生后的只读挂载 |
| 7.1、7.3、7.4 执行、额度、时间 | 后台命令的执行类别；账本的层次；活动时限 |
| 8.1 工具清单 | `run_command` 的 `runInBackground`、`promoteOnTimeout`；`job_output`、`job_list`、`job_kill` |
| 9.1、9.6 投影与压缩 | 以任务为对象；谱系 |
| 12 不变量 | 第 11 节；涉及 Turn 的不变量按 checkpoint 与开放输入改写 |

M2Decisions 中需要改写的决定：第 1 节"结束方式由定义声明的结束工具决定"改为按角色决定（D16）；
第 2 节"用户拒绝绑定 AgentRun"保留，含义改为"绑定这一段"；第 4 节的路线不变。

## 14. 待决定

| # | 问题 | 建议 |
|---|---|---|
| 1 | `job_output` 的增量读取位置跨段是否保留（上一段读到哪里，下一段接着读） | 保留：位置属于任务，记在日志里 |
| 2 | 模板子任务（非派生）能否再派生 | 能，按同样的深度规则；模板中的 `lead` 节点就是这种用法 |
| 3 | 等局部询问的任务被消息积累的通知，在答复唤醒时是否一起给出 | 一起给出，按日志顺序排在答复之后 |
| 4 | `maxConsecutiveWakes`、`maxMessagesPerSegment`、`maxBackgroundJobs` 的缺省值 | 先用本文的值，phase 2 评测后校准 |
| 5 | 父任务在子任务运行时能否写入自己范围内、子任务范围之外的文件 | 现在不能（第 8.2 节）；按评测看是否值得放宽 |
| 7 | 停止与中断是否要立即取消在途的工作（D20 写的是按暂停的规则停下） | 现在在这一轮结束时生效，安全、不需要改 Kernel；代价是最多等一次模型调用或一条命令。要立即生效，需要 Kernel 增加"只中断一个 AgentRun"（按 AgentRun 取消队列与在途执行） |
| 7a | **（已解决，见第 15 节）评测证据（2026-11-12）**：`subagents.stop` 的第 3 次运行中，被停止的 worker 正以 `timeoutMs: 600000` 在前台运行一个 5 分钟的脚本；main 第 9 秒就拿到答案并停止它，却因"子任务没结束不能交付"等了 5 分钟以上（步骤超时）。停止必须能取消在途的命令与模型调用 | 实现 Kernel 单独中断一个 AgentRun（按 AgentRun 取消队列与在途执行），优先级提前 |
| 8 | Turn-chat 中 main 已 `reply`、等用户输入时，后台命令结束是否自动唤醒 main 告诉用户（Claude Code 的做法） | 现在不唤醒，通知等用户下一条消息时一起给出；要自动唤醒，需要允许没有用户输入的一段对话，界面上要显示"后台命令结束，main 继续" |
| 6 | 模板根任务的步骤是否要单独的结束工具 `complete_step`（D16 按角色决定结束工具） | 目前用 `reply`：在长任务里每一步的回复同时是给用户看的进展，效果与 `complete_step` 相同；是否改名在评审时定 |

## 15. 实现进度

| 部分 | 状态 | 说明 |
|---|---|---|
| MissionTree 的图模型（第 3 节） | 已实现 | 节点带 `mission`；`YIELDED`、`CONTINUES`、`MISSION_ENDED`；`projectMissions` 等纯函数；属性测试 |
| Kernel 的 MissionScope（第 8.1–8.3 节） | 已实现 | 登记、`MISSION_BUSY`、`MISSION_CLOSED`、按任务的写入占用与账本、按深度收窄派生 |
| 派生不阻塞、休眠与唤醒、消息、停滞检测（第 4、5、9.3 节） | 已实现 | 唤醒条件 `children`、`message`；连续唤醒上限；结果按书写顺序交付；任务的投影跨段 |
| 嵌套派生与 `lead`（第 3.6、9.4 节） | 已实现 | 缺省三层 |
| 定时唤醒与 `timeoutSeconds`（第 4.2、8.5 节） | 已实现 | `scheduleWake` 与 `WakeDue`，日志记录 `MISSION_TIMER_DUE`；任务自己设的定时未到时不算停滞，缺省超时不阻止停滞检测 |
| 写权限包与按路径借出（第 8.2 节，D17） | 已实现 | 只拒绝写已借出的路径；父任务的命令把借出的路径挂为只读；`commands: false` 的任务没有命令工具与命令能力 |
| 分工与可见性（第 3.7 节，D18） | 已实现 | `role`（缺省取目标第一行）；第一段的树快照在任务说明之后；兄弟开始与结束的通知；`view_tasks` |
| 停止子任务（第 5.1 节，D19） | 已实现 | 休眠与未开始的立即停止；**在运行的在这一轮结束时停止**（在途的读取、模型调用、写入与命令跑完，不取消；要取消在途工作需要 Kernel 能单独中断一个 AgentRun，第 14 节第 7 条） |
| 送达两类（第 5.2 节，D20、D21） | 已实现 | 非中断：消息一律唤醒休眠的任务（受上限约束）；中断只能发给自己的子任务：休眠的立即唤醒，运行的**在这一轮结束时**以 `YIELDED` 结束并接上新的一段，信息在末尾以"⚠ INTERRUPT"标出；正在等 `ask_user` 答复的任务要等答复回来、这一轮结束才被中断 |
| 计划书（第 5.3 节，D24） | 已实现（2026-11-12） | `run_subagents` 的 `plan`：编排模式下根任务第一次派生必须带上，否则答复 `PLAN_REQUIRED`（不计为错误的派生）；记为 `PLAN_REGISTERED`，文本留在根任务的模型输出里，每个非根任务的第一段在任务说明之后看到它（`PLAN` 条目），之后的新计划作为通知送达。Turn-chat 中可选。"作为文件自己读"的对照实验待做 |
| 通信工具升级（第 5.3 节，D25） | 已实现（2026-11-12） | `send_message` 的 `kind`（`inform`/`request`/`reply`）、`summary`、`references`（自己的工具调用作为附件，只能发给一个任务，接收方用 `read_output` 读）、`replyTo`（答复送回请求方）；每个任务同时未答复的请求至多 3 个；被请求的任务结束时仍未答复，记 `MESSAGE_UNANSWERED`，通知并唤醒请求方。端到端用例：索要与答复、未答复的兜底、附件被接收方读到 |
| 可见范围裁剪（第 5.3 节，D26） | 已实现（2026-11-12） | 任务树快照与 `view_tasks` 只显示父任务、兄弟、直接子任务；`send_message` 的对象本来就限于这三类。单元测试覆盖三层树中各层看到的范围 | 现状：`send_message` 只有文字与中断，没有摘要、附件与索要；任务树快照显示祖先到根 |
| 有任务休眠时运行不收敛 | 已修正（2026-11-12） | 真实评测发现：子任务用定时器休眠、其余子任务都结束时，运行在没有可启动节点、没有活动 AgentRun 时直接按完成收敛，root 没有被唤醒、没有交付。现在还有任务休眠时不收敛，等它的定时器、作业或消息；真的再无动静时由停滞处理唤醒或结束 |
| mission 的模板步骤放弃时 `mas run` 的退出码 | 已修正（2026-11-12） | main 无法再调用模型而降级时，运行记为失败（退出码 1），因额度结束的仍为 `BUDGET` |
| 逐个唤醒、`siblings` 条件、失败必唤醒（D28） | 已实现（2026-11-12） | 端到端用例：逐个唤醒、等兄弟、定时器的提示、失败唤醒等全部的父任务 |
| 停止与中断立即取消在途工作 | 已实现（2026-11-12） | 系统调用 `haltAgentRun`：Kernel 取消该 AgentRun 排队与在途的命令和模型调用（正在进行的写入照常完成，避免写出半个文件），各自答复 INTERRUPTED(ABORTED)；Workflow 在被取消的工作都答复后立即停止或接上新的一段。端到端用例：停止、中断一个正在运行 60 秒命令的任务，约 2 秒生效 |
| `ask_user` 改为休眠 | 未实现 | 仍是挂起在调用上等答复（原有的 `DELEGATE`、`RESUME`） |
| 后台命令（第 6 节） | 已实现 | `run_command` 的 `runInBackground`；前台超时转后台（`promoteOnTimeout` 缺省开）；`job_output`、`job_list`、`job_kill`；结束通知按下一次组装送达；`sleep` 的 `jobs` 条件唤醒，受连续唤醒上限约束；任务结束、运行收敛时停止；每个运行至多 4 个；最长 1 小时。实现方式与差别见第 6.5 节 |
| 模型可见的任务工具 | 已修正 | 之前 `sleep`、`send_message`、`view_tasks`、`stop_subagents` 没有进入给模型的工具列表（脚本化测试不看工具列表，没有暴露）；现在与作业工具一起列出，并有用例断言 |
| checkpoint 取代 Turn（第 7 节） | 未实现 | |
| 模板 owner 与 `mission` 模板（第 3.5、10.1 节） | 已实现 | `owner`、`role: owner`、`OWNER_NOT_LINEAR`；`mas run "<目标>"` 缺省用 `mission`；模板步骤的 `goal` 作为它的任务给出，同时保留用户的目标；Orchestration 的活动时限缺省 4 小时。与第 4.1 节的差别：模板根任务的步骤目前也以 `reply` 收尾（输出步骤的回复就是运行结果），`complete_step` 还没有作为单独的工具（第 14 节第 6 条） |
| 唤醒根任务处理后台命令结果（第 4.4 节） | 未实现 | Turn-chat 中根任务 `reply` 之后结束的后台命令，通知积累到用户的下一条消息；不会自己开始新的一段（第 14 节第 8 条） |
