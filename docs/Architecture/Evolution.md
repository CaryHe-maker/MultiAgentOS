# MultiAgentOS 架构演进

## 1. 当前基线

当前架构版本为 M1 阶段，采用三个 Module、六个 Kernel 组件、
三个静态库与四类基础设施的组织形式。
该组织定义长期职责，不要求每个 MVP 同时开放全部能力。

UserInteraction 管交互，Workflow 管业务，Kernel 管权限与执行。
AgentToolPool 提供模板类，ExecutorSet 提供原子软件行为，
SharedContracts 维持公共语义。

## 2. 部署与隔离

宏内核表示控制与执行由同一 Kernel 管理，不限定只有一个进程，
也不意味着 Executor 与可信管理代码具有相同权限。

长期通讯主体为 Kernel 核心、Supervisor、Gateway、Workflow 与 UserInteraction
（见 [Fabric](Infrastructure/Fabric.md)）。Kernel 核心内的 Core、Monitor、Scheduler 与 Execution
始终同处一个进程，以内部 syscall 与函数调用协作，组件数据按模块隔离；Supervisor 独立成进程并管理
Executor 子进程；Gateway 逻辑上独立，其余通讯主体按需要独立成进程。

| 阶段 | 进程组织 | 新增的进程边界 |
|---|---|---|
| 单进程 | 全部通讯主体同处一个进程，按可序列化契约协作 | 无 |
| 隔离执行 | Supervisor 独立成进程，Executor 在其子进程或容器中运行 | Kernel 核心 ↔ Supervisor、Supervisor ↔ Executor 子进程 |
| 独立交互与业务 | UserInteraction、Workflow 独立成进程 | UserInteraction ↔ Gateway、Workflow ↔ Gateway |
| 多实例 | Kernel 核心按 Session 分片，Gateway 独立并负责路由，增加全局服务（API 容量与系统级状态） | Gateway ↔ Kernel 核心实例、Kernel 核心实例 ↔ 全局容量服务 |

拆分执行载体或通信路径时，应保持状态所有权、身份、受理、
效果核对及恢复语义，不能仅以替换调用方式代替边界设计。
多实例部署要求运行级与 Session 级状态可以持久化与恢复，分片转移才有意义。

## 3. 扩展方向

| 方向 | 保持的边界 |
|---|---|
| 调度与并行 | Scheduler 管运行安排，Workflow 管业务依赖，Execution 管执行事实；Kernel 核心按顺序处理同一运行的消息，Executor 子进程中的执行可以并行 |
| 执行能力 | 新 Executor 提供行为代码，不自行获得授权或改写 Kernel 状态 |
| 上下文能力 | 算法归 ExecutorSet，长期运行状态归 Execution，业务意图归 Workflow |
| 交互形态 | 可支持不同交互载体和多种人类参与点，权限与业务决定仍有明确 Owner |
| 资源观测 | 观测粒度可演进，结算事实不能被采样估计替代 |
| 基础设施 | 可替换承载方式，不转移领域权威或改变已承诺的恢复语义 |
| 水平扩展 | 按 Session 分片，每个 Session 只有一个 Kernel 核心实例写入；单个 Session 不跨实例拆分 |

## 4. 待实践演进的边界

内部 syscall 指 Kernel 核心其他组件向 Core 发起的请求，Core 调用其他组件称为职责接口调用，
二者在 Kernel 核心内以函数调用完成，组件之间不访问彼此的私有状态。通讯主体之间的承载方式（进程内消息、本地进程间通信或网络）
由各 MVP 的部署决定，但不改变契约与语义。

未声明受保护能力的行为以开发者授予权限为当前长期基线。
是否引入新的开发者授权机制尚未确定，不能据此允许调用者绕开受保护能力声明。

基础设施当前采用 Execution 管辖 ArtifactStore、Supervisor 管辖 ModuleHost、
Core 管辖 Fabric、ModuleHost 统一管理 Persistence 生命周期的关系。
后续调整必须同时说明决策权、数据所有权与故障责任的变化。

以下能力已有方向，尚未进入任何 MVP（已进入 M2 的方向见第 5 节）：

