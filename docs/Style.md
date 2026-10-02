# MultiAgentOS 工程规范

## 1. 适用范围

本规范适用于源码、测试、配置、文档、Git 提交和 Pull Request。自动化配置与本规范冲突时，应在同一 PR 中修正二者，不得长期保留双重标准。

## 2. 代码规范

### 2.1 命名

| 对象 | 规则 | 示例 |
|---|---|---|
| 变量、参数 | `camelCase`，名词或清晰短语 | `workflowRunId` |
| 函数、方法 | `camelCase`，动词开头 | `buildContext`、`validateIntent` |
| 类、类型、接口 | `PascalCase`，使用领域名词 | `WorkflowService`、`UnitResult` |
| 常量 | `SCREAMING_SNAKE_CASE` | `M1_BUDGETS` |
| 布尔值 | `is/has/can/should` 前缀 | `isRetryable` |
| TypeScript 源文件 | 小写 `kebab-case`；入口文件使用生态约定 | `protocol-registry.ts`、`index.ts` |
| 测试文件 | 与被测文件同名并加 `.test.ts` | `context-engine.test.ts` |
| Markdown 文件与文档文件夹 | `PascalCase`；按概念组合单词 | `TechStack.md`、`M1TechStack.md` 、`Architecture`|
| 代码文件夹 | 小写 `kebab-case` | `agent-tool-pool`、`context-engine` |
| npm package | `@multiagentos/<kebab-case>` | `@multiagentos/agent-tool-pool` |
| Schema ID | `<namespace>.<Name>.v<major>` | `kernel.unit.UnitIntent.v0` |

避免无语义缩写、`data`、`info`、`manager` 等宽泛名称。ID 使用既定前缀；同一概念不得出现多个别名。

文件与目录命名还必须遵守：

- Markdown 文件使用 PascalCase，即每个概念单词首字母大写且不使用分隔符；数字前缀与既定缩写保持原样。
- `README.md`、`package.json`、`tsconfig.json`、工具配置文件和日期型会议记录遵循生态或既有固定名称，不改写为 PascalCase。
- 源码目录、package 目录和新建的普通文档子目录使用小写 kebab-case，不使用空格、下划线或大小写混合形式。
- 文件名必须表达单一概念；禁止使用 `misc`、`temp`、`new`、`final`、`v2` 等无法说明职责的名称。

### 2.2 TypeScript

- 使用 ESM 和显式 `.js` 相对导入；包之间只通过公开导出访问。
- 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和 `useUnknownInCatchVariables`。
- 禁止显式 `any`；边界输入使用 `unknown` 并立即校验。
- 类型专用导入使用 `import type`。
- 异步调用必须 `await`、return 或显式处理，禁止 floating promise。
- 函数保持单一职责；公共 API 写明输入、输出、错误和不可变性。
- 跨模块对象由 TypeBox Schema 定义并通过 Ajv/TypeBox 编译器校验。
- 错误使用 `ModuleError`；业务逻辑不得解析错误消息字符串。
- 发布值使用 readonly 类型，并在运行时冻结或通过不可变构造保证。

### 2.3 格式与文件

- UTF-8、LF、2 空格缩进、单引号、分号、尾随逗号、每行最多 100 字符。
- 禁止提交 `dist`、`coverage`、`node_modules`、`.multiagent`、密钥或本地环境文件。
- 注释解释原因、约束和不变量，不复述代码。
- TODO 必须包含责任人或 issue；不得用 TODO 代替错误处理。

### 2.4 架构约束

- 领域包只依赖 `@multiagentos/contracts` 和自身声明的 Port。
- `apps/control-plane` 是唯一组合根。
- CLI 不依赖 Workflow；Workflow 不依赖 Kernel、ContextEngine 或具体适配器；Executor 不回调 Workflow。
- 大对象存入 Artifact Store；模块消息只传 ArtifactRef。
- 新增能力先声明 owner、Schema、Port、错误和测试，再接入实现。

