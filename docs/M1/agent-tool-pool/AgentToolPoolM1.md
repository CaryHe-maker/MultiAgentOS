# AgentToolPool M1 实现说明

> 分支 `feature/M1/agent-tool-pool`，2026-09-28。本文记录 M1 最小版本的设计决策、使用方法和遗留事项；接口的权威定义以 [M1Interface](../M1Interface.md) §7 和 `packages/contracts/src/catalog/` 为准。

## 1. 范围

M1 只实现目录机制：定义 Schema、从仓库文件加载并校验、精确查找、运行开始时锁定版本、fake 与 contract test。以下内容不做：独立服务、热更新、运行时发布、权限管理和版本范围查询。Prompt 正文和 Tool 参数暂为占位，等 AnalysisAction（A-04）确定后直接修改。

## 2. 关键决策

| 决策 | 理由 |
|---|---|
| 定义类型为 `AGENT`、`UNIT`、`TOOL`、`MODEL`、`PROMPT`，暂不做 `EXECUTOR` 和 `CONTRACT` | Agent → Unit → Tool 是架构要求的授权边界，必须从 M1 开始存在。Executor 在 M1 由 `executionKind` 路由；Contract 只用 `ContractRef` 指向已注册 Schema |
| Agent 只引用 Unit，Unit 才引用 Tool | 与 [AgentToolPool](../../Architecture/module/AgentToolPool.md) §3 一致；Kernel 可以只凭锁定集合校验成员关系 |
| digest 覆盖引用目标的 digest（Merkle） | 一个 Agent 的 digest 就能确定整个闭包的内容 |
| `v0.x` 是草稿，直接修改；`v1.0.0` 起封存且不可修改 | M1 阶段提示词和工具会频繁调整，改一处只需改一个文件。可复现性由每次运行记录的 `pinnedDefinitions` digest 和 git 历史保证 |
| 已发布版本只能引用已发布版本 | 否则已发布定义的内容会随草稿变化 |
| Agent 必须显式声明 `modelSettings.thinking` | DeepSeek 默认开启思考模式，会增加计费的输出 token 和延迟；M1 不依赖默认值 |
| 状态（DEPRECATED/QUARANTINED/REVOKED）放在单独的 `status.yaml` | 状态是已发布定义唯一允许变化的部分，不能参与内容 digest |
| 价格使用整数“微美元 / 百万 token” | digest 不依赖浮点格式；0.15 USD 写作 `150000` |
| `CatalogPort` 改为 `getDefinition` 与 `pinAgent` | 旧的 `resolve(DefinitionQuery)` 按 capability 模糊匹配，不指定版本，也无法表达运行锁定 |
| 查找结果和锁定集合全部深冻结，类型为 `DeepReadonly` | 满足 Style §2.2 的发布值不可变要求 |
| YAML 使用 1.2 core schema | `no`、`on`、日期等保持字符串，值的类型和 digest 不会因写法不同而改变 |

## 3. 定义文件

