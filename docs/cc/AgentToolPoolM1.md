# AgentToolPool M1 实现说明

> 分支 `feature/M1/agent-tool-pool`，2026-09-28。本文记录 M1 最小版本的设计决策、使用方法和遗留事项；接口的权威定义以 [M1Interface](../M1/M1Interface.md) §7 和 `packages/contracts/src/catalog/` 为准。

## 1. 范围

M1 只实现目录机制：定义 Schema、从仓库文件加载并校验、精确查找、运行开始时锁定版本、fake 与 contract test。以下内容不做：独立服务、热更新、运行时发布、权限管理和版本范围查询。Prompt 正文和 Tool 参数暂为占位，等 AnalysisAction（A-04）确定后以新版本发布。

## 2. 关键决策

| 决策 | 理由 |
|---|---|
| 定义类型为 `AGENT`、`UNIT`、`TOOL`、`MODEL`、`PROMPT`，暂不做 `EXECUTOR` 和 `CONTRACT` | Agent → Unit → Tool 是架构要求的授权边界，必须从 M1 开始存在。Executor 在 M1 由 `executionKind` 路由；Contract 只用 `ContractRef` 指向已注册 Schema |
| Agent 只引用 Unit，Unit 才引用 Tool | 与 [AgentToolPool](../Architecture/module/AgentToolPool.md) §3 一致；Kernel 可以只凭固定集合校验成员关系 |
| digest 覆盖引用目标的 digest（Merkle） | 固定一个 Agent digest 就固定了整个闭包；改动任何下层定义都会让上层 digest 失效，无法在旧版本号下“悄悄换内容” |
| 文件中的引用只写 `id` 与 `version`，digest 由加载器计算 | 人工维护引用 digest 容易出错；运行时对外的 `PinnedDefinitionRef` 仍然带 digest |
| digest 写在文件里，只由 `pnpm run catalog:seal` 填写，且只填写草稿 | 启动时重新计算并比对；编辑已发布文件会导致 `DIGEST_MISMATCH`，修复方式只能是发布新版本 |
| 状态（DEPRECATED/QUARANTINED/REVOKED）放在单独的 `status.yaml` | 状态是唯一允许变化的部分，不能参与内容 digest |
| 价格使用整数“微美元 / 百万 token” | digest 不依赖浮点格式；0.15 USD 写作 `150000` |
| 高峰价格使用 `ratePercent` 和 UTC 时间窗，不存储高峰价格本身 | 与 DeepSeek 的规则（非高峰价为高峰价的一半）对应，避免两份价格不一致 |
| `CatalogPort` 改为 `getDefinition` 与 `pinAgent` | 旧的 `resolve(DefinitionQuery)` 按 capability 模糊匹配，不是精确版本，也无法表达运行锁定 |
| 查找结果和锁定集合全部深冻结，类型为 `DeepReadonly` | 满足 Style §2.2 的发布值不可变要求 |
| YAML 使用 1.2 core schema | `no`、`on`、日期等保持字符串，值的类型和 digest 不会因写法不同而改变 |

## 3. 定义文件

```text
packages/agent-tool-pool/definitions/
  agents/<id>/<version>.yaml   units/<id>/<version>.yaml   tools/<id>/<version>.yaml
  models/<id>/<version>.yaml   prompts/<id>/<version>.yaml status.yaml
```

路径必须与文件内的 kind、id、version 一致。符号链接、BOM、重复 YAML 键和超过 1 MiB 的文件都会被拒绝。

发布新版本的步骤：

1. 复制为新版本路径，修改 `version` 和内容，删除 `digest` 行。
2. 让引用它的上层定义同样发布新版本并指向它。
3. 运行 `pnpm run catalog:seal`，然后运行 `pnpm run check`。

## 4. 启动校验

`DefinitionCatalog.load(source)` 会一次收集全部问题再失败（`CatalogLoadError.issues`）：Schema、未封存、digest 不一致、重复、引用缺失或引用了有问题的定义、Prompt 变量与 `{{slot}}` 不一致、READ_ONLY Unit 中含有有副作用的 Tool、同一 Agent 下 Tool 的 `modelName` 重名，以及 `status.yaml` 错误。

