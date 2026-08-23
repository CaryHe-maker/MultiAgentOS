# Agent 开发指南

本仓库是面向 coding-agent 工作流的本地优先编排内核。修改前请先阅读本文件。

## 从这里开始

1. 阅读 `README.md` 和 `docs/mvp-scope.md`，了解当前产品边界。
2. 修改 Planner、Scheduler 或 Worker 之间传递的数据前，先阅读 `docs/protocols.md`。
3. 修改任务生命周期或状态流转前，先阅读 `docs/workflow.md`。
4. 交付改动前，运行下方的检查命令。

## 常用命令

```bash
pip install -e '.[dev]'
pytest
ruff check .
mypy src
maos validate examples/todo-login-plan.json
```

## 仓库规则

- 跨组件的数据必须保持结构化。已实现 Schema 的唯一事实来源是 `src/multi_agent_os/models.py`。
- 不得悄悄扩大 Worker 权限、文件系统访问范围、网络访问范围或可执行命令范围。
- 当前 MVP 不需要时，不要引入 LLM 框架、数据库服务、Docker 或 Web UI。
- 修改行为时，在 `tests/` 中补充针对性的测试。
- 不要提交生成文件：`.venv/`、`.multiagentos/`、`.idea/` 和 `*.egg-info/`。
- 没有清晰验收条件的任务视为未完成。实现前应在任务卡或 Issue 中澄清。

## 当前边界

仓库目前能够校验任务 DAG 并创建 SQLite checkpoint；尚未调用 LLM、执行 Worker、创建 Git worktree 或合并代码。详见 `docs/mvp-scope.md`。
