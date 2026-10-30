# MultiAgentOS M2 Persistence

> 状态：草稿（阶段 1）。

## 1. 定位

Persistence 提供状态存取与持久化机制，ModuleHost 管理其生命周期，各 Owner 保有数据权威（[Persistence 架构](../../Architecture/Infrastructure/Persistence.md)）。
目录、记录格式与 Port 的字段定义见 [Interface/Persistence](../Interface/Persistence.md)；本文规定写入规则、锁的实现与边界。

## 2. 相对 M1 的变化

| M1 | M2 | 依据 |
|---|---|---|
| 按运行存放在 `<dataDir>/runs/<workflowRunId>/` | 按 Session 存放在 `<dataDir>/sessions/<sessionId>/`；系统级索引放在 `<dataDir>/` 下的各命名空间目录 | M2Design 第 10.1 节 |
| 命名空间 `workflow`、`kernel-core` | 增加 `kernel-execution` | M2Design 第 10.1 节 |
| `repository`：按 id 整体覆盖（临时文件后原子 rename） | `appendLog`：只追加的 JSONL，每条记录写入后 fsync；`repository` 不再使用 | M2Design 第 10.3 节 |
| 审计 `auditLog` | 由 `appendLog` 取代，审计放在 Session 目录中 | Interface/Persistence 第 5 节 |
| 不支持锁 | 实例锁与 Session 锁 | M2Design 第 10.1 节 |
| 一个进程一个运行 | 一个进程同一时刻打开一个 Session；同一 `dataDir` 只有一个进程 | M2Design 第 2.3 节 |

## 3. 职责

- 提供 `PersistencePort`（Interface/Persistence 第 7 节）：只追加日志、Session 目录的创建、复制日志与删除。
- 按命名空间隔离：组合根只把限定命名空间的 Port 注入对应 Owner（Workflow 得到 `workflow`，Kernel.Core 得到 `kernel-core`，
  Kernel.Execution 得到 `kernel-execution`），越权调用当场拒绝。
- 实现实例锁与 Session 锁（第 5 节）；锁的取得时机由组合根与 Workflow 决定。
- 不解释记录内容，不决定何时修复、何时删除；这些决定属于各 Owner。

## 4. 写入规则

1. **只追加**：`append` 把一条记录序列化为一行 JSON 加 `\n`，写入后 fsync 才返回；已写入的行不修改、不删除。
2. **单一写入者**：同一个文件同一时刻只有一个写入者。实例锁保证只有一个进程；进程内同一文件的追加按调用顺序排队。
3. **不写半截记录**：一次 `append` 要么整行落盘，要么失败；失败时调用方不得更新内存状态（M2Design 第 10.3 节写入规则第 1 条）。
4. **尾部修复**：`repairTail` 只在打开文件时由 Owner 调用，把文件截断到最后一个完整换行，返回截断的字节数；
   是否追加 `LOG_TAIL_REPAIRED` 由 Owner 决定。
5. **读取**：`readAll` 逐行解析并按 Schema 校验；任何一行不合法即失败，不跳过。
6. **路径安全**：Session 目录、命名空间目录与目标文件不得是符号链接；`sessionId` 在拼接路径前校验格式（M1 的规则）。
7. **临时目录**：`<dataDir>/tmp/` 只用于 ArtifactStore 的写入；启动时由 Supervisor 清空（M1 原样）。

## 5. 锁

### 5.1 实例锁

M2Design 第 10.1 节的实现：

- **取得**：`mkdir <dataDir>/instance.lock`（原子操作），成功后写入 `owner.json`（Interface/Persistence 第 6 节）。
- **心跳**：持有期间每 `heartbeatMs`（10 秒）更新一次 `owner.json` 的 mtime。
- **过期判定**，任一条件成立：`pid` 不存在；`pid` 存在但 `/proc/<pid>/stat` 中的启动时间与 `processStartedAt` 不一致；
  mtime 距今超过 `staleAfterMs`（60 秒）。
- **抢占**：把过期的锁目录 rename 为 `instance.lock.stale-<ULID>`，再重新 `mkdir`；两个进程同时抢占时只有一个 `mkdir` 成功。
  抢占成功后删除墓碑目录。
- **释放**：进程退出时删除锁目录；包括第 4.7 节的停机。进程被强制杀死时，锁由下一个进程按过期规则抢占。
- **失败**：取锁失败时返回持锁进程的信息，由组合根报错退出。

### 5.2 Session 锁

`sessions/<sessionId>/session.lock`，由 Workflow 在打开 Session 时取得、关闭时释放（M2Design 第 10.3 节）。
在实例锁之下不会被争用；实现方式与实例锁相同，但不需要心跳，只按 `pid` 与启动时间判定过期。

## 6. 不变量与测试

| 不变量（M2Design 第 12 节） | 测试 |
|---|---|
| 8：日志只追加 | 单元测试：`append` 之后文件前缀逐字节不变；`repairTail` 只截断不完整的最后一行 |
| 15：SessionLogStore 只由 Workflow 写入 | 架构测试：只有 Workflow 得到 `workflow` 命名空间的 Port；越权调用被拒绝 |
| 24：同一个 `dataDir` 至多一个实例 | 集成测试（Ubuntu 24.04）：第二个进程取锁失败；持锁进程被杀死后过期抢占成功；两个进程同时抢占只有一个成功 |

另有：每条记录 fsync 后再返回（以故障注入测试模拟写入中途退出，重新打开时只需截断最后一行）。

## 7. 配置

| 配置 | 读取者 | 缺省 |
|---|---|---|
| `dataDir` | 组合根、Persistence、ArtifactStore | `~/.multiagentos`；必须是绝对路径，且与仓库互不包含（M1 的规则） |
| `instanceLock.heartbeatMs` | Persistence | 10000 |
| `instanceLock.staleAfterMs` | Persistence | 60000 |

## 8. 阶段

全部内容属于阶段 1。阶段 2 增加 `copyLogFrom`（Fork）与 `snapshot-index`；阶段 3 增加隔离目录。
