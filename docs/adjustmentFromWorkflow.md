# Workflow 与 UserInteraction 合入后需要协调的事项

> 本文列出 `feature/M1/workflow-UserInteraction` 合入 `feature/M1/main` 之后，需要与其他模块协调的事项。
> 每一项在合入后转为一个 GitHub Issue，转完后从本文删除；全部转完后删除本文。
> 规范、源码与测试不得链接本文。文件名由 Cary 指定，是 PascalCase 命名惯例的例外。

| 编号 | 事项 | 涉及 | 优先级 |
| --- | --- | --- | --- |
| A1 | 端口响应期限从模块内的硬编码改为系统级约定 | field（Fabric、组合根、Kernel）、contracts | 高 |
| A2 | 报告的收尾说明改为结构化字段，文案统一由 UserInteraction 生成（已完成） | contracts、Cary | — |
| A3 | 本分支对共享替身与组合根测试的改动 | field、packages/testing | 高 |
| A4 | Workflow 与 UserInteraction 依赖的 Kernel 行为，需在真实 Core 上确认 | field | 高 |
| A5 | `WRAP_UP_NOTICE` 与上下文组装器的 final-call 状态行重复 | meti | 低 |
| A6 | 面向模型的反馈文案与组装器渲染格式的一致性 | meti | 低 |

## A1 端口响应期限

**现状**：Workflow 与 UserInteraction 对每次 Gateway、Catalog、Persistence 调用各自等待最多 30 秒
（两个模块的 `application/port-deadline.ts`），超时按系统故障升级，进程以 70 退出。

**问题**：这是对 Kernel 的隐含约定，Kernel 规范中没有“30 秒内回应”的承诺；常量在两个模块中重复；
期限属于系统的活性保障，不应由每个调用方各自决定。

**目标保持不变**：任何一次跨主体调用都不能无限等待。否则 Kernel 的处理一旦卡住，非交互运行
（评测脚本、CI）会永远挂起，只能靠人按两次 Ctrl+C。

**建议方案**：

1. 在 `SystemConfig` 中增加一个期限配置（例如 `portResponseTimeoutMs`，缺省 30000），由组合根读取并校验。
2. 期限由 Fabric 的 `request` 统一执行：超过期限时以类型化错误拒绝调用方，迟到的响应被丢弃并记录。
   调用方仍在自己的捕获边界内把它升级为系统故障（SystemFaultHandling 2.2），行为与现在相同。
3. M1Interface 第 2 节写明这项约定；Kernel 外部视角第 4.4 节写明：Gateway 与 Core 处理请求时不等待长时间 I/O，
   请求应在期限内得到回应。
4. 两个模块删除 `port-deadline.ts`，改为处理 Fabric 的期限错误；相应测试改为注入较短的期限。

**涉及**：`contracts`（配置 Schema、Fabric 错误类型，共享接缝）、Fabric 与组合根（field）、
两个模块（Cary）、M1Interface 与 Kernel 规范。完成之前保留两个模块中的现有实现。

## A2 报告的收尾说明结构化（已完成）

报告增加 `wrapUp.lastIssue` 与 `emptyReads`，说明文字统一由 UserInteraction 生成；`summary` 仍不允许为空。
契约修改经 #30 合入（2026-10-16，meti 与 field 评审）；Workflow 填写、UserInteraction 展示已在本分支完成。
本项不再需要协调，合入后从本文删除。

## A3 共享替身与组合根测试

本分支包含以下共享接缝或 field 范围内的改动，合入前或合入时需要 field 评审：

| 文件 | 内容 | 与 field 的关系 |
| --- | --- | --- |
| `packages/testing/src/fakes/fake-kernel.ts` | 共享 Supervisor 替身停止时丢弃未启动与迟到的执行、等待已开始的事实投递 | 产品 Supervisor（P08）实现后，两者的停止语义必须一致（Supervisor 第 6 节） |
| `packages/testing/src/fakes/fake-user-interaction.ts`、`fake-workflow.ts` | 与产品入口契约对齐 | 无直接影响 |
| `packages/testing/src/harnesses/inbox-port-contract.ts` | 两个 Inbox Port 的共享契约测试（M1Interface 第 13 节） | 无直接影响 |
| `apps/control-plane/src/bootstrap/workflow-interaction.test.ts`、`interaction-fault.test.ts` | 真实 Workflow 与 UserInteraction 配合 fake Kernel 经 `composeSystem` 运行的系统测试 | 位于组合根目录；`composeSystem` 或 fake Kernel 改动时可能需要同步 |

**约定建议**：

1. 这些改动作为单独的提交合入，PR 中请 field 评审；不夹在功能提交里。
2. 两个系统测试由 Cary 维护。field 修改 `composeSystem` 或共享替身导致它们失败时，在同一 PR 中修复或通知 Cary，
   不删除用例。
3. 这些测试只依赖 M1Interface 第 14 节已规定的公开接口，不对产品 Kernel 或基础设施的实现增加新的约束。

## A4 需要在真实 Core 上确认的 Kernel 行为

Workflow 与 UserInteraction 按 Kernel 外部视角实现，以下行为目前只在 fake Kernel 上验证过。
field 实现对应阶段时请确认，不一致时先协调再改任何一方：

| 依赖的行为 | 出处 | 相关阶段 |
| --- | --- | --- |
| UnitReport 可能先于对应的 SyscallAck 到达；每个得到 Ack 的 `submitUnit` 恰好一个 UnitReport，或随 RunClosed 结束 | Kernel 4.4 | P06、P09 |
| `cancelRun`、`shutdown` 在任何运行状态下都返回 Ack；UserInteraction 把它们被拒绝视为不变量失效并上报系统故障 | Kernel 4.3 | P06、P10 |
| `answerAuthorization` 只会以 `QUESTION_NOT_PENDING` 被拒（运行收敛后同样如此） | Kernel 4.3 | P07 |
| 一个运行内依次登记两个 AgentRun（Planner 结束后登记 CodeViewer） | Workflow 9.2 | P07 |
| `report-publish` 在当前 AgentRun 仍为 ACTIVE 时提交；之后才 `endAgentRun`、`closeRun` | Workflow 10.1 | P09 |
| 被 `BUDGET_WRAP_UP`、`BUDGET_EXHAUSTED`、`FINAL_CALL_USED` 拒绝的 model-call 不计 Round | Workflow 第 8 节 | P09 |
| `closeRun` 在收敛中或已结束时只返回 Ack；Workflow 只收到一个 RunClosed | Kernel 4.3 | P10 |

## A5 `WRAP_UP_NOTICE` 的重复

Workflow 在发起 final-call 前记录 `FEEDBACK(WRAP_UP_NOTICE)`（Workflow 第 8 节）；ExecutorSet 的上下文组装器在
`status.final = true` 时也在状态行中写明“这是最后一次调用”及原因（#26 D14）。模型会看到两遍相同的说明。
建议与 meti 商定只保留一处：保留状态行时，Workflow 第 8 节改为不记录该反馈；保留反馈时，组装器的状态行不再重复原因。

## A6 面向模型的反馈文案

组装器把 `FEEDBACK` 渲染为 `[<code>] <message>`（#26 D13），`message` 由 Workflow 生成。本分支已把这些文案改为
英文的可执行说明，参数不合法时附带 Schema 路径（不含参数值）。请 meti 在 F1–F5 评测中确认它们与 Prompt 的写法一致，
需要调整时以 Issue 提出，由 Workflow 修改。
