# MultiAgentOS M1 异常处理与安全停机

## 1. 目的与范围

本文是 M1 异常分类、捕获边界、panic、关闭期限与退出码的权威来源。
2026-10-17 修订采用非停机异常、停机异常两类；这是目标设计，不表示现有代码已完成迁移。
运行收敛见 [Interaction](Kernel/Interaction.md) 第 6、7 节，执行中止见
[Supervisor](Kernel/Supervisor.md)，生命周期见 [ModuleHost](Infrastructure/ModuleHost.md)，
字段见 [M1Interface](M1Interface.md) 第 10、14 节。

本次仅修订 M1 与 Kernel 相关文档，不修改长期架构及 Workflow、UserInteraction 等其他模块文档。
跨模块依赖仍通过既有接口连接；其他模块的历史分级描述后续由负责人协调同步。
既有接口名 SystemFault、SystemFaultReporter、reportSystemFault、reportFault 保留，
统一表示请求同一个 panic 流程，不代表保留旧的四级分类。

M1 是单进程、单活动运行。只有 rg 是子进程，Executor 与各模块在同一 Node 进程内。
事件循环卡死或进程崩溃时，进程内机制不提供保证；M1 不恢复未完成运行。
没有完成的清理、结算或结果交付不得报告为成功，无法确认的效果按未知记录。

## 2. 两类异常与处理语义

| 分类 | 定义 | 例子 | 处理 |
| --- | --- | --- | --- |
| 非停机异常 | 可在系统继续工作的前提下处理；允许拒绝操作、结束尝试或结束当前任务 | 权限拒绝、预算不足、执行失败、授权超时、运行超时、受控安全违规、停止未确认 | 边界规范化后由 Core 处理运行语义 |
| 停机异常 | 无法继续保证系统正确运行，必须安全停机 | 启动失败、基础设施不可用、收尾机制失败、Supervisor 失效、未捕获异常 | 组合根唯一 panic 入口，Supervisor 执行停止动作 |

非停机不等于任务一定继续。M1 单任务结束后可正常关闭进程，这不等于 panic。
两类按处理后果区分，不仅凭捕获位置决定。边界必须有确定的处理规则，不运行时猜测组件是否健康。

非停机分类覆盖预期拒绝与运行异常；授权拒绝、额度不足等仍用结构化结果表达，不改成 JavaScript throw。
契约内分支使用 SyscallRejected、UnitReport、ExecutionFact 或内部返回值。
程序缺陷可以抛错，但必须在指定边界捕获，不把原始 Error 当作跨主体协议。

### 2.1 Core 非停机异常入口

Core 维护与 syscall 并列的私有异常语义处理逻辑，见 [Core](Kernel/Core.md) 第 9 节。
它验证运行、尝试、execution 与来源，依据当前状态决定拒绝、记录、重试许可或任务收敛。
现有 syscall 返回值、ExecutionFact、计时消息及 KERNEL_FAULT 保留，不新增公共异常总线。

非停机处理自身失效或已知关键不变量无法维持时请求 panic。
不得无限重复投递 KERNEL_FAULT；收尾中再次抛错直接请求 panic。
普通技术重试仍按 Execution 的规则执行，不能把异常处理重试与执行重试混为一谈。

### 2.2 捕获与规范化边界

| 边界或事件 | 处理规则 |
| --- | --- |
| CLI 参数错误 | 返回参数错误，不启动系统，不触发 panic |
| 配置、Catalog、工厂构造失败 | 组合根记录并进入 panic；未构造的组件不参与清理 |
| 非法传输请求、Gateway 准入拒绝 | 保持传输契约错误或结构化拒绝；不为无运行请求创建 Core 异常 |
| Executor 抛错、超时、rg 失败 | Supervisor 形成唯一执行事实，由 Core 判断运行语义 |
| actor 普通消息处理抛错 | 可归属运行且收尾机制仍可使用时投递 KERNEL_FAULT；已知状态不可信则请求 panic |
| Inbox、OrderedSender、定时器失败 | 按是否有有效运行处理通道与明确的受控处理规则路由；通道失效时请求 panic |
| 收尾处理自身抛错 | 请求 panic，不再次投递 KERNEL_FAULT |
| 模块启停失败或超时 | ModuleHost 记录并回滚或继续清理；组合根进入或继续 panic |
| 未捕获异常、未处理 Promise 拒绝 | 停机异常，执行第 6 节最小退出路径 |

catch 只放在上述边界或契约规定的错误转换处，不吞掉异常。
Inbox.request 的拒绝必须显式接住，不能只依赖处理 enqueue 的失败观察者。
Gateway 的拒绝记录在 Gateway；Core 的拒绝与结算异常记录在运行审计。

