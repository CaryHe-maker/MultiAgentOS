# MultiAgentOS M2 已定的决定

> 本文只收仍然约束当前设计与实现的决定，按主题排列，由负责人（Cary）作出。每条决定的机制写在 [M2Design](M2Design.md) 与各组件文档中，这里只记结论和日期。
> 需要改变其中一条时，先在 M2Design 发布新版本，再修改本文。已执行完毕的过程性决定（M1 代码的清理步骤、过渡期的 `V1` 后缀等）和旧阶段的计划不在此列，见 [History/M2](../History/M2/README.md)。
> 待决定的问题写在 [M2ReleasePlan](M2ReleasePlan.md) 第 8 节。

## 1. 架构与状态所有权

| 决定 | 日期 | 见 |
|---|---|---|
| 不留历史包袱：`analyze` 并入统一路径，发布版只有 major 1，不为兼容旧写法弯折 M2 的设计 | 2026-10-31 | M2Design 第 1.4 节 |
| AgentRun 状态机对所有 Agent 相同，结束方式由定义声明的结束工具决定，运行器按表执行 | 2026-10-31 | M2Design 第 3.4 节 |
| 用户正文只以引用传递，没有例外 | 2026-10-31 | M2Design 第 2.4 节 |
| 思考强度只在 `registerAgentRun` 中给出 | 2026-11-02 | Interface/Definitions |
| `replayReasoning` 定为 `REQUIRED`：服务端记得的工具调用不回传也能成功，但保留时长未知，恢复旧 Session 时可能失败 | 2026-10 | M2Design 第 9.4 节 |

## 2. 授权与安全

| 决定 | 日期 | 见 |
|---|---|---|
| 授权询问不超时，一直等到用户回答，只在运行收敛时取消；拒绝作为被拒 Unit 的工具结果交还 Agent，不结束 Turn | 2026-10-31 | M2Design 第 4.2、5.3 节 |
| 用户拒绝绑定提出请求的 AgentRun；工具结果为 `the user rejected tool "x"`，不计入连续出错，之后的轮次不再提交相同的工具 | 2026-11-02 | M2Design 第 5.3 节 |
| `AGENTS.md` 与其他说明文档同级：第一次需要读仓库时才读，以历史条目追加，不进入 system 段；main 没有启动 Unit | 2026-11-02 | M2Design 第 9.5 节 |
| 文件工具拒绝写入排除规则命中的路径（`.env*`、私钥、`node_modules` 等），返回 `PROTECTED_PATH` | 2026-11-04 | M2Design 第 6.3 节 |
| 系统没有 `git` 时，启动预设降为 `readonly` 并提示用户 | 2026-11-04 | M2Design 第 6.2 节 |
| 写文件保持进程内执行；越界路径、符号链接替换与竞争条件的对抗测试是发布条件 | 2026-11-04 | M2Design 第 6.3 节 |
| 自动挂载 `PATH` 中位于 `$HOME` 之下的目录进入沙盒（`sandbox.mountPath`，缺省开启） | 2026-11-05 | M2Design 第 6.1 节 |
| 系统内存检测由 Monitor 定时采样，只向 Core 发控制消息，经统一收尾路径与中断入口处理，不设特例路径 | 2026-11-04 | M2Design 第 7.7 节 |
| 网页抓取缺省先用本地抓取，失败时用 DeepSeek 抓取；搜索与抓取的提供方经端口按名字选择，不与系统耦合 | 2026-11-07 | M2Design 第 8.3 节 |

## 3. 额度、上下文与提示词

| 决定 | 日期 | 见 |
|---|---|---|
| 额度按价格折算缓存命中的输入；单次输出上限 64000，输入上限 880000 | 2026-11-04 | M2Design 第 7.3 节 |
| 估算与 provider 的计数相差不到 5%；提前收尾必须有报告与日志，接近上限时预警 | 2026-11-04 | M2Design 第 9.3 节 |
| main 的 `maxRounds` 为 80 | 2026-11-04 | M2Design 第 3.9 节 |
| SubAgent 任务的 `budget` 只保留 `tokens` | 2026-11-06 | M2Design 第 3.6 节 |
| 摘要请求按实测改写法：前缀式优先，纯文本式作回退；每个工具结果末尾写 `[toolCallId: …]`（模型看不见调用 id 字段） | 2026-11-07 | M2Design 第 8.2、9.6 节 |
| 压缩按条目分级：旧的用户消息在 16 KB 内原样保留，其余修剪与摘要；空闲压缩缺省开启 | 2026-11-07 | M2Design 第 9.6 节 |
| main 的提示词（`main-system`）已在真实模型上验证；其余 Agent 与 Prompt 定义仍是 `v0.1.0` 草稿，发布时一起封存 | 2026-11-04 | AgentToolPool 第 3 节 |
| 派生准则（D 组指标）暂不优化，留给 [M2ReleasePlan](M2ReleasePlan.md) 中的 Agent 与 Prompt 工作 | 2026-11-06 | M2ReleasePlan 第 5 节 |

## 4. 流程

| 决定 | 日期 |
|---|---|
| 工作分支按 [M2ReleasePlan](M2ReleasePlan.md) 第 4 节命名，每个 phase 的分支从 `feature/M2/prompt-agent` 创建、完成后 PR 回它；全部 phase 完成后 `feature/M2/prompt-agent` 一次性 PR 合入 `feat/M2`；合入前在 Ubuntu 24.04（WSL）跑完整质量门 | 2026-11-07 |
| 需要负责人判断的设计问题，当场提出选项，不先行实现 | 2026-10 |
| 不推送、不开 PR，除非负责人明确同意；真实模型与 API 实验只在带 `--yes` 与预算时运行 | 2026-10 |
