# MultiAgentOS 当前依赖

> 清单日期：2026-09-28。版本事实源为各 `package.json`；完整解析结果以 `pnpm-lock.yaml` 为准。

## 1. 运行环境

| Item | Version / constraint |
|---|---|
| Node.js | `24.19.0`; `>=24.19.0 <25` |
| pnpm | `11.25.0` |
| TypeScript module | ESM / NodeNext |
| Git | 可读取 revision 和 status 的维护版本 |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7 |

## 2. 根开发依赖

| Dependency | Version | Purpose |
|---|---:|---|
| `typescript` | `6.0.3` | 编译与声明生成 |
| `@types/node` | `24.13.6` | Node 类型 |
| `typescript-eslint` | `8.70.1` | TypeScript lint |
| `eslint` | `10.11.0` | 静态检查 |
| `@eslint/js` | `10.0.1` | ESLint 基础规则 |
| `prettier` | `3.9.8` | 格式化 |
| `vitest` | `5.0.1` | 测试 |
| `@vitest/coverage-v8` | `5.0.1` | 覆盖率 |
| `fast-check` | `4.10.2` | 属性测试 |
| `tsx` | `4.23.15` | TypeScript 运行器 |

## 3. 外部运行依赖

| Workspace | Dependency | Version | Ownership |
|---|---|---:|---|
| `packages/contracts` | `typebox` | `1.3.34` | Schema 与 TypeScript 类型 |
| `packages/contracts` | `ajv` | `8.20.0` | JSON Schema 验证 |
| `packages/contracts` | `ajv-formats` | `3.0.1` | 标准 format 验证 |
| `packages/kernel` | `ai` | `7.0.107` | 模型调用抽象 |
| `packages/kernel` | `@ai-sdk/openai` | `4.0.71` | OpenAI adapter |
| `packages/kernel` | `@ai-sdk/anthropic` | `4.0.58` | Anthropic adapter |
| `packages/kernel` | `dotenv` | `18.0.1` | 本地配置加载 |
| `apps/cli` | `commander` | `15.0.0` | CLI 参数解析 |
| `packages/testing`（dev） | `typebox` | `1.3.34` | 评测题目 Schema（与 contracts 同版本） |
| `packages/testing`（dev） | `yaml` | `2.9.1` | 读取评测题目与网页快照清单 |

其余 workspace 仅声明 `@multiagentos/*: workspace:*` 内部依赖。Provider SDK 只能由 Kernel 适配层导入；公共协议只使用 TypeBox/Ajv。

## 4. Workspace

仓库包含 3 个 app 和 11 个 package。`apps/control-plane` 负责组合；`packages/testing` 以 devDependency 使用相关模块；其他内部依赖均使用 `workspace:*`。

## 5. 安装与验证

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
pnpm.cmd run check
pnpm.cmd run test:coverage
```

根命令：`build` 编译 project references；`check` 依次执行格式、lint、typecheck 和 test；`test:coverage` 生成 V8 覆盖率。

## 6. 依赖治理

1. 所有直接外部依赖使用精确版本，不使用范围符号或浮动标签。
2. 内部依赖必须使用 `workspace:*`，并提交唯一 `pnpm-lock.yaml`。
3. 传递依赖不得被源码直接导入。
4. 新依赖必须说明 owner workspace、用途、替代方案、协议影响、许可/供应链风险和移除方式。
5. Provider SDK 变更必须验证结构化输出、tool call、usage 和错误映射。
6. Vitest 与 coverage 插件保持相同版本；Node 与 `@types/node` 保持相同 major。
7. `.env` 和 Secret 不得进入协议、日志、Artifact 或版本库。
8. `yaml` 由 `packages/testing` 的评测题目加载器以 devDependency 导入，用于读取评测题目和网页快照清单。选择它是因为零依赖、ISC 许可，按 YAML 1.2 core schema 解析（`on/off` 不会被当成布尔值），并能对重复键报错。替代方案为 JSON 题目文件，但不能写注释、多行问题可读性差；移除时把题目转为 JSON 并删除加载器中的 YAML 解析。`typebox` 与 contracts 同版本，校验复用 contracts 导出的 `validate`，不引入第二套 Schema 工具。
9. 搜索后端当前未声明额外 npm 依赖；使用系统 `rg` 前必须检测可用性，否则使用内置扫描适配器。
