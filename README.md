# PostgreSQL Ops TUI

A retro amber CRT-style PostgreSQL operations console built as a small Hermes-style TUI:

```text
React + Ink terminal UI
        |
        | stdio JSON-RPC
        v
Python gateway
        |
        v
docker exec <container> psql ...
```

The UI is focused on daily PostgreSQL troubleshooting: activity, locks, waits, table health, index usage, database sizing, psql meta-commands, and ad-hoc SQL.

## Features

- Amber CRT terminal theme with Chinese/English UI toggle.
- Top status strip with PostgreSQL metrics: connections, active sessions, waits, locks, blocked sessions, and database size.
- One-key troubleshooting probes:
  - `a` active sessions
  - `b` blocked/blocking sessions
  - `w` wait events
  - `l` ungranted locks
  - `x` long transactions
  - `s` database sizes
  - `t` table health
  - `n` index usage
  - `g` incident logging settings
- Full-width output area with vertical and horizontal scrolling.
- Centered SQL editor modal with multi-line paste, cursor movement, scrollbars, and lightweight SQL highlighting.
- psql meta-command support for commands such as `\dv`, `\d name`, `\di`, `\df`, `\du`, `\dn`, and `\?`.

## Requirements

- Node.js 20+
- Python 3.11+
- Docker
- A running PostgreSQL container with `psql` available inside it

The default container name is `tui-linux-admin`. Override it with:

```powershell
$env:PG_TUI_CONTAINER = "your-postgres-container"
```

or:

```powershell
$env:OPS_CONTAINER = "your-postgres-container"
```

## Quick Start

Install Node dependencies:

```powershell
npm install
```

Smoke-check the gateway:

```powershell
npm run smoke
```

Launch the TUI:

```powershell
npm start
```

## Controls

General controls:

- `a/b/w/l/x/s/t/n/g` run troubleshooting probes
- `i` open the SQL editor modal
- `z` toggle Chinese/English labels
- `r` refresh
- `c` request a PostgreSQL checkpoint
- `q` quit
- `Up/Down` scroll output vertically
- `Left/Right` pan output horizontally

SQL editor controls:

- Paste multi-line SQL directly; formatting is preserved
- `Arrow keys` move the editor cursor
- `Enter` inserts a newline, or executes when the buffer starts with `\` or ends with `;`
- `Ctrl+R` executes the current editor buffer
- `Ctrl+U` clears the editor buffer
- `Esc` closes the editor modal
- `Backspace` deletes the character before the cursor
- `Delete` deletes the character after the cursor

## Python Checks

```powershell
python -m unittest discover -s tests
```

## License And Hermes Relationship

This project is licensed under the MIT License.

It was inspired by Hermes Agent's architecture: a React/Ink terminal UI talking to a Python backend over stdio JSON-RPC. No Hermes Agent source code or private `@hermes/ink` package code is copied into this repository.

Hermes Agent is also MIT licensed, but this project is an independent implementation using public dependencies (`ink`, `react`, `tsx`, and Python standard-library modules).
