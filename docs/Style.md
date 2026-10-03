# MultiAgentOS 工程规范

## 1. 适用范围

本规范适用于源码、测试、配置、文档、Git 提交、Pull Request 和 Issue 协作。
本文规定命名、格式和协作流程，不规定模块架构、技术选型、协议内容或具体实现方案。
实现相关约束由对应的架构与设计文档维护，不在本文重复定义。
自动化配置与本规范冲突时，应在同一 PR 中修正二者，不得长期保留双重标准。

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
| 文档文件 | 文件主名使用 `PascalCase`；扩展名保持原样 | `Style.md`、`M1TechStack.md`、`Readme.md` |
| 文档文件夹 | `PascalCase`；按概念组合单词 | `Architecture`、`AgentToolPool` |
| 代码文件夹 | 小写 `kebab-case` | `agent-tool-pool`、`context-engine` |
| npm package | `@multiagentos/<kebab-case>` | `@multiagentos/agent-tool-pool` |

避免无语义缩写、`data`、`info`、`manager` 等宽泛名称。同一概念不得出现多个别名。

文件与目录命名还必须遵守：

- 所有文档文件的主名使用 PascalCase，即每个概念单词首字母大写且不使用分隔符。
  版本标识保持原样，如 `M1TechStack.md`；普通单词及缩写按概念组合，如 `ApiGuide.md`。
- 说明文档和会议记录也遵守该规则，如 `Readme.md`、`Meeting20260927.md`，不另设命名例外。
- 文档目录使用 PascalCase；仓库文档入口 `docs` 保留固定名称。
- `package.json`、`tsconfig.json` 等非文档工具配置文件遵循工具要求的固定名称。
- 源码目录和 package 目录使用小写 kebab-case，不使用空格、下划线或大小写混合形式。
- 文件名必须表达单一概念；禁止使用 `misc`、`temp`、`new`、`final`、`v2` 等无法说明职责的名称。

### 2.2 TypeScript

