# MultiAgentOS M1 Kernel.Core

## 1. 定位

Core 负责授权、租约与控制裁决，是内外部 syscall 的处理者。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §5、§6。

## 2. 职责

- 实现并维护统一控制响应逻辑，处理 Syscall（含内部与外部 syscall）、Interruption（中断信号）
  和 Exception（AgentOS 异常，可来自包括 Kernel 在内的整个系统）。
- 创建运行时为该运行建立运行 actor；该运行的消息由运行 actor 按控制通道优先的顺序逐条处理
  （见 [Interaction](Interaction.md) 3.2）。
- 通过各组件职责接口落实处理，不递归提交同一控制请求，也不接管其权威状态。
- 维护 AgentRun 登记（AgentRun 身份、所属运行、固定的 Agent 定义引用及状态），不持有 AgentRun 实例。
- 明确授权依据及能力上限：本地用户或系统配置提供授权依据，固定定义限定能力上限；
  模型输出、工具注册和能力声明本身不产生授权。
- 是否需要 Lease，以 Unit 定义中声明的受保护能力为准；M1 的受保护能力为 `repo.read`。
- 将 Lease 作为 Core 私有运行时数据，维护其签发、检查、复用、失效与撤销；对外只返回裁决与派生的范围约束。
- 保留用户的授权决定：属于已同意范围的安全子集直接签发 Lease，危险行为每次询问（M1 不涉及危险行为）。
- 代为调用 Scheduler 分配调用机会、调用 Monitor 预留与结算额度。
- 处理结果检查，并作为唯一出口经 Outbox 交付全部 UnitReport（第 5 节）。
- 维护运行控制状态及其版本（runEpoch），设置准入封锁，组织收敛。
- 运行总时长计时：创建运行时开始，收敛时停止；到点后按 Exception 停止运行（`RUN_TIMEOUT`）。
- 决定取消并通知 Supervisor（`cancel`、`cancelRun`）；依据 runEpoch 决定是否接受 Supervisor 上报的执行事实。
- Lease、用户授权记录与运行控制状态是 Core 的私有数据，Execution、Monitor、Scheduler 只能取得裁决与派生值
  （见 [Interaction](Interaction.md) 3.3）。
- 维护 Outbox，向 Workflow 与 UserInteraction 的 Inbox 投递 RunStart、UnitReport、RunClosed、
  AuthorizationRequest 与 RunFinished（投递语义见 [Kernel（外部视角）](../module/Kernel.md) 4.5）。
- 写入运行记录的执行部分与审计记录（见 [Persistence](../infrastructure/Persistence.md)）。

M1 支持只读分析所需的基础人工授权，由 UserInteraction 收集响应，Core 判断适用性并决定
是否签发 Lease；拒绝或超时不默认放行。不引入任意能力扩权、复杂审批、委派与再委派或长期跨运行租约。

## 3. AgentRun 登记

收到 `registerAgentRun` 后，Core 读取定义并核对 digest，登记为 ACTIVE 后返回 SyscallAck。
`endAgentRun` 将对应 AgentRun 标记为 ENDED；收敛时全部 AgentRun 标记为 ENDED。

定义核验检查：AgentRun 已登记且为 ACTIVE、属于该运行；Unit 属于该 Agent 定义闭包。

## 4. Lease 与用户授权

| 术语 | 定义 |
|---|---|
| Lease | Core 私有的运行时授权记录，只存在于 Core |
| 用户授权记录 | Core 保留的用户同意或拒绝结果 |
| 范围约束 | Core 依据 Lease 派生、经 Supervisor 注入 Executor 的参数（如仓库根目录），不是 Lease 本身 |

- `repo.read` 的范围：仓库根目录（realpath）、排除规则（默认 `.env*`、`*.pem`、`*.key`、`id_*`、`.git/` 等，只能由本地配置追加）、外发目标 provider。
- Lease = Agent 定义能力 ∩ 用户授权 ∩ 系统策略；绑定 WorkflowRun，运行结束时失效。
- Core 保留用户授权记录。属于已同意范围的安全子集直接签发 Lease，不再询问；危险行为每次询问（M1 不涉及）。
- 询问时机、内容与回答规则见 [Kernel（外部视角）](../module/Kernel.md) 第 7 节。

```text
受保护 Unit 到达 Core
  ├─ 定义不含该能力或策略禁止 → UnitReport REJECTED(FORBIDDEN)
  ├─ 本运行已拒绝 → UnitReport REJECTED(USER_DECLINED)
  ├─ 已授权且属于其子集 → 签发或复用 Lease → 放行，下发范围约束
  └─ 尚无授权 → 经 UserInteraction 询问
        ├─ 同意 → 保留授权记录，签发 Lease，放行
        └─ 拒绝或超时 → 保留拒绝记录 → UnitReport REJECTED(USER_DECLINED)
```

Lease 检查未通过不等于可以申请授权；明确禁止或超出能力范围的请求直接拒绝。

## 5. 结果检查

```text
① 结果归属于本运行、对应当前 UnitAttempt、Lease 未失效
② model-call：调用 Monitor 结算并取得额度状态（见 Monitor）；结算不阻止本次结果交付
③ Executor 违规 → 停止运行（VIOLATION），以终止信号结束本次调用
④ 形成判定 {status, reasonCode, budgetState}
⑤ 核对该 UnitAttempt 建立时的 runEpoch 与当前 runEpoch：一致 → 将 UnitReport 放入 Outbox；
   不一致 → 不交付，结果只作为证据保存
```

执行前被拒（定义核验、权限、额度预留）的 Unit 同样由 Core 形成 UnitReport 并放入 Outbox。
⑤ 的核对与入队在 Core 内同步完成，期间不会插入控制状态变化，因此不存在“核对后、交付前运行已停止”的竞态。

Core 检查结果的执行归属与可接受性，Workflow 判断业务结果是否成功；实际执行完成、Core
接受结果和业务验收必须分别表达。执行失败或结果被拒绝均不能免除已发生的消耗。

## 6. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| 询问超时 | Core 配置 | Core | 300 秒 |
| 运行总时长上限 | 系统配置 | Core | 30 分钟 |
