# MultiAgentOS M1 ExecutorSet

## 1. 定位

ExecutorSet 提供 M1 Unit 的原子执行行为。Execution 把 `executionKind` 与输入交给 Supervisor，
由 Supervisor 装配并运行（见 [Supervisor](../kernel/Supervisor.md)）。
长期规划见 [ExecutorSet 架构](../../Architecture/library/ExecutorSet.md)，技术选择见
[M1TechStack](../M1TechStack.md) §8、§9。

## 2. Unit 与 Executor

Supervisor 以 `executionKind` 作为执行定义引用，找到对应的 Executor。M1 的 Executor 在进程内运行，
`rg` 等外部程序以子进程运行，参数以数组传递，取消时终止子进程。
M1 的 Unit 与 `executionKind` 对应关系见 [Kernel（外部视角）](../module/Kernel.md) 第 5 节。

Executor 负责硬编码的执行点检查；正常越界返回拒绝；违规时主动停止并上报。

## 3. 执行点检查（Enforcement）

- Executor 开发者在实现时硬编码防护检查，并在开发阶段优先写好：拒绝危险文件（`.env`、密钥文件、`.git/` 内部对象）、只处理普通文件、限制输出大小、`max_tokens` 不超过预留值、关闭 SDK 自带的自动重试。
- 仓库根目录取决于每次运行的 Lease，随执行请求交给 Supervisor，由 Supervisor 注入 Executor；Executor 以硬编码的逻辑检查“真实路径位于注入的根目录内”，以挡住符号链接逃逸。
- M1 只运行可信的内置 Executor；引入不可信 Executor 时须改由访问器或操作系统沙箱强制。

| 情况 | 例子 | 处理 |
|---|---|---|
| 正常越界 | 读取 `.env`、仓库外路径、输出超限 | 返回拒绝 → Execution 随结果检查交 Core → Core 交付 UnitReport REJECTED → 交还模型 |
| 安全违规 | 校验后文件被替换、范围约束缺失 | Executor 主动停止并上报 → Supervisor → Execution（隔离输出）→ Core 停止运行（VIOLATION） |

provider 返回的用量超过请求的 `max_tokens` 或输入估算时，按结算异常处理（见 [Monitor](../kernel/Monitor.md) 3.4），不属于安全违规。