- 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`
  和 `useUnknownInCatchVariables`。
- 禁止显式 `any`；边界输入使用 `unknown` 并立即校验。
- 类型专用导入使用 `import type`。
- 异步调用必须 `await`、`return` 或显式处理，禁止 floating promise。
- 函数保持单一职责；公共 API 写明输入、输出、错误和不可变性。

### 2.3 格式与文件

- 文本文件使用 UTF-8（无 BOM）和 LF 换行，文件末尾保留一个换行，不得包含行尾空格。
- TypeScript 代码使用 2 空格缩进、单引号、分号和尾随逗号，每行最多 100 字符。
- Markdown 正文每行最多 100 字符，可在语义边界换行；表格、链接及不可拆分的代码标识允许超出。
- JSON、YAML 等配置文件遵循各自语法，不套用 TypeScript 的引号、分号和尾随逗号规则。
- 禁止提交 `dist`、`coverage`、`node_modules`、`.multiagent`、密钥或本地环境文件。
- 注释解释原因、约束和不变量，不复述代码。
- TODO 必须包含责任人或 Issue；不得用 TODO 代替错误处理。

### 2.4 测试与检查

- 修复缺陷必须先增加可复现测试。
- 测试应覆盖变更涉及的正常行为、错误行为和边界条件；具体场景由对应设计与验收要求确定。
- 测试必须可重复执行；存在外部依赖或非确定性因素时，必须记录运行条件及验证方式。
- 提交前运行 `pnpm run check` 和 `git diff --check`；Windows 可以使用 `pnpm.cmd run check`。

## 3. 文档规范

- 项目名称统一为 `MultiAgentOS`。
- 一份文档只承担一个权威主题；避免复制接口定义，必要时链接权威来源。
- 标题层级连续；表格字段稳定；代码示例注明语言。
- 使用规范词“必须”“不得”“应”“可以”；避免“差不多”“以后再说”等模糊表达。
- 长期架构定义概念、职责、协作与安全约束；各 MVP 明确接口、算法、存储和验收。
- 架构变化同步检查架构、交付文档、依赖、索引和根说明文档。
  尚未开展的 MVP 详细设计只记录迁移影响，不虚构接口或实现完成。
- 会议记录保留原始语境，不作为规范性事实源。

## 4. Git 分支与 Ruleset

### 4.1 受保护分支

仓库 Ruleset 覆盖 `main` 和全部 `feat/*` 分支，并执行以下治理要求：

- 对 `main` 或 `feat/*` 的任何合并必须通过 Pull Request；禁止直接合并或以直接 push 绕过评审。
- 创建或删除 `main`、`feat/*` 分支只能由仓库 Owner（所有者）执行。
  其他成员需要创建或删除上述受保护分支时，必须由仓库 Owner 代为操作。
  非受保护工作分支可以由成员自行创建，并按第 4.3 节清理。
- 禁止 force push、重写受保护分支历史或通过临时关闭 Ruleset 规避要求。
- Ruleset 与本文不一致时，以更严格的约束为准，并通过治理 PR 消除差异。

受保护分支的用途如下：

- `main`：通过验收的稳定分支；
- `feat/M1`：M1 的集成分支；
- 后续版本按需创建 `feat/M2`、`feat/M3` 等集成分支。
- 已发布版本需要修复时，可以临时创建 `feat/M1.1`、`feat/M1.2` 等修复集成分支，流程见第 4.5 节。

`feat/<version>` 专用于受保护的版本集成分支，`feature/<version>/<scope>` 专用于功能工作分支。
本仓库中 `feat/` 与 `feature/` 不互为别名，不得使用 `feat/M1/<scope>` 作为工作分支。

### 4.2 工作分支

工作分支统一使用 `<type>/<version>/<scope>`，按工作目标选择类型，不再全部使用 `feature/`：

| 类型 | 用途 | 示例 |
|---|---|---|
| `feature` | 新增或扩展功能、协议能力 | `feature/M1/context-engine-search` |
| `fix` | 修复一般缺陷 | `fix/M1/checkpoint-restore` |
| `docs` | 仅修改文档、文档示例或索引 | `docs/M1/style` |
| `refactor` | 不改变外部行为的内部结构调整 | `refactor/M1/unit-validator` |
| `perf` | 保持外部语义的性能或资源使用优化 | `perf/M1/context-cache` |
| `test` | 仅新增或调整测试及测试工具 | `test/M1/kernel-contract` |
| `build` | 依赖、编译、打包或构建配置调整 | `build/M1/workspace-dependencies` |
| `ci` | 持续集成、自动化检查或发布流水线调整 | `ci/M1/quality-gate` |
| `chore` | 不属于上述类型且不改变产品行为的仓库维护 | `chore/M1/editor-settings` |
| `experiment` | 技术探索或可行性验证，不保证合并 | `experiment/M1/context-ranking` |

命名与使用要求：

- `<version>` 表示目标集成版本，如 `M1`、`M2` 或修复版本 `M1.1`，必须与目标 `feat/<version>` 一致。
- `<scope>` 使用小写 kebab-case，描述具体模块或任务，如 `style`、`context-engine-search`；不得省略。
- `experiment` 同样使用完整三段格式，不使用只有版本、无法区分具体任务的 `experiment/M1`。
- 类型按任务的主要目标选择。功能实现附带测试和文档时使用 `feature`；独立文档修改使用 `docs`。
- 工作分支必须职责单一、短期存在。多个独立目标应拆分为多个分支和 PR。
- 从对应的 `feat/<version>` 创建工作分支，并通过 PR 合并回该集成分支。
- 工作分支内部可以直接 commit 和 push；进入 `main` 或 `feat/*` 必须遵守受保护分支与 PR 规则。
- 实验成果需要合并时，也必须通过相同的评审和质量门；未达到要求的探索代码不得直接进入集成分支。
- 分支类型不强制所有 Commit 使用同一 Type；每个 Commit 仍按第 5 节选择类型。
  功能提交使用 `feat:`，不使用 `feature:`；实验分支内也使用第 5 节已有的 Commit Type。
- 新建工作分支必须采用本规范。已有旧命名工作分支可完成当前 PR，后续任务使用新命名。

### 4.3 紧急修复例外与分支清理

- `hotfix/<scope>`：从 `main` 创建，仅处理需要独立发布的紧急修复；通过 PR 合并到 `main`。
  合并后必须通过 PR 同步回受影响且仍在维护的 `feat/<version>`。
- `hotfix` 是省略版本段的例外；一般缺陷使用 `fix/<version>/<scope>`，维护和 CI 任务使用第 4.2 节的常规工作分支。

`<scope>` 使用小写 kebab-case。非受保护临时分支由创建者在合并后删除；
不合并的实验分支应在记录结论后删除。临时修复集成分支完成发布及必要同步后，可以由 Owner 删除。
任何分支不得重写已经被其他成员基于其开发的公共历史。

### 4.4 同步与冲突

创建工作分支前同步目标分支。提交 PR 前重新同步对应的 `feat/<version>`；紧急修复则同步 `main`。
在工作分支解决冲突并重新运行质量门，禁止在受保护分支上直接提交冲突修复。

### 4.5 发布到 main 与发布后修复

- `feat/<version>` 达到该版本约定的最低功能与验收标准后，可以通过 PR 发布到 `main`。
  发布不要求完成长期规划或所有可选功能；已知问题不得妨碍最低标准成立，并应在 PR 中说明。
- 发布 PR 与其他 PR 使用同一评审门槛：至少一名非 PR 创建者批准，并满足第 6.3 节的合并门。
  不要求全体 contributor 同意，也不额外要求所有模块负责人批准。
- 可以提前创建 Draft PR 收集反馈；未达到发布标准时不得合并到 `main`。
- M1 发布到 `main` 后发现问题时，可以由 Owner 从包含该已发布版本的 `main` 提交创建 `feat/M1.1`。
  在该临时集成分支上组织修复或重建，工作分支如 `fix/M1.1/checkpoint-restore` 通过 PR 合入它。
- 功能恢复正常且达到最低验收标准后，通过 `feat/M1.1 -> main` 的 PR 重新发布，发布版本记为 `M1.1`。
  后续同类修复依次使用 `feat/M1.2`、`feat/M1.3`，发布版本相应记为 `M1.2`、`M1.3`。
  `M1.1` 等标识表示 M1 的发布后修复版本，不表示 M2 等后续功能阶段。
- 如果 `main` 已包含后续版本，应从需要修复的发布提交创建修复集成分支，并在 PR 中明确发布目标。
  合入 `main` 时必须保留其已有功能，不得用旧版本整体覆盖当前状态。
- 发布记录必须关联版本标识、发布 PR 和对应的 `main` 提交。
  修复完成后，通过 PR 将必要变更同步到受影响且仍在维护的集成分支。
- 第 4.3 节的 `hotfix` 是直接向 `main` 提交紧急修复 PR 的例外，仍需满足相同的评审和质量要求。

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

Type 按变更的主要结果选择，不按修改文件类型机械判断。
例如，修复缺陷并同时增加回归测试时使用 `fix`；实现新能力并同时更新测试与文档时使用 `feat`。
一个 Commit 包含多个同等重要且无法归入同一 Type 的目标时，必须拆分。

### 5.2 Summary 与正文

要求：

- summary 使用祈使表达，不加句号，建议不超过 72 字符；英文使用小写开头，中文使用简洁的动作描述；
- 每个 commit 只表达一个逻辑变更，并保持可构建、可测试；
- 破坏性协议变更在 footer 写 `BREAKING CHANGE:`；
- 关联任务使用 `Refs: M1-...` 或 `Closes: #...`；
- 禁止仅使用 `update`、`wip`、`fix stuff` 等无信息说明；可以使用 `update` 加明确的修改对象。
- summary 使用一种主要语言，项目名称、代码标识和通用技术术语可以保留原文。

冒号前不得有空格，冒号后必须保留一个空格。
正确格式为 `feat: implement ContextEngine search` 或 `feat: 实现 ContextEngine 检索逻辑`；
`feat : ...` 属于非法格式。

正文用于解释修改原因、关键约束和与旧行为的差异，不重复 summary。
需要说明验证、迁移或风险时使用正文；关联信息和破坏性变更声明放在 footer。

完整示例：

```text
fix: reject paths through workspace junctions

- Resolve every requested path before admission so a junction cannot escape
  the authorized workspace.
- Add Windows-specific regression coverage.
```

## 6. Pull Request 规范

### 6.1 目标分支

- 第 4.2 节的 `<type>/<version>/<scope>` 工作分支统一合并到对应的 `feat/<version>`。
  例如 `feature/M1/context-engine-search`、`docs/M1/style`、`chore/M1/editor-settings` 的目标均为 `feat/M1`。
- `experiment/<version>/<scope>` 若提交合并 PR，目标同样为对应的 `feat/<version>`，并满足全部合并门。
- `feat/<version> -> main` 用于版本发布，包括 `feat/M1.1 -> main` 等修复版本；合并条件见第 4.5 节。
- `hotfix/<scope>` 可以通过独立 PR 合并到 `main`；
  合并后必须通过 PR 同步到受影响且仍在维护的 `feat/<version>`。
- 禁止从其他工作分支直接合并到 `main`。

### 6.2 必填内容

PR 必须说明目标与范围、主要变更、验证方式与结果、风险及回滚方式。
涉及设计、协议、依赖或文档变化时，说明相应影响；没有相关影响的项目可以注明“不适用”。
已有相关 Issue 或进度任务时，必须提供链接或 ID；跨模块 PR 应说明受影响模块及兼容性。
发布 PR 还必须列出该版本的最低验收标准及对应验证结果。

### 6.3 合并门

- 所有必需 CI 检查通过；
- 至少一名非 PR 创建者批准，普通 PR 与发布 PR 均适用；
- 无未解决 review thread；
- `pnpm run check` 与 `git diff --check` 通过；Windows 可以使用 `pnpm.cmd run check`；
- 有对应进度任务时，在同一 PR 更新该任务的进度记录和验证证据；没有对应任务时说明不适用；
- 不包含密钥、生成物、无关格式化或未声明依赖。

### 6.4 合并策略

- 短期工作分支合入 `feat/<version>` 时，推荐 squash merge，使一个 PR 对应一个清晰的提交。
- `feat/<version> -> main` 的发布 PR 使用 merge commit，保留集成分支与发布历史的合并关系。
  受保护集成分支之间的同步 PR 同样保留合并关系，不使用 squash 或 rebase 重写已有提交。
- 实验记录或验证证据引用了具体提交时，相关 PR 应保留被引用的提交历史，并说明原因。
- PR 标题遵循第 5 节的 Commit 规范。

## 7. Issue 协作

Issue 是本项目持续交流和追踪问题的入口，不限于缺陷报告或已经确定的开发任务。
成员可以用它提出想法、讨论预想架构与机制、澄清版本目标、分享实验发现，或记录待共同决定的问题。
早期想法可以在方案尚不完整时提出，不要求先形成详细设计或实施承诺。

Issue 的标题、正文结构、篇幅和表达形式由讨论需要决定，不要求固定模板、字段或标签。
交流时应让读者能够区分事实、个人建议、待确认问题和已确认结论；提出建议不代表方案已获通过。
可以在评论中补充、质疑和调整方案，相关讨论通过链接串联，避免丢失背景和决策原因。

需要落地的讨论结论应通过 PR 更新相应文档或代码，Issue本身仅作为参考。
Issue 中的提案不自动替代已生效的规范或设计；PR 是否通过仍按第 6 节执行。
讨论达成结论、转入其他任务或决定暂不实施时，可以记录结果及后续去向，再按实际情况关闭 Issue。
PR 仅解决部分问题时，应保留其余问题的讨论与追踪，不因存在关联 PR 就视为全部完成。
