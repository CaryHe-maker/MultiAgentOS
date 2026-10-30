# MultiAgentOS M2 ArtifactStore

> 状态：草稿（阶段 1）。

## 1. 定位

ArtifactStore 提供不可变内容的存储、完整性与回收原语，Kernel.Execution 承担管理职责（[ArtifactStore 架构](../../Architecture/Infrastructure/ArtifactStore.md)）。
产物只由 Execution 写入；归属登记与访问检查属于 Execution（[Kernel/Execution](../Kernel/Execution.md)），ArtifactStore 不判断访问权限。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 按运行存放：`<dataDir>/runs/<workflowRunId>/artifacts/<sha256>` | 全局内容寻址：`<dataDir>/artifacts/<sha256>`，跨 Session 共享正文 | M2Design 第 10.1 节 |
| `put(workflowRunId, content, mediaType)`、`get(workflowRunId, ref)` | `put(content, mediaType)`、`get(ref)`；归属由 Execution 按 Session 登记 | M2Design 第 10.1 节 |
| 随运行目录保留，不回收 | 启动时、持有实例锁时回收：保留由 Execution 标记，其余早于启动的正文删除 | M2Design 第 10.1 节 |
| 正文只有工具输出与报告 | 增加工具结果的完整输出、用户输入的正文、模型输出与思考内容、回复与运行结果、压缩的摘要、ContextPack | M2Design 第 8.2、10.1 节 |

## 3. Port

```ts
interface ArtifactStorePort {                     // 只注入 Kernel 核心，由 Execution 使用
  put(content: Uint8Array, mediaType: string): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;      // 复验 sha256 与 size
  sweep(input: { retained: ReadonlySet<string>; olderThan: string }): Promise<{ removed: number }>;
  capabilities(): readonly CapabilityDescriptor[];
}
```

- `put`：先写入 `<dataDir>/tmp/`，复验 SHA-256 与 size 后原子 rename；同名文件已存在时校验内容相同后直接返回引用；
  已存在的内容损坏时报告完整性错误，不静默覆盖（M1 原样）。
- `get`：校验引用字段，读取并复验 SHA-256 与 size；不一致时返回完整性错误，不返回内容。
- `sweep`：删除 `retained` 之外、且修改时间早于 `olderThan` 的正文；只由 Execution 在启动时调用。ArtifactStore 不理解保留类别，只执行删除。
- `get` 读到已被删除的正文时返回"不存在"；由 Execution 结合归属登记区分 `ARTIFACT_EXPIRED` 与 `INVALID_ARTIFACT_REF`。

## 4. 回收

- 时机：进程启动、取得实例锁之后、Supervisor 清空临时目录之后、Kernel 核心开始服务之前，只进行一次。
- 由 Execution 决定保留什么（[Kernel/Execution](../Kernel/Execution.md) 第 6 节）：只读取 Session 引用为 ACTIVE 的 Session 的 `artifact-owners.jsonl`；
  `SESSION` 类的登记一律保留，`EXPIRING` 类的登记在保留期（缺省 7 天）内保留；同一正文有多处登记时，任一处要求保留即保留。`olderThan` 取本次启动时间。
- 实例锁保证回收期间没有其他进程写入；早于启动时间的条件保证本次启动后写入的正文不会被回收。
- 删除 Session 不直接删除正文：Kernel 把引用标为 DELETED 并删除它的归属文件，正文在下次启动的回收中删除（M2Design 第 10.1 节）。
  DELETED 的 Session 即使残留了归属文件，也不参与保留的标记。
- Session 本身不会被自动删除；进程长期不重启时，过期的正文要到下次启动才被删除。

## 5. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 15：ArtifactStore 只由 Execution 写入 | 架构测试：`ArtifactStorePort` 只注入 Kernel 核心 |
| 内容寻址与完整性（M1） | 单元测试：重复写入同一内容得到同一引用；损坏的正文读取失败 |
| `sweep` 只删除未被保留的旧正文 | 单元测试：在 `retained` 中、或晚于 `olderThan` 写入的正文不被删除 |
| 29：只有 ACTIVE 的 Session 的登记能让正文免于回收 | 见 [Kernel/Execution](../Kernel/Execution.md) 第 8 节 |

## 6. 阶段

全部内容属于阶段 1。
