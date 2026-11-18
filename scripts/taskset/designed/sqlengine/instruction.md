# sqlengine 规格：与 SQLite 兼容的 SQL 引擎

在当前目录从零实现一个关系数据库引擎（"数据库系统"课程设计 / 毕业设计规模），SQL 的语法与语义按 **SQLite 3**（<https://www.sqlite.org/lang.html>）。只用 Python 3 标准库，不安装任何包；**不得使用 `sqlite3` 模块**及任何现成的数据库（包括 `dbm`、`shelve`），不得调用外部程序（不得使用 `subprocess`、`os.system`、`os.exec*`、`os.spawn*`、`os.popen`、`pty`）。运行环境没有外网。包名 `sqlengine`。

## 1. 命令行与输出

```
python3 -m sqlengine <数据库目录>
```

从标准输入读入 SQL 脚本（以分号分隔的语句；字符串、注释中的分号不算），依次执行；数据库目录不存在时创建，数据保存在目录中，下次打开时仍在。

- 每条返回行的语句（`SELECT`、`VALUES`、`WITH ... SELECT`、带 `RETURNING` 的语句）：每行输出一行，同一行的值用 `|` 连接；值的写法：NULL 写 `NULL`，整数写十进制，实数按 Python 的 `repr(float)`，文本原样，BLOB 写 `x'<小写十六进制>'`。不输出列名。
- 不返回行的语句不输出。
- 语句出错时输出一行 `error`（错误原因不要求），该语句没有任何效果，然后继续执行下一条语句。
- 退出码 0。

## 2. 要求

除上面规定的输出格式以外，每条语句的结果（返回的行与顺序、出错与否、对数据的影响）**与 SQLite（Python 3.12 自带的 `sqlite3` 模块，SQLite 3.46）执行同一语句相同**；没有 `ORDER BY` 时行的顺序不限（评测会排序后比较）。要实现：

- **语句**：`CREATE TABLE`（列类型名与**类型亲和性**规则、`PRIMARY KEY`（含 `INTEGER PRIMARY KEY` 作为 rowid 别名与自增）、`NOT NULL`、`UNIQUE`、`DEFAULT`、`CHECK`、表级约束、`IF NOT EXISTS`、`CREATE TABLE ... AS SELECT`）、`DROP TABLE`、`ALTER TABLE ... ADD COLUMN / RENAME TO / RENAME COLUMN`、`CREATE [UNIQUE] INDEX`、`DROP INDEX`、`CREATE VIEW` / `DROP VIEW`、`INSERT`（`VALUES` 多行、`INSERT ... SELECT`、`DEFAULT VALUES`、`OR REPLACE`/`OR IGNORE`、`ON CONFLICT ... DO NOTHING / DO UPDATE`（upsert）、`RETURNING`）、`UPDATE`（含 `FROM`、`RETURNING`）、`DELETE`（含 `RETURNING`）、`BEGIN`/`COMMIT`/`ROLLBACK`、`SAVEPOINT`/`RELEASE`/`ROLLBACK TO`。
- **查询**：`SELECT [DISTINCT]`、`*` 与 `表.*`、别名、`FROM` 多表、`[INNER] JOIN`、`LEFT [OUTER] JOIN`、`CROSS JOIN`、`NATURAL JOIN`、`USING`、子查询作为表、`WHERE`、`GROUP BY`、`HAVING`、`ORDER BY`（含 `NULLS FIRST/LAST`、按序号与别名、`COLLATE NOCASE`）、`LIMIT`/`OFFSET`、`UNION [ALL]`、`INTERSECT`、`EXCEPT`、`VALUES` 子句、`WITH`（含 `RECURSIVE`）、标量子查询、`IN (子查询)`、`EXISTS`、相关子查询。
- **窗口函数**：`OVER (PARTITION BY ... ORDER BY ...)`，`row_number rank dense_rank ntile lag lead first_value last_value` 以及聚合函数作窗口函数（含 `ROWS BETWEEN` 框架）。
- **表达式与类型**：SQLite 的动态类型、存储类型（NULL、INTEGER、REAL、TEXT、BLOB）、比较规则与亲和性转换、三值逻辑、整数溢出变为实数、整数除法、`||`、`CASE`、`CAST`、`LIKE`（含 `ESCAPE`）、`GLOB`、`BETWEEN`、`IN`、`IS [NOT]`、`IS [NOT] DISTINCT FROM`、`COLLATE`、blob 字面量 `x'..'`、位运算。
- **函数**：`abs changes char coalesce format glob hex ifnull iif instr length like lower ltrim max min nullif printf quote random replace round rtrim sign substr substring trim typeof unhex unicode upper zeroblob`，数学函数 `ceil floor sqrt pow mod exp ln log log10 log2 pi`，聚合 `avg count group_concat max min sum total`（含 `DISTINCT` 与 `FILTER (WHERE ...)`），日期时间 `date time datetime julianday strftime unixepoch`（输入为给定的时间值与修饰符；不要求 `'now'`）。`random()` 不要求结果相同。
- 不要求：触发器、外键的强制、`PRAGMA`、`ATTACH`、全文检索、JSON 函数、`EXPLAIN`。

## 3. 性能

在 2 个 CPU 的机器上：插入 10 万行（一个事务）在 30 秒内完成；之后带索引的等值查询在 2 秒内返回（含进程启动与打开数据库），两个各 1 万行的表做等值连接在 20 秒内完成。

## 4. 交付

- `tests/` 下至少 40 个单元测试，`python3 -m unittest discover -s tests -t .` 全部通过。
- `README.md`：用法；`docs/design.md`：存储、解析、查询计划与执行、类型与亲和性的设计。
- 完成后把全部改动提交到 git（当前目录是一个 git 仓库）。