其他模块仍使用既有边界：Workflow 内部失败先 closeRun(FAILED, WORKFLOW_INTERNAL)，
无法完成则经 reportSystemFault 请求 panic；UserInteraction 自身失效经同一入口上报。
这些是本次的跨模块接入约束，未修改其他模块文件，也不表示对应实现已经验收。
health 只是快照；静默失败通过执行、授权、运行、收尾和系统启停期限发现。

## 3. 职责与 panic 所有权

| 主体 | 职责 | 边界 |
| --- | --- | --- |
| Core | syscall、非停机异常语义、任务状态、授权、结算、收敛 | 不决定进程退出码，不持有全系统停机权 |
| Supervisor | 执行监管、取消、子进程管理；正常引导及 panic 中的模块停止 | 不改写任务结果，不接管未捕获进程异常 |
| ModuleHost | 依赖顺序、启停期限、生命周期账本与回滚 | 不决定异常类别或是否停机 |
| 组合根 | 唯一 panic 入口、错误汇总、用户诊断、停机期限、退出码与最后防线 | 不改写 Lease、预算或任务结果 |

组合根不是模块，不注册 ModuleHost、Fabric 或 Inbox。
它只调用已登记的控制对象；Supervisor 自身失效时仍可独立报告、调用 ModuleHost 并清理子进程。
panic 由组合根与 Supervisor 协作，但只有一份停机状态、一个 faultId 和一次关闭操作。
SystemFaultReporter 是进程内、立即返回且不抛错的适配入口；停机任务的拒绝必须被内部观察。
Executor 不持有 panic 或 SystemFaultReporter，其结局由 Supervisor 转换为执行事实。

## 4. 启动与生命周期契约

组合根在配置加载、Catalog 加载和模块构造前建立最小诊断、进程保护与有效的 panic 控制对象。
不得先注入空的错误上报函数再等装配结束绑定。组件逐个登记；没有 run 时跳过任务收敛。
工厂原则上只构造对象；取得资源就登记释放动作，装配失败只清理已取得的资源。

模块顺序保持 fabric → artifact-store → persistence → kernel-core → gateway → workflow → user-interaction，
由 Supervisor 驱动 ModuleHost。所有 start 完成且系统未进入 panic 才开放业务。
start 期间不创建 run 或提交 Unit，迟到完成不得重新开放系统。

每个模块启动及 afterStart、系统引导总过程都必须有期限，具体契约见 ModuleHost。
超时不等于底层 Promise 被取消：封锁继续启动，记录迟到完成或拒绝，
模块必须在停止之后释放迟到取得的资源；panic 不无限等待该 Promise。
stop 在启动前、部分启动后、启动与停止交错时均须安全且幂等。
启动失败模块同样需要清理；一次停止失败记为 STOP_FAILED，继续其余清理，不重试失败步骤。

## 5. 正常关闭与 panic

正常关闭保持：
UserInteraction → shutdown → Gateway → Core 收敛及 Outbox 排空 →
SupervisorPort.shutdown → Supervisor 驱动 ModuleHost 逆序停止 → 清理残留资源。

panic 的业务顺序是“中止任务 → 收集错误 → 上报用户 → 安全停机”。
实现必须先保存并输出原始错误，以免中止失败掩盖起因；停机中的错误持续追加和补报。

1. 组合根登记原始错误、唯一 faultId，写 stderr，封锁启动和命令入口。
2. 已就绪且可能有运行时，有期限地调用 kernelCore.abortAllRuns。
   Core 封锁新运行，向未 CLOSED 的 actor 投递 KERNEL_FAULT，
   RUNNING 按 FAILED(KERNEL_INTERNAL) 收敛，failure.detail 与审计关联 faultId。
   等运行 CLOSED 且 Outbox 排空；无法完成或到期只记录，不阻止后续步骤。
3. 汇总当前错误并上报用户。stderr 是不依赖 UI、Fabric、存储的基本通道；
   UI 可用时可正常展示收尾事件，但不能以其应答作为继续清理的条件。
4. 有期限地调用 supervisor.stop；失败或超时，直接调用 moduleHost.stop 兜底。
   Supervisor 停止接收执行，对仍存活的执行发出中止，驱动模块停止并清理子进程及临时资源。
   它不得把未确认停止伪造为完成，也不得在 Core 已关闭后修改已发布结果。
5. 组合根直接清理残留子进程，汇总 StopReport，补报清理错误并非零退出。
   系统不能仅因异步清理返回就假定失控执行已消失；必要时由入口结束进程。

每步有期限；失败只追加到同一次 panic 并继续，不递归启动另一轮 panic。
在 panic 中收到重复故障共用 faultId；不遗漏来自不同步骤的失败证据。
abortAllRuns 只交给组合根，不经 Gateway 或 Fabric，不停止模块，也不调用 Supervisor.shutdown。
已收敛运行不因 panic 改写结束原因；收敛中确认 VIOLATION 的优先规则仍有效。
引导未完成时没有运行，跳过任务中止，清理已登记且取得资源的对象。
若 stderr 诊断自身失败，仍继续清理与非零退出，不允许诊断失败阻断停机。

