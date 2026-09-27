# MultiAgentOS M1 指南

## 1. 目的

本目录定义唯一已确定交付范围 M1，包括目标、任务、实时进度和必须实现的跨模块协议。长期架构位于 `docs/Architecture/`；本目录只选择其中需要在 M1 落地和验收的子集，不重新定义模块所有权。

除 M1 外，不定义其他里程碑的范围、排期、接口或完成承诺。超出 M1 的能力只记录为非目标，必须在 M1 验收完成后依据实测结果另行评审。

## 2. 阅读顺序

1. [M1Plan](M1Plan.md)：目标、范围、分工、任务、固定任务集和完成定义。
2. [M1TechStack](M1TechStack.md)：M1 使用、允许和明确排除的技术。
3. [M1Interface](M1Interface.md)：M1 必须实现的 Port、Schema、Envelope 和错误协议。
4. [M1Process](M1Process.md)：三位开发者并行维护的实时状态与验证证据。

模块的 M1 实现说明放在 `docs/M1/<module>/` 下，例如 [AgentToolPoolM1](agent-tool-pool/AgentToolPoolM1.md)。

理解系统边界时先阅读 [Architecture 指南](../Architecture/README.md)；依赖版本见 [Dependencies](../Requirements/Dependencies.md)；代码、Git 和 PR 规则见 [Style](../Style.md)。

## 3. 文档职责

| 文档 | 可以改变 | 不得改变 |
|---|---|---|
| M1Plan | M1 范围、任务、验收和降级策略 | 长期模块所有权和调用方向 |
| M1TechStack | M1 技术、版本用途和引入限制 | 完整系统技术选择或未声明依赖 |
| M1Interface | M1 实际承诺的具体协议 | 未经范围评审引入长期完整协议 |
| M1Process | 状态、日期、证据、PR 和阻塞原因 | 范围、接口或完成定义 |

## 4. 权威规则

1. 架构所有权和长期不变量以 `docs/Architecture/` 为准。
2. M1 范围与完成定义以 `M1Plan.md` 为准。
3. M1 协议目标以 `M1Interface.md` 为准；已实现 Schema 以 `packages/contracts/src` 为可执行事实源。
4. 目标与实现存在差距时，在 `M1Process.md` 标记，不得把未实现内容描述为完成。
5. 进度证据必须链接自动化测试、Artifact、报告或 PR。

## 5. 更新要求

- 范围变化：先修改 M1Plan，再更新 Interface、Process、README 和测试。
- 协议变化：同步 Schema、兼容说明、Producer/Consumer fixture 和 contract test。
- 任务完成：在同一 PR 更新负责人的进度行、日期和证据。
- 架构变化：先更新 Architecture，再评估 M1 范围和接口影响。