```text
packages/agent-tool-pool/definitions/
  agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
  models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

路径必须与文件内的 kind、id、version 一致。符号链接、BOM、重复 YAML 键和超过 1 MiB 的文件都会被拒绝。

- 修改草稿（`v0.x`）：直接编辑文件，运行 `pnpm run check`。草稿文件不能写 `digest`。
- 发布（`v1.0.0` 起）：在新版本路径创建文件，不写 `digest`，运行 `pnpm run catalog:seal`。已封存的文件不能再改，要修改只能发布新版本。

## 4. 启动校验

`DefinitionCatalog.load(source)` 会一次收集全部问题再失败（`CatalogLoadError.issues`），包括：Schema 错误、已发布版本未封存、digest 不一致、草稿带 digest、重复定义、引用缺失、引用了有问题的定义、已发布版本引用草稿、Prompt 变量与 `{{slot}}` 不一致、READ_ONLY Unit 含有带副作用的 Tool、同一 Agent 下 Tool 的 `modelName` 重名、思考设置不被模型支持，以及 `status.yaml` 错误。

## 5. 查找与运行锁定

- `getDefinition({ kind, id, version })` 只做精确匹配。泛型让返回类型随 kind 变化，例如传入 `'MODEL'` 返回 `ModelDefinition`。
- `pinAgent({ id, version })` 返回 `PinnedDefinitionSet`，包含 Agent、Model、Prompt、Unit、Tool 的完整内容和排序后的 `refs`。闭包中任何成员被 QUARANTINED/REVOKED，整个 Agent 都不能锁定。
- `WorkflowService.create` 对 `M1_AGENT` 锁定一次，把 `refs` 写入 `WorkflowRunView.pinnedDefinitions`，并按运行保存完整集合（`pinnedDefinitions(runId)`）。

错误码见 `CATALOG_ERROR_CODES`；调用方只能按 code 分支，不能解析 message。

## 6. 模型数据

`deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）按 2026-09-28 的[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)填写。非高峰价格（美元 / 百万 token）如下；高峰价格为非高峰的 200%，高峰时段为 UTC 周一至周五 01:00–04:00 和 06:00–10:00。

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---:|---:|---:|
| deepseek-flash | 0.003 | 0.15 | 0.60 |
| deepseek-v4-pro | 0.022 | 0.66 | 1.98 |

- DeepSeek 在中国法定节假日按非高峰计费，M1 没有节假日日历，因此按规则算出的节假日成本是上限。
- 两个模型都支持思考模式，默认开启，档位为 low、high、max。M1 Agent 当前设置为 `thinking: DISABLED`；评测时如果开启，必须记录档位。
- `deepseek-flash` 是服务端别名。DeepSeek 更换背后的模型时，应发布新的 ModelDefinition 版本，并更新 `providerModelLabel`。

## 7. 测试

| 位置 | 覆盖内容 |
|---|---|
| `contracts/src/catalog/definition-schemas.test.ts` | 合法值、额外字段、版本/ID/digest 格式、整数价格、草稿 Schema |
| `contracts/src/platform-common/canonical-json.test.ts` | 规范化 JSON，含属性测试 |
| `agent-tool-pool/src/domain/*.test.ts` | digest、草稿与发布规则、每种加载问题、思考设置、查找错误、状态阻断、锁定 |
| `agent-tool-pool/src/adapters/file/*.test.ts` | 目录布局、YAML/JSON、封存写回保留注释、并发修改保护 |
| `agent-tool-pool/src/definitions-directory.test.ts` | 仓库内定义全部有效、已发布版本都已封存，DeepSeek 价格 |
| `testing/src/harnesses/catalog-port-contract.test.ts` | 同一套 contract 分别运行真实实现和 `FakeCatalogPort`，并检查两者一致 |
| `workflow/src/index.test.ts` | 创建运行时只锁定一次；锁定失败不创建运行 |

## 8. 遗留事项

| 事项 | Owner |
|---|---|
| Prompt 正文和 Tool 参数/结果 Schema 为占位，AnalysisAction 确定后直接修改 `v0.1.0` | Cary（A-04）与 meti |
| `M1Process.md` 中 B-05 的证据路径 `catalog.test.ts` 已删除，需要改为本分支的测试 | field（B） |
| Kernel 准入应使用运行的 `PinnedDefinitionSet` 校验 Agent→Unit→Tool 成员关系；模型调用使用 Agent 的 `modelSettings` | field（B-02、B-06） |
| `ContractRef` 指向的 `kernel.ModelRequest`、`file.ReadRequest`、`workflow.AnalysisAction`、`workflow.AnalysisReport` 尚未注册；目录暂不校验 ContractRef 是否已注册 | 各 Schema owner |
| 尚未提供按时间计算高峰价格和成本的函数 | meti（评测） |
| 根 `package.json` 带 BOM，会导致 corepack 解析失败；建议统一去掉 | Cary |
