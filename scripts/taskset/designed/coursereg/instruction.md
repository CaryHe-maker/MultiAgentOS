# coursereg 规格：教务选课系统后端

在当前目录从零实现一个教务选课系统的后端：HTTP + JSON 接口，数据存在磁盘上。只用 Python 3 标准库，不安装任何包。包名 `coursereg`，启动命令：

```
python3 -m coursereg --port <端口> --data <数据目录>
```

监听 `127.0.0.1:<端口>`，数据目录不存在时创建。服务启动完成（可以接受请求）之前不得返回或打印 `ready`；完成后在标准输出打印一行 `ready`。

## 1. 通则

- 请求与响应的正文都是 JSON（UTF-8）。成功时状态码见各接口；出错时返回 `{"error": "<错误码>"}`，错误码与状态码：
  `invalid`（400，请求格式或取值不对）、`unauthorized`（401）、`bad_credentials`（401）、`forbidden`（403）、`not_found`（404）、`conflict`（409，重复）、`bad_state`（409，学期状态不允许）以及第 5 节的业务错误码（都是 409）。
- 未知路径或方法：404 `not_found`。正文不是合法 JSON 对象，或缺字段、字段类型不对：400 `invalid`。
- 检查顺序：认证（401）→ 路径中的对象是否存在（404）→ 权限（403）→ 请求正文与取值（400）→ 正文中引用的对象是否存在（404，如选课时的课程、建课时的学期）→ 状态与业务规则（409）。
- 除 `POST /login` 外，所有请求都要带 `Authorization: Bearer <令牌>`；没有或无效：401 `unauthorized`。
- 每个修改数据的请求在返回成功之前已经持久化：此后进程被 `kill -9`，重启后这个修改仍在。任何时刻被杀掉，重启后数据都一致（不会出现半个修改）。并发请求的结果与按某个先后顺序逐个执行相同。

## 2. 用户与登录

- 数据目录为空时，系统里有一个管理员：用户名 `admin`，密码 `admin`，姓名 `Administrator`。
- `POST /login` `{"username", "password"}` → 200 `{"token": <字符串>, "role": <角色>, "id": <用户 id>}`；用户名或密码不对：401 `bad_credentials`。令牌一直有效（重启后也有效）。
- `POST /users`（管理员）`{"username", "password", "role", "name"}` → 201 用户对象 `{"id", "username", "role", "name"}`。`username` 须匹配 `[a-z0-9_]{3,20}`，`role` 为 `admin`、`teacher`、`student` 之一，`password` 与 `name` 为非空字符串，否则 400；用户名已存在：409 `conflict`。`id` 为正整数，按创建顺序从 1 起（`admin` 是 1）。
- `GET /users/{id}`（管理员，或本人）→ 200 用户对象。

## 3. 学期

- `POST /semesters`（管理员）`{"code"}` → 201 `{"code", "state": "planning"}`。`code` 须匹配 `[0-9]{4}S[12]`（如 `2026S1`），否则 400；已存在：409 `conflict`。
- `POST /semesters/{code}/state`（管理员）`{"state"}` → 200 `{"code", "state"}`。状态只能按 `planning → open → closed → graded` 向前走一步，否则 409 `bad_state`（取值不在这四个里：400）。
- `GET /semesters`（任何已登录用户）→ 200 `{"items": [{"code", "state"}, ...]}`，按 `code` 升序。

## 4. 课程

课程对象：`{"semester", "code", "title", "credits", "capacity", "teacher", "slots", "prereqs", "enrolled", "waitlisted"}`。`enrolled` 与 `waitlisted` 是当前选上与候补的人数。

- `POST /courses`（管理员）`{"semester", "code", "title", "credits", "capacity", "teacher", "slots", "prereqs"}` → 201 课程对象。
  - `code` 须匹配 `[A-Z]{2,4}[0-9]{3}`；`title` 非空；`credits` 为 1–6 的整数；`capacity` 为至少 1 的整数；`teacher` 是某个教师用户的 id；`slots` 为非空列表，每项 `{"day": 1–5 的整数, "start": "HH:MM", "end": "HH:MM"}`，`start` 早于 `end`，同一课程的各项互不重叠；`prereqs` 为课程代码列表（可为空，代码格式同上，不必已存在）。不满足：400 `invalid`。
  - 学期不存在：404 `not_found`；学期不在 `planning`：409 `bad_state`；同学期同代码已存在：409 `conflict`。
- `GET /courses?semester=&teacher=&q=&page=&per_page=`（任何已登录用户）→ 200 `{"items": [...], "total": <符合条件的总数>}`。条件都可省略：`semester` 精确匹配；`teacher` 为教师 id；`q` 不区分大小写地出现在 `code` 或 `title` 中。按 (`semester`, `code`) 升序；`page` 从 1 起（缺省 1），`per_page` 1–100（缺省 20），取值不对：400。
- `GET /courses/{semester}/{code}` → 200 课程对象。
- `PATCH /courses/{semester}/{code}`（管理员）`{"capacity"}` → 200 课程对象。只在 `planning` 或 `open` 时允许（否则 409 `bad_state`）；新容量小于已选人数：409 `capacity_below_enrolled`。容量增加时按第 5 节的规则从候补中递补。

