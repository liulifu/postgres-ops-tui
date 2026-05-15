from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from time import perf_counter
from typing import Any


DEFAULT_CONTAINER = "tui-linux-admin"


@dataclass
class DatabaseStat:
    name: str
    connections: int
    commits: int
    rollbacks: int
    size: str


@dataclass
class Activity:
    pid: int
    user: str
    database: str
    state: str
    wait: str
    query: str


@dataclass
class LockStat:
    locktype: str
    mode: str
    granted: str
    count: int


@dataclass
class Metric:
    label: str
    value: int


@dataclass
class Snapshot:
    container: str
    server_version: str
    collected_at: str
    databases: list[DatabaseStat]
    activity: list[Activity]
    locks: list[LockStat]
    metrics: list[Metric]
    logs: list[str]


@dataclass
class Probe:
    key: str
    title: str
    sql: str


def load_snapshot(container: str | None = None) -> Snapshot:
    target = container or os.environ.get("PG_TUI_CONTAINER") or os.environ.get("OPS_CONTAINER", DEFAULT_CONTAINER)
    return Snapshot(
        container=target,
        server_version=_scalar(target, "select version();"),
        collected_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        databases=_database_stats(target),
        activity=_activity(target),
        locks=_locks(target),
        metrics=_metrics(target),
        logs=_docker(["logs", "--tail", "10", target]).splitlines()[-10:],
    )


def request_checkpoint(container: str | None = None) -> str:
    target = container or os.environ.get("PG_TUI_CONTAINER") or os.environ.get("OPS_CONTAINER", DEFAULT_CONTAINER)
    _psql(target, "checkpoint;")
    return f"checkpoint requested on {target}"


PROBES: dict[str, Probe] = {
    "a": Probe(
        "a",
        "Active sessions",
        """
        select pid, usename, datname, state, wait_event_type, now() - query_start as age,
               left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 120) as query
        from pg_stat_activity
        where state <> 'idle' or wait_event_type is not null
        order by query_start nulls last
        limit 20;
        """,
    ),
    "b": Probe(
        "b",
        "Blocked by / blocking",
        """
        select blocked.pid as blocked_pid,
               blocked.usename as blocked_user,
               now() - blocked.query_start as blocked_age,
               blocking.pid as blocking_pid,
               blocking.usename as blocking_user,
               left(regexp_replace(blocked.query, E'[\\n\\r\\t]+', ' ', 'g'), 80) as blocked_query,
               left(regexp_replace(blocking.query, E'[\\n\\r\\t]+', ' ', 'g'), 80) as blocking_query
        from pg_stat_activity blocked
        join lateral unnest(pg_blocking_pids(blocked.pid)) blocker_pid on true
        join pg_stat_activity blocking on blocking.pid = blocker_pid
        order by blocked.query_start nulls last;
        """,
    ),
    "w": Probe(
        "w",
        "Wait events",
        """
        select coalesce(wait_event_type, 'none') as wait_type,
               coalesce(wait_event, 'none') as wait_event,
               count(*) as sessions
        from pg_stat_activity
        group by 1, 2
        order by sessions desc, wait_type, wait_event;
        """,
    ),
    "l": Probe(
        "l",
        "Ungranted locks",
        """
        select a.pid, a.usename, l.locktype, l.mode, l.relation::regclass as relation,
               now() - a.query_start as age,
               left(regexp_replace(a.query, E'[\\n\\r\\t]+', ' ', 'g'), 120) as query
        from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where not l.granted
        order by a.query_start nulls last;
        """,
    ),
    "x": Probe(
        "x",
        "Long transactions",
        """
        select pid, usename, datname, state, now() - xact_start as xact_age,
               left(regexp_replace(query, E'[\\n\\r\\t]+', ' ', 'g'), 120) as query
        from pg_stat_activity
        where xact_start is not null
        order by xact_start
        limit 20;
        """,
    ),
    "s": Probe(
        "s",
        "Database sizes",
        """
        select datname, pg_size_pretty(pg_database_size(datname)) as size,
               pg_database_size(datname) as bytes
        from pg_database
        where not datistemplate
        order by pg_database_size(datname) desc;
        """,
    ),
    "t": Probe(
        "t",
        "Table health",
        """
        select schemaname, relname, n_live_tup, n_dead_tup,
               last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
        from pg_stat_user_tables
        order by n_dead_tup desc, n_live_tup desc
        limit 20;
        """,
    ),
    "n": Probe(
        "n",
        "Index usage",
        """
        select schemaname, relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
        from pg_stat_user_indexes
        order by idx_scan asc, idx_tup_read desc
        limit 20;
        """,
    ),
    "g": Probe(
        "g",
        "Incident logging settings",
        """
        select name, setting, unit, short_desc
        from pg_settings
        where name in (
            'log_min_duration_statement',
            'log_lock_waits',
            'deadlock_timeout',
            'log_temp_files',
            'log_checkpoints'
        )
        order by name;
        """,
    ),
}


