# MultiAgentOS M1 UserInteraction

## 1. 目的与范围

本文规定 M1 UserInteraction 的交互范围：用户请求、授权询问与结果展示。
请求经 Gateway 进入 Kernel，可用请求见 [Kernel（外部视角）](Kernel.md) §4.2；
长期规划见 [UserInteraction 架构](../../Architecture/module/UserInteraction.md)。

## 2. 职责

UserInteraction 创建运行、取消运行、回答授权；展示 AnalysisReport 与停止原因；展示完成后请求关闭。
M1 采用单次目标输入与最终输出，运行中用户只能终止运行或回答授权。

## 3. 授权询问

- 询问由 Core 在第一个受保护 Unit 到达权限检查时发起，UserInteraction 收集 Y/N 回答。
- 询问内容须说明仓库路径、排除规则，以及“读取的内容会发送至 <provider>”。
- 回答只是原始响应，由 Core 判断适用性并决定是否签发 Lease；拒绝或超时不视为同意。

## 4. 结果展示

- 正常结束时，Core 通知 UserInteraction 运行已结束并附 `reportRef`，UserInteraction 读取并展示 AnalysisReport。
- 各结束方式下用户看到的内容见 [Kernel（外部视角）](Kernel.md) 第 9 节。
- 用户默认只看到结果；步骤、Round 数、token、provider 请求次数、耗时与失败分类写入运行记录，
  用户可通过查看命令调出。
