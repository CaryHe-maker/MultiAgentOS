# healthhub 规格

一个分布式的个人健康管理系统：六个服务，各自一个进程、各自的数据，通过 HTTP 通信。只用 Python 3 标准库（`http.server`、`sqlite3`、`urllib`、`json`、`threading` 等），不安装任何包。

## 1. 运行

- 端口：`HH_PORT_BASE`（环境变量，缺省 8700）起连续六个端口：gateway = base+0，identity = base+1，records = base+2，ingest = base+3，analytics = base+4，notify = base+5。
- 数据：环境变量 `HH_DATA`（缺省 `./data`）下，每个服务只读写自己的子目录 `HH_DATA/<服务名>/`。服务之间**不共享文件或数据库**，只通过 HTTP 交换数据。
- `./run.sh start`：在后台启动全部六个服务，等到每个服务的 `GET /health` 都返回 200 才退出（退出码 0；30 秒内没起来则退出码 1）。
- `./run.sh start <服务名>`、`./run.sh stop <服务名>`：只启动或停止一个服务（停止要等进程退出）。`./run.sh stop`：停止全部。重复 start 一个已在运行的服务不出错。
- 每个服务：`GET /health` → 200 `{"service": "<服务名>", "status": "ok"}`。

## 2. 对外接口（全部经过 gateway）

请求与响应都是 JSON。出错时响应 `{"error": "<说明>"}`：输入不合法 400，未登录或令牌无效 401，资源不存在或不属于当前用户 404，冲突 409，依赖的服务不可用 503。

除注册、登录与设备上报外，`/api/*` 都要带 `Authorization: Bearer <令牌>`，否则 401。

### 账号

- `POST /api/register` `{"username", "password"}` → 201 `{"user_id"}`。用户名已存在 409；密码少于 8 个字符 400。用户名不区分大小写。
- `POST /api/login` `{"username", "password"}` → 200 `{"token"}`；错误 401。
- `POST /api/logout` → 204，此后这个令牌 401。
- `GET /api/me` → 200 `{"user_id", "username"}`（username 为注册时的小写形式）。

### 体征记录

- 类型 type 只能是 `heart_rate`、`steps`、`weight`、`systolic`、`glucose`；value 是数（整数或小数）；at 是 UTC 时间，格式严格为 `YYYY-MM-DDTHH:MM:SSZ`。不合法 400。
- `POST /api/vitals` `{"type", "value", "at"}` → 201 `{"id"}`。
- `GET /api/vitals`，可选查询参数 `type`、`from`、`to`（与 at 同格式，含两端）→ 200 `{"items": [{"id", "type", "value", "at", "source"}]}`，按 at 升序，at 相同按 id 升序。手动记录的 source 是 `"manual"`，设备上报的是 `"device"`。
- `DELETE /api/vitals/<id>` → 204；不存在或不是自己的 404。

### 用药与提醒

- `POST /api/medications` `{"name", "dose", "times": ["08:00", "20:00"]}` → 201 `{"id"}`；times 每项是 `HH:MM`，至少一项。
- `GET /api/medications` → 200 `{"items": [{"id", "name", "dose", "times"}]}`，按 id 升序。
- `GET /api/reminders?date=YYYY-MM-DD` → 200 `{"date", "items": [{"medication_id", "name", "dose", "time"}]}`：当天每种药的每个时间一项，按 time 升序，time 相同按 medication_id 升序。

### 设备

- `POST /api/devices` `{"name"}` → 201 `{"device_id", "device_key"}`。
- `POST /ingest/batch`（不带 Authorization，带请求头 `X-Device-Key: <device_key>`）`{"batch_id", "readings": [{"type", "value", "at"}]}`：
  - 密钥无效 401；任一读数不合法 400，且整批都不接受。
  - 第一次收到这个设备的这个 batch_id：202 `{"accepted": <读数个数>, "duplicate": false}`；
  - 同一设备重复的 batch_id：200 `{"accepted": 0, "duplicate": true}`，不重复记录。
  - 读数作为该设备主人的体征记录出现在 `GET /api/vitals`（source `"device"`），最迟 5 秒内。

### 统计

- `GET /api/summary/daily?date=YYYY-MM-DD` → 200 `{"date", "metrics": {"<type>": {"count", "min", "max", "avg"}}}`：这一天（UTC）这个用户所有未删除的体征记录（手动与设备），只列有记录的类型；avg 四舍五入到 2 位小数。
- `GET /api/trends?type=<type>&days=<N>&end=YYYY-MM-DD` → 200 `{"type", "points": [{"date", "avg"}]}`：从 end 往前共 N 天（含 end）里有记录的日子，每天一项，按日期升序，avg 四舍五入到 2 位小数。
- 新增与删除的记录最迟 5 秒内反映在统计里。

### 阈值与告警

- `PUT /api/thresholds` `{"type", "min"?, "max"?}` → 200 `{"type", "min", "max"}`（没给的为 null）。
- 此后这个用户这种类型的新记录（手动或设备）小于 min 或大于 max 时产生一条告警，最迟 5 秒内出现在 `GET /api/alerts` → 200 `{"items": [{"id", "type", "value", "at", "kind"}]}`，kind 为 `"low"` 或 `"high"`，按 id 升序。在阈值设置之前的记录不产生告警。

## 3. 可靠性

- **持久**：`./run.sh stop` 后再 `./run.sh start`，账号、令牌、记录、用药、设备、阈值、告警都还在。
- **部分故障**：analytics 停止时，记录、设备上报、告警照常工作，`GET /api/summary/daily` 与 `/api/trends` 返回 503；analytics 重新启动后，它停止期间的新增与删除最迟 10 秒内反映在统计里。notify 停止时，记录照常工作，`/api/alerts`、`/api/thresholds`、`/api/reminders` 返回 503；notify 重新启动后，停止期间超出阈值的记录最迟 10 秒内产生告警。
- **隔离**：一个用户看不到、改不了另一个用户的任何数据（用别人的 id 一律 404）。

## 4. 交付

- `tests/` 下至少 30 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：如何运行、对外接口一览；`docs/architecture.md`：各服务的职责、数据归属、服务之间的调用与事件、故障时的行为。