## 5. 选课（学生本人，学期须为 `open`）

- `POST /enrollments` `{"semester", "code"}`：不是学生 403；正文不对 400；课程不存在 404；之后按下面的顺序检查，第一个不满足的给出错误（都是 409）：
  1. 学期不是 `open`：`bad_state`；
  2. 已选上或已在候补中：`already_enrolled`；
  3. 已在某个 `graded` 学期以 60 分及以上通过同代码的课程：`already_passed`；
  4. 先修课：每个先修代码都须在某个 `graded` 学期以 60 分及以上通过，否则 `prereq_missing`；
  5. 与本学期已选上（不含候补）的课程时间冲突：`schedule_conflict`（同一天、时间区间重叠，即 `start < 对方 end` 且 `对方 start < end`；首尾相接不算重叠）；
  6. 本学期已选上（不含候补）的学分加上这门课超过 25：`credit_limit`。
  通过后：有空位则选上，201 `{"status": "enrolled"}`；没有空位则排到候补队尾，201 `{"status": "waitlisted", "position": <在候补中的位置，从 1 起>}`。
- `DELETE /enrollments/{semester}/{code}`（学生本人，学期须为 `open`）：退选或退出候补，200 `{"status": "dropped"}`；没有选上也不在候补中：404 `not_found`。
- **递补**：每当有空位（有人退选或容量增加），按候补顺序找第一个"此刻满足第 5、6 条"的学生选上，重复直到没有空位或候补中没有满足的人；不满足的人留在候补中原来的相对位置。
- `GET /students/{id}/schedule?semester=`（本人或管理员；`semester` 必填，学期不存在 404）→ 200 `{"enrolled": [{"code", "title", "credits", "slots"}], "waitlisted": [{"code", "position"}], "credits": <已选上学分合计>}`，两个列表都按 `code` 升序。

## 6. 名单与成绩

- `GET /courses/{semester}/{code}/roster`（该课教师或管理员）→ 200 `{"enrolled": [{"id", "username", "name"}], "waitlist": [{"id", "username", "name"}]}`：`enrolled` 按 `username` 升序，`waitlist` 按候补顺序。
- `PUT /courses/{semester}/{code}/grades`（该课教师；学期须为 `closed`，否则 409 `bad_state`）`{"grades": {"<学生 id>": <0–100 的整数>, ...}}` → 200 `{"updated": <条数>}`。有任何一个学生不是这门课的选上者、或分数不合法：400 `invalid`，整个请求不生效。可重复提交，后提交的覆盖先前的。
- `GET /students/{id}/transcript`（本人或管理员）→ 200 `{"courses": [...], "gpa": <数>, "credits_earned": <整数>}`：
  - `courses` 只含 `graded` 学期中有分数的课程，每项 `{"semester", "code", "title", "credits", "score", "points"}`，按 (`semester`, `code`) 升序。
  - 绩点 `points`：90–100 为 4.0；85–89 为 3.7；82–84 为 3.3；78–81 为 3.0；75–77 为 2.7；72–74 为 2.3；68–71 为 2.0；64–67 为 1.5；60–63 为 1.0；60 以下为 0.0。
  - `gpa` 为按学分加权的绩点平均，四舍五入（.5 进位）到 2 位小数；没有课程时为 0.0。所有修读记录都计入（重修的不及格记录也算）。`credits_earned` 为 60 分及以上课程的学分和。

## 7. 统计

- `GET /reports/semester/{code}`（管理员）→ 200 `{"courses": <课程数>, "enrolled": <选上人次>, "waitlisted": <候补人次>, "full": [<选上数等于容量的课程代码，升序>], "fill_rate": <各课程 选上数/容量 的平均，四舍五入到 2 位小数；没有课程为 0.0>}`。
- `GET /reports/top-students?semester=&n=`（管理员；学期须为 `graded`，否则 409 `bad_state`；`n` 为 1–100，缺省 10）→ 200 `{"items": [{"id", "username", "gpa"}]}`：只算这个学期内有分数的课程的学期 GPA（规则同上），没有分数的学生不列出；按 `gpa` 降序、`username` 升序，取前 `n` 个。

## 8. 性能

在 2 个 CPU 的机器上，有 300 个学生、60 门课时，顺序发出的 1000 个选课请求在 30 秒内全部完成；50 个并发的选课请求在 10 秒内全部完成。

## 9. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：启动方式与全部接口；`docs/design.md`：数据模型、持久化与并发、递补规则的实现。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