def probe_menu() -> list[dict[str, str]]:
    return [{"key": probe.key, "title": probe.title} for probe in PROBES.values()]


def run_probe(key: str, container: str | None = None) -> dict[str, str]:
    target = container or os.environ.get("PG_TUI_CONTAINER") or os.environ.get("OPS_CONTAINER", DEFAULT_CONTAINER)
    probe = PROBES.get(key)
    if probe is None:
        raise ValueError(f"unknown probe: {key}")
    started = perf_counter()
    output = _psql_table(target, probe.sql)
    return {"title": probe.title, "sql": " ".join(probe.sql.split()), "output": _with_elapsed(output, started)}


def run_sql(sql: str, container: str | None = None) -> dict[str, str]:
    target = container or os.environ.get("PG_TUI_CONTAINER") or os.environ.get("OPS_CONTAINER", DEFAULT_CONTAINER)
    statement = sql.strip()
    if not statement:
        raise ValueError("empty SQL")
    started = perf_counter()
    if _is_psql_meta_command(statement):
        return {"title": "psql", "sql": statement, "output": _with_elapsed(_psql_meta(target, statement), started)}
    return {"title": "SQL", "sql": statement, "output": _with_elapsed(_psql_table(target, statement), started)}


def _database_stats(container: str) -> list[DatabaseStat]:
    sql = """
        select d.datname,
               s.numbackends,
               s.xact_commit,
               s.xact_rollback,
               pg_size_pretty(pg_database_size(d.datname))
        from pg_database d
        join pg_stat_database s on s.datid = d.oid
        where not d.datistemplate
        order by d.datname;
    """
    rows = []
    for row in _rows(container, sql):
        if len(row) < 5:
            continue
        rows.append(DatabaseStat(row[0], _int(row[1]), _int(row[2]), _int(row[3]), row[4]))
    return rows


def _activity(container: str) -> list[Activity]:
    sql = """
        select pid,
               coalesce(usename, ''),
               coalesce(datname, ''),
               coalesce(state, ''),
               coalesce(wait_event_type, ''),
               left(regexp_replace(coalesce(query, ''), E'[\\n\\r\\t]+', ' ', 'g'), 90)
        from pg_stat_activity
        order by pid
        limit 12;
    """
    rows = []
    for row in _rows(container, sql):
        if len(row) < 6:
            continue
        rows.append(Activity(_int(row[0]), row[1], row[2], row[3], row[4] or "-", row[5]))
    return rows


def _locks(container: str) -> list[LockStat]:
    sql = """
        select locktype, mode, granted::text, count(*)
        from pg_locks
        group by locktype, mode, granted
        order by count(*) desc, locktype, mode
        limit 8;
    """
    rows = []
    for row in _rows(container, sql):
        if len(row) < 4:
            continue
        rows.append(LockStat(row[0], row[1], row[2], _int(row[3])))
    return rows


def _metrics(container: str) -> list[Metric]:
    sql = """
        select 'connections', count(*) from pg_stat_activity
        union all
        select 'active', count(*) from pg_stat_activity where state = 'active'
        union all
        select 'waiting', count(*) from pg_stat_activity where wait_event_type is not null
        union all
        select 'locks', count(*) from pg_locks
        union all
        select 'blocked', count(*) from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0
        union all
        select 'db_mb', coalesce(sum(pg_database_size(datname)) / 1024 / 1024, 0)
        from pg_database
        where not datistemplate;
    """
    rows = []
    for row in _rows(container, sql):
        if len(row) < 2:
            continue
        rows.append(Metric(row[0], _int(row[1])))
    return rows


def _scalar(container: str, sql: str) -> str:
    rows = _rows(container, sql)
    return rows[0][0] if rows and rows[0] else ""


def _rows(container: str, sql: str) -> list[list[str]]:
    output = _psql(container, sql)
    rows = []
    for line in output.splitlines():
        if line.strip():
            rows.append(line.split("|"))
    return rows