## 5. 查找与运行锁定

- `getDefinition({ kind, id, version })` 只做精确匹配。泛型让返回类型随 kind 变化，例如传入 `'MODEL'` 返回 `ModelDefinition`。
- `pinAgent({ id, version })` 返回 `PinnedDefinitionSet`，包含 Agent、Model、Prompt、Unit、Tool 的完整内容和排序后的 `refs`。闭包中任何成员被 QUARANTINED/REVOKED，整个 Agent 都不能锁定。
- `WorkflowService.create` 对 `M1_AGENT` 锁定一次，把 `refs` 写入 `WorkflowRunView.pinnedDefinitions`，并按运行保存完整集合（`pinnedDefinitions(runId)`）。

错误码见 `CATALOG_ERROR_CODES`；调用方只能按 code 分支，不能解析 message。

## 6. 模型数据

`deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）按 2026-09-28 的[官方价格页](https://api-docs.deepseek.com/quick_start/pricing)填写。非高峰价格（美元 / 百万 token）如下；高峰价格为非高峰的 200%，高峰时段为 UTC 周一至周五 01:00–04:00 和 06:00–10:00，中国法定节假日除外。

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---:|---:|---:|
| deepseek-flash | 0.003 | 0.15 | 0.60 |
| deepseek-v4-pro | 0.022 | 0.66 | 1.98 |

`deepseek-flash` 是服务端别名。DeepSeek 更换背后的模型时，应发布新的 ModelDefinition 版本，并更新 `providerModelLabel`。

## 7. 测试

| 位置 | 覆盖内容 |
|---|---|
| `contracts/src/catalog/definition-schemas.test.ts` | 合法值、额外字段、版本/ID/digest 格式、整数价格、草稿 Schema |
| `contracts/src/platform-common/canonical-json.test.ts` | 规范化 JSON，含属性测试 |
| `agent-tool-pool/src/domain/*.test.ts` | digest、每种加载问题、封存规则、查找错误、状态阻断、锁定 |
| `agent-tool-pool/src/adapters/file/*.test.ts` | 目录布局、YAML/JSON、封存写回保留注释、并发修改保护 |
| `agent-tool-pool/src/definitions-directory.test.ts` | 仓库内定义全部已封存且有效，DeepSeek 价格 |
| `testing/src/harnesses/catalog-port-contract.test.ts` | 同一套 contract 分别运行真实实现和 `FakeCatalogPort`，并检查两者一致 |

## 8. 遗留事项

| 事项 | 建议 Owner |
|---|---|
| Prompt 正文和 Tool 参数/结果 Schema 为占位；AnalysisAction 确定后发布 `v0.2.0` | A（A-04）与 meti |
| `M1Process.md` 中 B-05 的证据路径 `catalog.test.ts` 已删除，需要改为本分支的测试 | B |
| Kernel 准入应使用运行的 `PinnedDefinitionSet` 校验 Agent→Unit→Tool 成员关系 | B（B-02） |
| `ContractRef` 指向的 `kernel.ModelRequest`、`file.ReadRequest`、`workflow.AnalysisAction`、`workflow.AnalysisReport` 尚未注册；目录暂不校验 ContractRef 是否已注册 | 各 Schema owner |
| 尚未提供按时间计算高峰价格和成本的函数；节假日日历只以 `CN_PUBLIC_HOLIDAYS` 标记 | meti（评测） |
| 根 `package.json` 带 BOM，会导致 corepack 解析失败；建议统一去掉 BOM | 仓库维护 |

## 9. 评审请求

本分支修改了 `packages/workflow`（运行创建时锁定定义）和 `apps/control-plane`（启动时加载目录，`createM1Runtime` 变为 async）。请 Cary 评审 Workflow 的改动；Kernel 使用 `pinnedDefinitions` 的方式请 field 确认。
