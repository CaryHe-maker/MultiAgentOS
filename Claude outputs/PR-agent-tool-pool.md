## 目标

实现 M1Plan 第 2 条：AgentToolPool 提供 Agent、Model、Prompt、Tool 的定义，运行开始后固定版本与 digest。

本 PR 只做机制，内容先用占位：

- 做了：定义格式、从仓库文件加载并在启动时校验、按名字和版本精确查询、运行开始时锁定整套定义、fake 实现和共享 contract test
- 内容：两个 DeepSeek 模型定义使用真实参数和价格；提示词正文和工具参数是占位，等 AnalysisAction（A-04）确定后再填
- 没做：独立服务、热更新、运行时发布、权限管理、版本范围查询

## 需要评审

- Cary：`packages/workflow`、`apps/control-plane` 的改动
- field：`RuntimeProjection` 字段改名，以及 Kernel 以后如何使用锁定集合
- 三人都看：`packages/contracts` 的改动（共享协议）

## 破坏性变更

1. `CatalogPort`：`resolve(DefinitionQuery)` 换成两个方法
   - `getDefinition({ kind, id, version })`：按名字和版本精确查询
   - `pinAgent({ id, version })`：运行开始时一次锁定 Agent 及其模型、提示词、Unit、工具
2. 删除 `DefinitionQuery`、`DefinitionVersion` 两个 Schema，新增 `catalog.*` 定义 Schema；Protocol Registry 已同步
3. `WorkflowRunView` 和 `RuntimeProjection` 的字段 `definitionVersions` 改名为 `pinnedDefinitions`，内容为 kind、id、version、digest
4. `createM1Runtime` 从同步函数改为异步函数，因为启动时要读取并校验定义文件
5. `WorkflowService.create` 改为调用一次 `pinAgent(M1_AGENT)`，锁定失败就不创建运行；新增 `pinnedDefinitions(runId)`

改动原因：旧接口按能力模糊匹配、不指定版本，无法做到“运行开始后固定版本与 digest”。仓库里目前只有 Workflow 和 control-plane 调用 `CatalogPort`，两处都已在本 PR 中改好。相关 commit 已标注 `BREAKING CHANGE:`。

## 关键设计

- **Agent → Unit → Tool 三层**：Agent 只能引用 Unit，工具只能在所属 Unit 里使用，与 `Architecture/module/AgentToolPool.md` §3 一致
- **内容指纹（digest）**：每个定义按内容算一个 SHA-256，上层包含下层，所以一个 Agent 的 digest 就代表整套定义
- **版本规则**：`v0.x` 是草稿，直接改文件，digest 启动时自动算；`v1.0.0` 起封存，封存后再改会启动失败，只能发新版本
- **启动校验**：启动时检查全部定义，把所有问题一次列出后拒绝启动，包括格式错误、引用不存在、提示词变量不一致、只读 Unit 混入有副作用的工具、工具重名、模型不支持的思考设置
- **运行锁定**：Workflow 创建运行时拿到一份完整副本，运行期间只用它，目录变化不影响正在进行的运行
- **思考模式显式声明**：DeepSeek 默认开启思考，会增加计费 token 和延迟，所以 Agent 必须写明 `modelSettings.thinking`，M1 设为关闭
- **价格用整数存储**：单位是微美元 / 百万 token，避免浮点数影响 digest

## 新增内容

- contracts：`catalog.*` Schema、错误码 `CATALOG_ERROR_CODES`、规范化 JSON 函数 `canonicalJson`
- agent-tool-pool：文件加载与校验、`DefinitionCatalog`、封存命令 `pnpm run catalog:seal`
- 定义文件：1 个 Agent、3 个 Unit、2 个 Tool、1 个 Prompt、2 个 Model（deepseek-flash、deepseek-v4-pro）
- testing：`FakeCatalogPort` 和共享 contract test
- 依赖：`yaml 2.9.1`，只用于读取 YAML 定义文件，已写入 Dependencies.md

## 测试

```bash
pnpm install --frozen-lockfile
pnpm run check
git diff --check
```

结果：format、lint、typecheck 通过，18 个测试文件、135 个测试全部通过，`git diff --check` 无问题。11 个 commit 都分别跑过 `pnpm run check`。

覆盖范围：

- Schema 的正例、反例和多余字段
- 每一种启动校验错误
- 查询的 4 种错误码、撤销状态阻断、锁定结果不可修改且能转成 JSON
- 同一套 contract test 同时跑真实实现和 fake，并检查两者结果一致
- 仓库内的定义文件全部有效，DeepSeek 价格正确
- Workflow 创建运行时只锁定一次，锁定失败时不创建运行

## 风险与回滚

- 其他分支如果还在用 `resolve` 或 `definitionVersions`，合并后会编译失败，按“破坏性变更”一节改成新接口即可
- 新调用 `createM1Runtime` 的地方需要 `await`
- 回滚：直接 revert 本 PR，不涉及数据迁移

## 文档

- `docs/M1/M1Interface.md`：更新 §7 的 CatalogPort、错误码和版本规则
- `docs/M1/agent-tool-pool/AgentToolPoolM1.md`：新增模块实现说明
- `docs/M1/README.md`：说明模块实现文档放在 `docs/M1/<module>/`
- `docs/Requirements/Dependencies.md`：新增 `yaml`
- `packages/agent-tool-pool/definitions/README.md`：如何修改和发布定义

## 遗留事项

- `M1Process.md` B-05 的证据文件 `catalog.test.ts` 已删除；这一行归 field，本 PR 没改，请 field 更新
- 提示词和工具参数是占位，等 A-04 AnalysisAction 确定后填写
- Kernel 准入时用锁定集合校验 Agent → Unit → Tool，调用模型时读取 `modelSettings`（B-02、B-06）
- 暂不校验定义里引用的 Contract Schema 是否已注册

进度 ID：B-05
