# MultiAgentOS M1 Kernel.Supervisor

## 1. 定位

Supervisor 负责系统生命周期与执行任务监管。组件间交互见 [Interaction](Interaction.md)，
长期规划见 [Kernel 架构](../../Architecture/module/Kernel.md) §8。

## 2. 职责

- 负责软件系统的启动与正常关闭，协调 ModuleHost 完成装配、依赖就绪与按序卸载
  （关闭顺序见 [ModuleHost](../infrastructure/ModuleHost.md)）。
- 接收 Execution 的执行请求，以 `executionKind` 作为执行定义引用找到对应 Executor，
  装配、创建并启动执行实例，注入范围约束、限制与受控依赖。
- 监管任务生命周期、超时、取消与停止期限，向 Execution 交接完成、失败、终止及违规事实。
- 负责运行总时长计时；超时时向 Core 报告，由 Core 按 Exception 停止运行（`RUN_TIMEOUT`）。
- 不维护 Unit 执行队列，不接管 UnitAttempt、业务执行顺序或结果验收。

## 3. 关闭与失控任务

M1 的关闭限于停止新执行、尽力结束在途任务及程序资源释放，不实现崩溃恢复。
Supervisor 不能承诺强制终止任意失控任务，也不能在所在进程卡死或崩溃后继续监管；
无法确认停止的任务以“停止未确认”报告，相关效果标记为未知。
独立 OS 子进程、进程池等执行载体仅作为后续扩展方向。

## 4. 配置项

| 配置 | 位置 | 读取者 | 建议初值 |
|---|---|---|---|
| 运行总时长上限 | 系统配置 | Supervisor | 30 分钟 |
