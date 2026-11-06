# 阶段 5 人类在环控制的真实模型检查

> 2026-11-06。模型 `deepseek-flash`，运行环境 Ubuntu 24.04（WSL），代码为 M2Design v1.28。数据是单个模型、每格 3 次运行的事实，不是统计结论。

## 1. 要回答的问题

用户在运行中做的几件事，在真实模型下是否都对：回答 `ask_user` 的提问、暂停后带说明继续、运行中插话、中止后继续对话、在提问等待中中止。每次运行由模型之外的检查判定文件与对话的最终状态。

## 2. 场景

脚本 `apps/control-plane/test/acceptance/stage5-eval/run-stage5.ts`（`--yes --out <文件> --runs N [场景]`，结果追加到文件，已有的运行会跳过）。每个场景从控制台输入，做用户会做的事，再检查：

| 场景 | 用户做什么 | 检查 |
|---|---|---|
| `ask-answer` | 任务要求先用 `ask_user` 问问题语言，用户答"French" | 提问出现在写文件之前；`greeting.txt` 是法语；答复作为这次调用的结果出现在模型的历史里；有回复，没有错误 |
| `pause-continue-note` | 创建 a、b、c 三个文件的任务，第二次模型调用时 Ctrl+C 暂停，再 `/continue 另外创建 d.txt` | a、b、c 都写了；d.txt 按说明写了；说明进入了模型的上下文；有回复，没有错误 |
| `steer-note` | 同样的任务，第二次模型调用时 `/steer` 插话要求再建 e.txt | 同上，且全程没有暂停 |
| `abort-go-on` | 创建六个文件的任务，运行中暂停、再中止，然后发"别管文件了，只回答 ok" | 中止有提示；对话继续并有回复；main 的历史里有"用户中止了上一轮"；六个文件没有全部写完 |
| `abort-while-asking` | `ask_user` 的问题还在等答复时暂停、再中止，然后发新消息 | 问题被取消并有提示；对话继续并有回复 |

## 3. 结果

5 个场景各 3 次，**15/15 通过**。典型数字：`pause-continue-note` 与 `steer-note` 约 7–9 秒、5–7 次请求；`abort-go-on` 与 `abort-while-asking` 约 2–3 秒。

## 4. 评测发现的问题

第一轮 `ask-answer` 0/1：模型回复"`ask_user` 不可用"。原因：Kernel 为 AgentRun 组装工具表（`session/pinned-agent.ts`）时只加入了待办与派生工具，没有加入 `ask_user`，所以模型根本没被提供这个工具。脚本化模型的集成测试不会暴露这一点（脚本不看工具表）。已修正，并在 `stage4-exit`（main 与 worker 带 `ask_user`、explorer 不带）与 `stage5-exit`（提问前模型收到的工具表里有 `ask_user`）里加了断言。修正后 `ask-answer` 与 `abort-while-asking` 各 3/3。

## 5. 局限

- 单个模型、每格 3 次。
- 任务都很小，一个上下文做得完；没有测暂停对 SubAgent 并行任务的影响（那部分只有确定性测试：`stage4-exit`、`pause-steer-ask.test.ts`）。
- 模型是否会在该问的时候主动 `ask_user`，没有单独测；这里的提示词明确要求它问。

## 6. 复现

```bash
MAO_ENV_FILE=.env pnpm exec tsx apps/control-plane/test/acceptance/stage5-eval/run-stage5.ts \
  --yes --out results.jsonl --runs 3
```

WSL 中同时运行的进程不要超过 3 个。