### 2.5 测试

- 修复缺陷必须先增加可复现测试。
- 每个 Port 同时提供正例、反例和 adapter contract test。
- 安全边界必须覆盖 Windows 与 POSIX 路径、symlink/junction、超时和大小限制。
- 测试必须确定性运行；时间、随机数、模型和文件系统通过可替换依赖控制。
- 提交前运行 `pnpm.cmd run check` 和 `git diff --check`。

## 3. 文档规范

- 项目名称统一为 `MultiAgentOS`。
- 一份文档只承担一个权威主题；避免复制接口定义，必要时链接权威来源。
- 标题层级连续；表格字段稳定；代码示例注明语言。
- 使用规范词“必须”“不得”“应”“可以”；避免“差不多”“以后再说”等模糊表达。
- 长期架构定义概念、职责、协作与安全约束；各 MVP 明确接口、算法、存储和验收。
- 架构变化同步检查架构、交付文档、依赖、索引和根 README。尚未开展的 MVP 详细设计只记录迁移影响，不虚构接口或实现完成。
- 会议记录保留原始语境，不作为规范性事实源。

## 4. Git 分支与 Ruleset

### 4.1 受保护分支

仓库 Ruleset 覆盖 `main` 和全部 `feat/*` 分支，并执行以下治理要求：

- 对 `main` 或 `feat/*` 的任何合并必须通过 Pull Request；禁止直接合并或以直接 push 绕过评审。
- 创建或删除 `main`、`feat/*` 分支只能由仓库 Owner（所有者）执行。其他成员需要新分支或删除分支时，必须由仓库 Owner 代为操作。
- 禁止 force push、重写受保护分支历史或通过临时关闭 Ruleset 规避要求。
- Ruleset 与本文不一致时，以更严格的约束为准，并通过治理 PR 消除差异。

长期维护分支只有：

- `main`：通过验收的稳定分支；
- `feat/M1`：M1 的集成分支。
- 后续`feat/M2`等分支

### 4.2 工作分支