RunSummary 发布失败是已有的受控分支：finalizationError，不伪造引用、不改原原因。
已预期的终态事件发送失败按收尾规则记录；若通用存储或通信失效使受控处理无法完成，则进入 panic。
任务收敛和 panic 不承诺在基础设施失效时一定交付 RunFinished。

| 情况 | 退出码 |
| --- | --- |
| CLI 参数错误 | 64 |
| 正常关闭 | UserInteraction 的既有退出码 |
| panic，命令已返回非零码 | 保留该非零码 |
| panic，命令返回 0、抛错或未返回 | 70 |
| 配置、装配或引导失败 | 70 |
| 未捕获异常、未处理 Promise 拒绝 | 70，最小退出 |
| 第二次 Ctrl+C | 130，最小退出 |

出现停机异常不得以 0 退出。70 只由组合根产生；正常任务失败不自动等于 panic。

## 6. 中断与最小退出

进程入口与信号归组合根；CLI 仅负责参数和终端适配。
首次 Ctrl+C 经 TerminalPort.onInterrupt 请求 cancelRun，任务按 CANCELLED 收敛，退出码 130。
尚无运行时首次中断无可取消对象；第二次立即写诊断、同步清理子进程并退出 130。
组合根保护从装配前生效，终端适配器不得自行退出进程。

uncaughtException、unhandledRejection 意味着进程状态不可信：
记录诊断、尽可能同步清理已登记子进程、以 70 退出，不调用 Core，不等待异步停机。
这是停机异常的最小执行路径，不是第三类异常。
诊断或清理同步抛错也不得阻止最终退出；不得承诺事件循环卡死时处理器还能运行。

子进程创建时登记在 SubprocessRunner；组合根直接持有 runner 并注入 Supervisor。
Supervisor.stop、panic 末尾、exit 钩子与最小退出均可幂等调用 killAll。
进程内 Executor 无法被强制单独终止；宽限期后记 STOP_UNCONFIRMED，由进程退出最终结束。

## 7. 事件、处理与验收映射

| 事件 | 处理主体与动作 | 结果 | 开发阶段 |
| --- | --- | --- | --- |
| 授权超时、预算拒绝 | Core 返回结构化拒绝 | 运行可继续 | 一、二 |
| 执行失败或 Unit 超时 | Supervisor 规范化，Execution 申请重试，Core 裁决 | UnitReport 或受控重试 | 一至四 |
| 运行超时、受控违规、停止未确认 | Core 三步收敛，结算并记录未知效果 | 任务结束，正常关闭 | 一至四 |
| actor 普通处理缺陷 | Core 接收 KERNEL_FAULT | 任务收敛；机制失败则 panic | 一、四 |
| 收尾失败或运行消息通道失效 | 组合根 panic | 有期限停机，可能无终态事件 | 四至六 |
| 模块启动、停止失败或超时 | ModuleHost 记账，组合根 panic | 回滚或继续清理，非零退出 | 三、五、六 |
| 第一次、第二次 Ctrl+C | UI 请求取消；组合根最小退出 | 130 | 四、六，UI 接入为外部依赖 |
| 未捕获异常 | 组合根最小退出 | 70 | 六 |

## 8. 验证要求

- Core：拒绝不误停机；任务异常可收敛；异常处理失败进入同一次 panic。
- 并发边界：取消与完成交错、重复取消、迟到事实、取消后收费、旧 epoch 仍结算、
  STOP_UNCONFIRMED 保留容量至最终清理、收尾中违规升级。
- Supervisor：抛错规范化、deadline、宽限期、忽略取消、唯一终态和子进程清理。
- 启动：配置与工厂失败时可诊断、装配期间上报不丢失、ready 前无业务、启动超时、
  afterStart 超时、停止中迟到启动不得重新 ready，迟到资源清理。
- panic：重复调用共用 faultId、Core 超时后继续、Supervisor 失败走 ModuleHost、
  模块停止失败后继续、UI/Fabric/存储不可用仍诊断退出、诊断失败仍退出。
- 入口：首次/二次 Ctrl+C、未捕获异常、未处理拒绝、退出码与最小清理；
  使用子进程测试真实退出，不能在测试主进程触发 exit。

故障注入使用真实 Kernel、Fabric、ModuleHost、存储与组合根。
fake 仅证明局部顺序与期限，不证明任务收敛。
其他模块尚未交付的行为明确记为外部依赖，不以 fake 通过宣称全系统验收。

## 9. M1 不实现

崩溃恢复、暂停恢复、独立进程外监督、失败停止的无限重试及公开的系统级状态机协议。
SIGTERM 等其他信号按 Node 默认行为结束，不保证收敛。
事件循环卡死或崩溃由用户或启动它的 shell 处理。