def _psql(container: str, sql: str) -> str:
    return _docker([
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-tA",
        "-F",
        "|",
        "-c",
        " ".join(sql.split()),
    ])


def _psql_table(container: str, sql: str) -> str:
    output = _docker([
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-X",
        "--csv",
        "-P",
        "footer=off",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        " ".join(sql.split()),
    ])
    rendered = _render_csv_table(output)
    return rendered[-12000:] if rendered else output[-12000:]


def _psql_meta(container: str, command: str) -> str:
    normalized = command.strip()
    if normalized == r"\q":
        return r"\q closes an interactive psql session. Use q to quit this TUI."
    if normalized.startswith(r"\timing"):
        return "Timing is measured automatically for every command in this TUI."
    if normalized.startswith(r"\x"):
        return r"\x changes formatting inside an interactive psql session. This TUI keeps tabular output stable and supports horizontal scrolling instead."
    return _docker_output([
        "exec",
        "-e",
        "COLUMNS=1000",
        container,
        "psql",
        "-U",
        "postgres",
        "-X",
        "-P",
        "pager=off",
        "-P",
        "columns=1000",
        "-P",
        "linestyle=ascii",
        "-c",
        normalized,
    ])[-12000:]


def _is_psql_meta_command(statement: str) -> bool:
    return statement.lstrip().startswith("\\")


def _with_elapsed(output: str, started: float) -> str:
    elapsed_ms = (perf_counter() - started) * 1000
    return f"{output.rstrip()}\n\nTime: {elapsed_ms:.1f} ms"


def _render_csv_table(output: str) -> str:
    rows = list(csv.reader(io.StringIO(output)))
    if not rows:
        return ""
    if len(rows) == 1 and len(rows[0]) == 1:
        return rows[0][0]
    normalized = [[_clean_cell(cell) for cell in row] for row in rows]
    column_count = max(len(row) for row in normalized)
    for row in normalized:
        row.extend([""] * (column_count - len(row)))
    widths = [
        min(80, max(len(row[index]) for row in normalized))
        for index in range(column_count)
    ]
    rule = "+" + "+".join("-" * (width + 2) for width in widths) + "+"
    lines = [rule, _format_row(normalized[0], widths), rule]
    for row in normalized[1:]:
        lines.append(_format_row(row, widths))
    lines.append(rule)
    lines.append(f"{max(0, len(normalized) - 1)} row(s)")
    return "\n".join(lines)


def _format_row(row: list[str], widths: list[int]) -> str:
    cells = []
    for cell, width in zip(row, widths):
        value = cell[: width - 3] + "..." if len(cell) > width and width > 3 else cell[:width]
        cells.append(f" {value.ljust(width)} ")
    return "|" + "|".join(cells) + "|"


def _clean_cell(value: str) -> str:
    return " ".join(value.split())


def _docker(args: list[str]) -> str:
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT)


def _docker_output(args: list[str]) -> str:
    completed = subprocess.run(
        ["docker", *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return completed.stdout


def _int(value: str) -> int:
    try:
        return int(float(value))
    except ValueError:
        return 0


def _reply(request_id: Any, result: Any = None, error: str | None = None) -> None:
    payload = {"jsonrpc": "2.0", "id": request_id}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = {"message": error}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def serve() -> None:
    print(json.dumps({"jsonrpc": "2.0", "method": "gateway.ready", "params": {"container": DEFAULT_CONTAINER}}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            if method == "snapshot":
                _reply(request.get("id"), asdict(load_snapshot(request.get("params", {}).get("container"))))
            elif method == "probe_menu":
                _reply(request.get("id"), probe_menu())
            elif method == "run_probe":
                params = request.get("params", {})
                _reply(request.get("id"), run_probe(params.get("key", ""), params.get("container")))
            elif method == "run_sql":
                params = request.get("params", {})
                _reply(request.get("id"), run_sql(params.get("sql", ""), params.get("container")))
            elif method == "checkpoint":
                _reply(request.get("id"), {"message": request_checkpoint(request.get("params", {}).get("container"))})
            else:
                _reply(request.get("id"), error=f"unknown method: {method}")
        except Exception as exc:  # The TUI should show errors instead of crashing the gateway.
            _reply(None, error=str(exc))


def main() -> None:
    if "--print" in sys.argv:
        print(json.dumps(asdict(load_snapshot()), ensure_ascii=False, indent=2))
        return
    serve()


if __name__ == "__main__":
    main()
