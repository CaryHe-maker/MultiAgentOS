# MultiAgentOS Module Host

## 1. 职责

Module Host 是进程组合与生命周期基础设施，负责配置解析、依赖注入、Module/Adapter 注册、启动排序、健康检查、readiness、drain 和关闭协调。`apps/control-plane` 是唯一最终 composition root。

Module Host 只拥有进程生命周期事实，不解释 Workflow、Policy、Context 或 Artifact 的业务语义。

## 2. Manifest 与注册

每个组件必须发布不可变 ModuleManifest，至少包含 moduleId、version、提供/需要的 Port、capabilities、配置 Schema、依赖、健康检查和关闭要求。注册时必须：

1. 拒绝重复 moduleId 和未知协议 major；
2. 验证必需 Port 与 capability 可满足；
3. 构建无环依赖图；
4. 按拓扑序启动，按逆序停止；
5. 在对外 readiness 前完成 Schema、Migration 和 Adapter 自检。

## 3. 生命周期

```text
REGISTERED -> STARTING -> READY -> DRAINING -> STOPPED
                      \-> DEGRADED
STARTING / DRAINING -> FAILED
```

- `health` 描述组件是否存活；`readiness` 描述是否可接收新工作，两者不得混用。
- DRAINING 后不接收新运行或 Unit，但必须允许已接收操作到达安全边界。
- shutdown 超时必须记录未完成资源和 correlation，不得伪造正常关闭。
- 组件启动失败时，只停止已启动的依赖闭包，不修改领域状态。

## 4. 配置与 Secret

配置必须经过版本化 Schema 校验并明确来源优先级。Secret 以 Ref 注入，只在需要的 Adapter 中物化；不得进入 Manifest、日志、health details 或配置快照。配置热更新只允许明确声明为动态的字段；影响协议、权限、持久化或执行安全的变更必须重启或走受控迁移。

## 5. 部署边界

模块化单体中，Module Host 在单进程装配全部 Module。拆分进程时仍复用相同 Manifest、Port 和生命周期语义；远程发现不得改变领域所有权。Module Host 不充当服务定位数据库、消息代理或任务调度器。

## 6. 可观测性与测试

记录启动/停止时长、依赖失败、健康变化、配置版本、drain backlog 和强制终止。测试覆盖依赖环、缺失能力、重复注册、部分启动回滚、readiness、drain、逆序停止、超时和 Adapter 替换。