- 工作分支统一使用 `feature/M1/Docs`的格式
- 要求必须为 feature + 版本 + 具体部分
- 版本：如 M1、M2、M3等
- 具体部分可以为 Docs、ContextEngine、Test 等
- 工作分支内部的 commit 无需 PR 但是 工作分支到main或feat/*必须经过PR
- 如果需要与受保护分支对齐状态，可以先 PR 入受保护分支后 再从受保护分支分出
- 如 `feature/M1/ContextEngine`、`feature/M2/kernel`

### 4.3 其他分支（正常情况不得使用）

- `hotfix/<scope>`：从 `main` 创建，仅处理需要独立发布的紧急修复；通过 PR 合并到 `main`，并同步回 `feat/M1`。
- `chore/<scope>`：不属于产品功能的仓库维护；不得承载 Module 功能或协议变更。
- `ci/<scope>`：仅限持续集成和自动化配置。

`<scope>` 使用小写 kebab-case；分支必须职责单一、短期存在。非受保护临时分支由创建者在合并后删除。任何分支不得重写已经被其他成员基于其开发的公共历史。

### 4.4 同步与冲突

创建工作分支前同步目标分支。提交 PR 前重新同步 `feat/M1` 或 `main`，在工作分支解决冲突并重新运行质量门。禁止在受保护分支上直接提交冲突修复。

### 4.5 PR至main
只有`feat/M1`等功能完善之后，才能通过全体 contributor 同意后才能PR到`main`分支，不得中途PR到main分支，如PR后修改也应当先修改`feat/M1`至功能完全闭合之后再次PR到main，版本置为M1.1,M1.2等

## 5. Commit 规范

采用 Conventional Commits：

```text
<type>: <imperative summary>
```

### 5.1 Type

| Type | 含义与适用范围 | 示例 |
|---|---|---|
| `feat` | 增加用户或系统可观察的新能力，包括新增协议能力 | `feat: add deterministic context ranking` |
| `fix` | 修复错误行为、安全缺陷或与既定规范不一致的实现 | `fix: reject paths outside the workspace` |
| `docs` | 只修改文档、文档示例或索引，不改变运行行为 | `docs: clarify checkpoint ownership` |
| `test` | 新增或修改测试、fixture、mock、fake 或测试工具，不改变生产逻辑 | `test: cover duplicate unit results` |
| `refactor` | 调整内部结构，不改变外部行为、协议语义或性能目标 | `refactor: extract unit admission validator` |
| `perf` | 在保持外部语义不变的前提下改善性能、内存或资源使用 | `perf: cache normalized search terms` |
| `build` | 修改依赖、编译、打包、workspace、lockfile 或构建配置 | `build: update typescript to 6.0.3` |
| `ci` | 修改 CI、Ruleset 自动化、检查任务或发布流水线 | `ci: add pull request quality gate` |
| `chore` | 不属于其他类型的仓库维护，且不改变产品行为 | `chore: remove obsolete editor settings` |
| `revert` | 撤销一个已提交变更；正文必须说明被撤销的 Commit 和原因 | `revert: undo agent retry policy change` |

Type 按变更的主要结果选择，不按修改文件类型机械判断。例如，修复缺陷并同时增加回归测试时使用 `fix`；实现新能力并同时更新测试与文档时使用 `feat`。一个 Commit 包含多个同等重要且无法归入同一 Type 的目标时，必须拆分。

### 5.2 Summary 与正文

要求：

- summary 使用祈使表达，不加句号，建议不超过 72 字符；英文使用小写开头，中文使用简洁的动作描述；
- 每个 commit 只表达一个逻辑变更，并保持可构建、可测试；
- 破坏性协议变更在 footer 写 `BREAKING CHANGE:`；
- 关联任务使用 `Refs: M1-...` 或 `Closes: #...`；
- 禁止 `update`、`wip`、`fix stuff` 等无信息说明。
- 中英文不得在同一 summary 中无规则混用。

冒号前不得有空格，冒号后必须保留一个空格。正确格式为 `feat: implement ContextEngine search` 或 `feat: 实现 ContextEngine 检索逻辑`；`feat : ...` 属于非法格式。

正文用于解释修改原因、关键约束和与旧行为的差异，不重复 summary。需要说明验证、迁移或风险时使用正文；关联信息和破坏性变更声明放在 footer。

完整示例：

```text
fix: reject paths through workspace junctions

- Resolve every requested path before admission so a junction cannot escape
the authorized workspace. 
- Add Windows-specific regression coverage.

```

## 6. Pull Request 规范

### 6.1 目标分支

- `feat/M1/<work-unit>` 的功能、修复、测试和文档 PR 合并到 `feat/M1`。
- `feat/M1 -> main` 只用于达到 M1 发布门后的集成 PR。
- `hotfix/<scope>` 可以通过独立 PR 合并到 `main`；合并后必须同步到 `feat/M1`。
- 禁止从其他工作分支直接合并到 `main`。

### 6.2 必填内容

PR 必须包含：目标与范围、关键设计、协议/依赖影响、测试命令与结果、风险与回滚方式、相关 issue/进度 ID、文档更新。跨模块 PR 还必须列出 owner 和兼容性说明。

### 6.3 合并门

- 所有必需 CI 检查通过；
- 至少一名非作者批准；涉及 Shared Contracts 时，所有受影响模块 owner 完成评审；
- 无未解决 review thread；
- `pnpm.cmd run check` 与 `git diff --check` 通过；
- 进度行和证据在同一 PR 更新；
- 不包含密钥、生成物、无关格式化或未声明依赖。

推荐 squash merge，使 PR 对应一个清晰的目标分支提交。PR 标题遵循 Commit 规范。
