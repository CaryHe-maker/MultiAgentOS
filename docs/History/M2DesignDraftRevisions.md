# M2Design 相对初稿的修改

> 本文记录 [M2Design](../M2/M2Design.md) 在评审中相对作者初稿所做的修改及理由，只作为历史记录，不是设计依据。
> 设计以 M2Design 为准。

## 相对 M2Design 草稿的修改

| 草稿中的写法 | 本文 | 理由 |
|---|---|---|
| Turn-chat 把对话与询问作为必要的 Unit | HUMAN 节点；所有用户输入（包括第一条提示词与暂停后附加的说明）都记为 HUMAN 节点 | Unit 由 Kernel 执行；人类对话若是 Unit，"等待人类时没有 Unit 在跑"就不成立 |
| 人类在环中授权与对话并列 | 分为业务输入（Workflow，HUMAN 节点）与授权（Kernel 被动发起）两个层次；授权只在调用具体工具时由 Kernel 判定，没有单独申请权限的工具 | 两者改变的东西不同（做什么 / 能做什么），Owner 不同 |
| 只要 waiting 就暂停所有 Unit | 只有用户的暂停与中止是全局的；授权询问与 `ask_user` 只阻塞相关工作 | 否则每次命令询问都会取消其他 Agent 的模型调用，Agent 并行实际失效 |
| 权限审核只根据 ID 在 lease 库中检查 | 按 AgentRun ID、能力与资源键检查 | 只看 ID 时，拿到命令能力就能执行任意命令，`writeScope` 也无法检查 |
| AgentRun 的 lease 必须由人类签发 | 分为能力上限（Kernel 依据定义计算，只能收窄，越界即拒绝）与授权条目（人类签发，运行内共用，没有就询问）；Lease 是两者都满足时签发的执行许可 | 否则每次派生都要询问；把"还没问过"与"不允许"混为一谈会让 Agent 永远走不到询问 |
| 不确定级未定义；危险级"本次运行均允许" | 补全不确定级；危险级的"均允许"按命令或前缀分档 | 一个 WorkflowRun 承接整段对话，按能力整体放行过宽 |
| 不单独抽象 Turn | Turn 作为实体保存额度、超时、快照与回退；由开放输入界定，Orchestration 运行整体是一个 Turn | 回退与差异需要静止点；Orchestration 中的询问可能与其他分支并行，运行内部没有静止点 |
| 模板节点可以设置 `allowSubagents` | 模板不携带权限；派生是能力 `agent.spawn`，由 Kernel 只授予顶层 AgentRun | 权限只有一个来源；SubAgent 不能嵌套派生由 Kernel 强制 |
| Turn 由 Kernel 依据 `prompt` 的答复开启 | 保留这一做法，并把 `prompt` 定义为 Kernel 层的"开放输入"请求类别（要求静止）；Workflow 只从事件中记录 Turn | 开放输入与局部询问的区分是控制约束，不是业务含义，Kernel 据此维护 Turn 仍然不需要知道 `chat` 模板；Workflow 不必再调用 Turn 相关的 syscall |
| 危险级（命令）统一处理 | 增加极危险级：联网的命令与修改 `AGENTS.md`，每次单独询问；推送、发布等名单命令只在沙盒不可用时属于极危险级 | 与 Architecture"危险行为每次单独同意"对齐，同时让普通命令可以在本运行内放行；安全边界是网络隔离，命令名单可以被绕过 |
| Workflow 自己保存与持久化 Session 相关信息 | 明确 SessionLogStore（归 Workflow）与 ArtifactStore（归 Execution）两个存储及其边界 | 避免对正文的双重管辖 |
| 关闭 WorkflowRun 只有 Kernel 有权 | 外部触发由 Kernel 下达；图自然收敛由 Workflow 报告，由 Kernel 完成收敛 | 与 M1 的 `closeRun` 一致 |
| 按 FCFS 执行 | 在并发类别、屏障、互斥与容量约束之内按 FCFS 执行 | 与屏障设计一致 |
| 一个 WorkflowRun 承接多轮对话（未提进程退出） | WorkflowRun 不跨进程，对话的连续性由 Session 保证 | Kernel 状态不持久化，这样恢复时必然重新授权与记账 |
| pre-Orchestration | Orchestration；AGENT 与 HUMAN 两种节点；依赖边、条件边、有界循环与节点触发规则 | 命名与范围控制；`chat` 在 main 失败后继续需要 `all_done`，审阅不通过后重写需要条件与循环 |
| 第四节沙盒（空） | 第 6 节 | — |
