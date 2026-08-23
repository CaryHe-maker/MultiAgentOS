# 协作开发规范

## 本地开发环境

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
pytest
ruff check .
mypy src
```

使用 Python 3.12 或更新版本。项目当前在本地使用 SQLite 运行，不需要 API Key。

## 分支规范

从最新 `main` 创建分支，并使用小写名称：

```text
<type>/<short-topic>
```

允许的类型：

- `feature/`：新增核心或用户可见能力，例如 `feature/worktree-runtime`。
- `fix/`：修复缺陷，例如 `fix/cycle-validation`。
- `docs/`：仅修改文档，例如 `docs/protocol-contract`。
- `test/`：仅修改测试，例如 `test/scheduler-retry`。
- `chore/`：工具配置或维护，例如 `chore/ruff-config`。

`feature/bootstrap-core` 的含义是“搭建初始核心骨架”。分支名描述正在进行的工作，commit message 描述已经完成的工作。

## Commit 和 Pull Request

使用简洁的 Conventional Commit 风格：

```text
feat: add worktree runtime
fix: reject unknown dependencies
docs: define task card protocol
test: cover retry exhaustion
```

创建 Pull Request 前：

1. 将最新的 `main` rebase 或 merge 到当前分支。
2. 运行 `pytest`、`ruff check .` 和 `mypy src`。
3. 写明改动内容、验收条件和已运行的检查。
4. 不提交 `.idea/`、`.venv/`、SQLite 数据库、密钥、模型 API Key 或生成日志。

## 三人 MVP 分工

| 负责人 | 主要模块 | 第一项交付物 |
|---|---|---|
| A：Orchestrator | Planner 协议、DAG Scheduler、预算和状态流转 | 合法 Plan -> 可执行任务选择 |
| B：Worker Runtime | Git worktree 生命周期、subprocess 执行、结构化 Worker 结果 | 一个隔离 Worker 能执行获批任务 |
| C：Integration and Quality | contract fixture、Integrator、质量门、指标和开发体验 | 合并报告和可重复的基准实验 |

负责人对模块设计和 review 负责，并不意味着其他人不能贡献。涉及跨模块边界的改动，应先在 Issue 或 Pull Request 中达成共识再实现。
