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
| 多实例 | Kernel 核心按 WorkflowRun 分片，Gateway 独立并负责路由，Supervisor 按节点部署，增加全局容量服务 | Gateway ↔ Kernel 核心实例、Kernel 核心实例 ↔ 全局容量服务 |

拆分执行载体或通信路径时，应保持状态所有权、身份、受理、
效果核对及恢复语义，不能仅以替换调用方式代替边界设计。
多实例部署要求运行状态可以持久化与恢复，分片转移才有意义。

## 3. 扩展方向

| 方向 | 保持的边界 |
|---|---|
| 调度与并行 | Scheduler 管运行安排，Workflow 管业务依赖，Execution 管执行事实；Kernel 核心按顺序处理同一运行的消息，Executor 子进程中的执行可以并行 |
| 执行能力 | 新 Executor 提供行为代码，不自行获得授权或改写 Kernel 状态 |
| 上下文能力 | 算法归 ExecutorSet，长期运行状态归 Execution，业务意图归 Workflow |
| 交互形态 | 可支持不同交互载体和多种人类参与点，权限与业务决定仍有明确 Owner |
| 资源观测 | 观测粒度可演进，结算事实不能被采样估计替代 |
| 基础设施 | 可替换承载方式，不转移领域权威或改变已承诺的恢复语义 |
| 水平扩展 | 按 WorkflowRun 分片，每个运行只有一个 Kernel 核心实例写入；单个运行不跨实例拆分 |

## 4. 待实践演进的边界

内部 syscall 指 Kernel 核心其他组件向 Core 发起的请求，Core 调用其他组件称为职责接口调用，
二者在 Kernel 核心内以函数调用完成，组件之间不访问彼此的私有状态。通讯主体之间的承载方式（进程内消息、本地进程间通信或网络）
由各 MVP 的部署决定，但不改变契约与语义。

未声明受保护能力的行为以开发者授予权限为当前长期基线。
是否引入新的开发者授权机制尚未确定，不能据此允许调用者绕开受保护能力声明。

基础设施当前采用 Execution 管辖 ArtifactStore、Supervisor 管辖 ModuleHost、
Core 管辖 Fabric、ModuleHost 统一管理 Persistence 生命周期的关系。
后续调整必须同时说明决策权、数据所有权与故障责任的变化。

以下能力已有方向，尚未进入任何 MVP：

| 能力 | 方向 |
|---|---|
| AgentRun 级额度 | 在运行级额度之下为每个 AgentRun 单独记账与限额，每份子额度各自保留收尾额度 |
| 额度查询与分配 | Workflow 按需查询额度视图；Workflow 决定并行 Agent 的额度分配，Kernel 为每个子范围记账并执行限额 |
| 模型感知额度 | Kernel 在模型调用时注入剩余额度提示，Workflow 不必持有数值 |
| 危险行为授权 | 命令执行等危险行为每次单独征得用户同意 |
| 执行隔离 | 不可信行为在 Supervisor 管理的独立 Executor 子进程中运行，由操作系统沙箱强制范围 |
| 并行执行 | 执行队列按 AgentRun 划分并设运行级并发上限 |
| 按运行分片 | 逻辑分片固定数量，Kernel 核心实例经 Persistence 中的分片租约领取；写入携带分片 epoch；全局 API 容量由全局容量服务以令牌分配 |
| 子运行 | 超大运行拆为子运行，额度通过显式委派划给子运行 |

以下逻辑问题须在对应能力进入 MVP 前给出设计：

| 问题 | 需要明确的内容 |
|---|---|
| 分片后的跨运行状态 | 用户的长期授权记录、共享索引与仓库快照、租户级配额在按运行分片后的 Owner 与存放位置（目前只有 API 容量定义了全局服务） |
| 业务类人工参与 | 信息补充、方案选择、结果验收以及暂停、重试、重规划等用户操作，在 Workflow 与 UserInteraction 之间经 Kernel 中转的请求与事件 |
| 多实例下的基础设施管辖 | Kernel 核心有多个实例、Supervisor 按节点部署时，Fabric、ModuleHost、ArtifactStore 的管辖关系 |

## 5. 演进核对

架构变化应核对正常执行、重复交接、部分失败、未知效果、权限撤销、
排空与恢复是否仍然成立。
新增能力只有在职责、协作与安全边界一致时才构成完整扩展，
文档中的能力不代表现有实现已经具备。
