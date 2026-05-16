# PostgreSQL Ops TUI

A retro CRT-style terminal UI for daily PostgreSQL operations.

PostgreSQL Ops TUI is built for database administrators and application operators who need a fast keyboard-driven console for user management, grants, resource checks, troubleshooting, ad-hoc SQL, and reusable SQL scripts.

```text
React + Ink terminal UI
        |
        | stdio JSON-RPC
        v
Python gateway
        |
        +--> docker exec <container> psql ...
        |
        +--> psql -h <host> -p <port> ...
```

## Features

- English UI by default, with Chinese/English toggle via `z`.
- Retro amber terminal style with small cyan/magenta/green status accents.
- Top-level operation menus for users, grants, resource/performance, and troubleshooting.
- Multi-profile PostgreSQL connection picker.
- Docker-based local PostgreSQL profile and generic remote PostgreSQL profiles.
- User and role pickers for operations where selectable values are safer than manual typing.
- Two-tab action forms: variables first, generated SQL preview second.
- Resource health report with current value, reference range, status, and operational meaning.
- Long-running actions show a non-blocking reading indicator before results are displayed.
- Wide table output supports vertical scrolling and fast left/right column expansion.
- SQL editor modal with multi-line paste, cursor movement, SQL highlighting, and psql meta-command support.
- Custom SQL script directory with an arrow-key script picker.

## Screens

The TUI is organized around four operation menus:

- `1 Users`: list roles, create users, drop users, reset passwords.
- `2 Grants`: grant/revoke roles, database privileges, schema privileges, table privileges, default privileges.
- `3 Resource/Perf`: resource health, database sizes, active sessions, index usage, table health, wait events.
- `4 Troubleshooting`: blocking graph, ungranted locks, long transactions, terminate backend PID, checkpoint.

## Requirements

- Node.js 20+
- Python 3.11+
- Docker, if using the default local-container profile
- Local `psql` on `PATH`, if using a remote PostgreSQL profile
- A reachable PostgreSQL server

## Quick Start

Install dependencies:

```powershell
npm install
```

Start the TUI:

```powershell
npm start
```

Run checks:

```powershell
npm run type-check
npm run test:py
python -m py_compile pg_ops_tui\pg_gateway.py
```

## Connection Profiles

Connection profiles live in [config/pg_connections.json](config/pg_connections.json).

The bundled config is intentionally safe for publication: it contains a local Docker example and a remote placeholder that reads its password from an environment variable.

Docker profile:

```json
{
  "id": "local-docker",
  "label": "Local Docker PG",
  "mode": "docker",
  "container": "tui-linux-admin",
  "database": "postgres",
  "user": "postgres"
}
```

Remote profile:

```json
{
  "id": "remote-example",
  "label": "Remote PG example",
  "mode": "postgres",
  "host": "192.0.2.10",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password_env": "PG_TUI_REMOTE_PASSWORD",
  "sslmode": "prefer"
}
```

Prefer `password_env` so secrets stay outside the repository.

You can use a private config file instead of the repository config:

```powershell
$env:PG_TUI_CONFIG = "D:\private\pg_connections.json"
```

Legacy Docker-only overrides are still supported when no config file exists:

```powershell
$env:PG_TUI_CONTAINER = "your-postgres-container"
$env:OPS_CONTAINER = "your-postgres-container"
```

## SQL Scripts

Custom scripts live in [sql_scripts](sql_scripts) by default. Add `.sql` files there, then press `p` in the TUI to choose a script and execute it.

The first `-- comment` line in a script is shown as its description in the picker.

You can change the script directory in `config/pg_connections.json`:

```json
{
  "scripts_dir": "D:/private/pg_scripts"
}
```

## Controls

General controls:

- `1` open the user-management menu
- `2` open the grants/privileges menu
- `3` open the resource/performance menu
- `4` open the daily troubleshooting menu
- `o` open the connection picker
- `p` open the custom SQL script picker
- `i` open the SQL editor
- `z` toggle Chinese/English labels
- `r` refresh
- `c` request a PostgreSQL checkpoint
- `q` quit
- `Up/Down` scroll output vertically
- `Left/Right` expand or collapse table column widths quickly

Menu controls:

- `1/2/3/4` switch top-level menus
- `Arrow keys` move the menu selection
- `Enter` runs the selected action
- Item shortcut keys such as `L`, `A`, or `D` run directly
- `Esc` closes the menu