| 能力 | 方向 |
|---|---|
| 模型感知额度 | Kernel 在模型调用时注入剩余额度提示，Workflow 不必持有数值 |
| 按 Session 分片 | 逻辑分片固定数量，Kernel 核心实例经 Persistence 中的分片租约领取；写入携带分片 epoch；全局 API 容量由全局容量服务以令牌分配 |
| 子运行 | 超大运行拆为子运行，额度通过显式委派划给子运行 |

以下逻辑问题须在对应能力进入 MVP 前给出设计：

| 问题 | 需要明确的内容 |
|---|---|
| 分片后的系统级状态 | 跨 Session 的系统级状态（Session 引用的总表、用户按内容作出的长期信任决定、内容寻址产物正文及其回收）与租户级配额，在多实例下的全局服务与存放位置（目前只有 API 容量定义了全局服务）。单实例部署已有答案：系统级状态由 Core 的 Session 管理唯一写入，部署层以实例锁保证只有一个 Kernel 核心实例（M2）。仓库快照、产物归属等跨运行状态归入 Session 级，随 Session 分片，不再属于本问题 |
| 多实例下的基础设施管辖 | Kernel 核心有多个实例时，Fabric、ModuleHost、ArtifactStore 的管辖关系 |

## 5. M2 落地的方向与有意偏离

以下方向已由 M2 给出设计（[M2Design](../M2/M2Design.md)），从第 4 节的表中移出：

| 方向 | M2 的做法 |
|---|---|
| AgentRun 级额度、额度分配 | 额度逐级委派：运行 → Turn → AgentRun，上级预先划出份额，下级各自记账，结束时剩余返还；每份各自保留收尾额度 |
| 危险行为授权 | 能力上限与授权条目两步判定；四级能力，极危险行为每次单独同意，危险行为可以在运行内按命令或前缀放行 |
| 执行隔离 | 命令在 OS 沙盒（bubblewrap）的子进程中运行，可写路径、网络与遮蔽目录由能力上限与 Lease 计算 |
| 并行执行 | 执行队列按 AgentRun 划分，按并发类别与运行级上限执行；运行中的 AgentRun 写入范围两两不相交 |
| 业务类人工参与 | HUMAN 节点（业务输入，归 Workflow）与授权（Core 被动发起）分为两层；暂停、继续、中止、回退作为控制操作经 Kernel 中转 |
| 上下文压缩 | Kernel 的标准过程：超出阈值、provider 报告过长、用户要求或空闲时，先把较早的大工具结果修剪为头尾两段，仍超出再以模型摘要取代较早的历史并保留最近的原文；结果写回 Workflow 的日志；两次压缩之间请求只在末尾追加，以利于提示词缓存 |
| 产物保留与回收 | 正文按 Session 登记归属与保留类别：重建上下文所需的长期保留，被截断工具输出的完整版本与 ContextPack 7 天后回收（启动时与运行中定期回收）；模型以工具调用的编号分段读取完整版本，不接触存储地址；只有未删除的 Session 的登记能阻止回收 |

M2 在以下方面有意偏离长期架构，后续阶段再收敛：

| 长期架构 | M2 的过渡做法 | 收敛方向 |
|---|---|---|
| 变更以可核验产物交付，Kernel 执行物化与应用，Workflow 决定集成（Overall 第 9 节，Module/Workflow 第 6 节） | Agent 直接改写工作区，以改动检测、写入占用与按 Turn 的工作区快照弥补 | 每个 Agent 一个隔离副本（如 git worktree），由集成节点合并与验收；M2 已预留工作区视图与集成节点 |
| 文件修改是不可信行为，每次在独立子进程中运行（Kernel/Supervisor 第 4 节） | 文件读写由可信的内置 Executor 在进程内完成，范围由统一的可写判定保证；只有命令在沙盒子进程中运行 | Supervisor 独立成进程后，文件修改改在子进程中运行 |
| 多实例部署，按 Session 分片 | 单实例：同一数据目录以实例锁保证只有一个进程 | 见第 4 节"分片后的系统级状态" |

## 6. 演进核对

架构变化应核对正常执行、重复交接、部分失败、未知效果、权限撤销、
排空与恢复是否仍然成立。
新增能力只有在职责、协作与安全边界一致时才构成完整扩展，
文档中的能力不代表现有实现已经具备。
