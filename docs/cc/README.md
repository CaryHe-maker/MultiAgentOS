# cc 文件夹说明

本文件夹里的文档全部由 Claude（Cowork）撰写，用来和其他来源的文档区分开。

| 文件 | 内容 | 当前状态 |
|---|---|---|
| `M1ChangeProposal.md` | 对 `feat/M1` 现行设计的修改提案：分工、任务顺序、ContextEngine 定位、评测、M2 调整 | **当前有效**，待三人评审；主文档 |
| `InterviewDrivenDesign.md` | 从面试官关心的六层能力，反推项目架构的八条决定与每人的面试故事 | **当前有效**；主要建议已并入 M1ChangeProposal 第 4、5、8 节 |
| `MeetingMinutes-2026-09-20-annotated.md` | 2026-09-20 架构会议记录：按发言人整理，附会后技术评注、共识与行动项 | **当前有效** |
| `RoadmapReview.md` | M1–M5 路线图评审意见 | 背景材料：提案的分析依据；与提案不一致处已在文首标明 |
| `FromScratchPlan.md` | 假设从零规划时的项目方案 | 背景材料：“从零开始”的思想实验；与提案的差异已在文首列表说明 |
| `ContextEngine/ContextEngineSpec.md` | ContextEngine M1 规格：三种操作、数据结构、预算与压缩、算法、评测、测试、实施顺序。面向开发者与 AI 编码助手 | **当前有效** |
| `ContextEngine/ContextEngineGuide.md` | ContextEngine 理解指南：用例子讲清每个设计的原因、动手顺序、面试练习。面向 meti | **当前有效** |
| `ContextEngineModuleDesign.md` | 早期的 ContextEngine 长期设计骨架（仅第 1–2 章） | 已被 `ContextEngine/` 下两份文档取代，仅作存档 |

`docs/research/` 下的其余文件（草稿、学习笔记、MAF 研究笔记）不是 Claude 写的。

**建议阅读顺序**：`M1ChangeProposal.md` → `InterviewDrivenDesign.md` → `MeetingMinutes-2026-09-20-annotated.md`；需要了解提案背后的推理时，再看 `RoadmapReview.md` 和 `FromScratchPlan.md`。