Action modal controls:

- `Tab` opens a picker for lookup fields such as users or roles
- `Tab` switches between variables and SQL preview on normal fields
- `Up/Down` moves between fields
- `Left/Right` cycles finite options
- `Space` toggles boolean fields
- `Ctrl+R` runs the generated SQL
- `Esc` closes the modal

SQL editor controls:

- Paste multi-line SQL directly
- `Arrow keys` move the cursor
- `Enter` inserts a newline, or executes when the buffer starts with `\` or ends with `;`
- `Ctrl+R` executes the current editor buffer
- `Ctrl+U` clears the editor buffer
- `Esc` closes the editor
- `Backspace` and `Delete` edit text normally

## PostgreSQL Grants Model

PostgreSQL uses roles for both users and permission groups. A role with `LOGIN` behaves like a user. A role without `LOGIN` is commonly used as a grant group.

Common patterns:

- `GRANT app_readonly TO app_user;`
- `REVOKE app_readonly FROM app_user;`
- `GRANT CONNECT ON DATABASE appdb TO app_user;`
- `GRANT USAGE ON SCHEMA public TO app_user;`
- `GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_user;`
- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_user;`

## Notes

- Remote profiles use normal `psql`; host CPU, memory, and filesystem metrics are not available through plain SQL. The health report marks those host-level rows as informational for remote connections.
- The bundled config and scripts are examples only. Keep production hostnames, passwords, and private SQL scripts in a private config/script directory.

## License

MIT

---

# PostgreSQL Ops TUI 中文说明

PostgreSQL Ops TUI 是一个复古 CRT 风格的 PostgreSQL 运维终端，适合日常数据库巡检、用户管理、授权管理、资源/性能体检、故障排查、自定义 SQL 和脚本执行。

## 功能

- 默认英文界面，按 `z` 可切换中英文。
- 顶部菜单按运维场景拆分为用户、授权、资源/性能、日常排障。
- 支持多个 PostgreSQL 连接配置，按 `o` 弹窗选择连接。
- 支持 Docker 本地 PostgreSQL，也支持通用远程 PostgreSQL 连接。
- 用户、角色等有限选项优先使用弹窗选择，减少手输错误。
- 需要变量的操作使用双页签弹窗：填写变量和预览 SQL。
- 资源体检按“当前值 / 阈值范围 / 状态 / 含义”展示，不只是简单查数据。
- 慢查询或慢读取会先显示读取动画，避免误以为操作未生效。
- 宽表支持上下滚动和左右快速扩展列宽，长字段会逐步展开。
- 内置 SQL 编辑器，支持多行粘贴、光标移动、SQL 高亮和常见 psql 元命令。
- 支持 SQL 脚本目录，按 `p` 用方向键选择脚本并执行。

## 安装启动

```powershell
npm install
npm start
```

## 连接配置

连接配置文件是 [config/pg_connections.json](config/pg_connections.json)。

推荐把真实生产连接放到私有配置文件里，然后用环境变量指定：

```powershell
$env:PG_TUI_CONFIG = "D:\private\pg_connections.json"
```

远程连接建议使用 `password_env`，不要把密码写进仓库：

```json
{
  "id": "remote-example",
  "label": "Remote PG example",
  "mode": "postgres",
  "host": "192.0.2.10",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password_env": "PG_TUI_REMOTE_PASSWORD",
  "sslmode": "prefer"
}
```

## 自定义脚本

默认脚本目录是 [sql_scripts](sql_scripts)。把 `.sql` 文件放进去后，在 TUI 中按 `p` 选择执行。

脚本第一行 `-- 注释` 会作为弹窗里的说明文字。

## 常用快捷键

- `1` 用户管理
- `2` 授权管理
- `3` 资源/性能
- `4` 日常排障
- `o` 选择连接
- `p` 选择 SQL 脚本
- `i` 打开 SQL 编辑器
- `z` 中英文切换
- `r` 刷新
- `q` 退出
- `Up/Down` 上下滚动输出
- `Left/Right` 快速扩展或收回表格列宽

## 脱敏说明

仓库内只保留模板配置和示例 SQL。真实主机名、IP、密码、生产 SQL 脚本建议放在私有路径，并通过 `PG_TUI_CONFIG` 和 `password_env` 注入。
