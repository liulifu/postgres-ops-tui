from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any


DEFAULT_CONTAINER = "tui-linux-admin"
CONFIG_PATH = Path(os.environ.get("PG_TUI_CONFIG", "config/pg_connections.json"))
DEFAULT_SCRIPT_DIR = Path(os.environ.get("PG_TUI_SQL_SCRIPTS", "sql_scripts"))
ACTIVE_CONNECTION_ID: str | None = None


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


@dataclass
class HealthItem:
    item: str
    current: str
    reference: str
    status: str
    meaning: str


def connection_profiles() -> list[dict[str, Any]]:
    active_id = _active_connection_id()
    return [
        {
            "value": str(profile.get("id", "")),
            "label": str(profile.get("label") or profile.get("id", "")),
            "description": _connection_description(profile),
            "active": str(profile.get("id", "")) == active_id,
        }
        for profile in _load_connection_profiles()
    ]


def set_connection(connection_id: str) -> dict[str, Any]:
    global ACTIVE_CONNECTION_ID
    profiles = _load_connection_profiles()
    matched = next((profile for profile in profiles if str(profile.get("id", "")) == connection_id), None)
    if matched is None:
        raise ValueError(f"unknown connection: {connection_id}")
    _scalar(matched, "select 1;")
    ACTIVE_CONNECTION_ID = connection_id
    return {
        "value": str(matched.get("id", "")),
        "label": str(matched.get("label") or matched.get("id", "")),
        "description": _connection_description(matched),
    }


def script_choices() -> list[dict[str, str]]:
    root = _scripts_dir().resolve()
    if not root.exists():
        return []
    scripts = []
    for path in sorted(root.rglob("*.sql")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        scripts.append({
            "value": relative,
            "label": relative,
            "description": _script_description(path),
        })
    return scripts


def run_script(script_id: str) -> dict[str, str]:
    path = _safe_script_path(script_id)
    sql = path.read_text(encoding="utf-8").strip()
    if not sql:
        raise ValueError(f"empty script: {script_id}")
    result = run_sql(sql)
    result["title"] = f"Script: {path.name}"
    result["sql"] = script_id
    return result


def load_snapshot(container: str | None = None) -> Snapshot:
    target = _target(container)
    return Snapshot(
        container=_target_name(target),
        server_version=_scalar(target, "select version();"),
        collected_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        databases=_database_stats(target),
        activity=_activity(target),
        locks=_locks(target),
        metrics=_metrics(target),
        logs=_logs(target),
    )


def request_checkpoint(container: str | None = None) -> str:
    target = _target(container)
    _psql(target, "checkpoint;")
    return f"checkpoint requested on {_target_name(target)}"


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


def role_choices(kind: str = "roles", container: str | None = None) -> list[dict[str, str]]:
    target = _target(container)
    where = "where rolcanlogin" if kind == "login_roles" else ""
    sql = f"""
        select rolname,
               case when rolcanlogin then 'user' else 'role' end,
               concat_ws(' ',
                   case when rolsuper then 'SUPERUSER' end,
                   case when rolcreaterole then 'CREATEROLE' end,
                   case when rolcreatedb then 'CREATEDB' end,
                   case when rolreplication then 'REPLICATION' end,
                   case when rolcanlogin then 'LOGIN' else 'NOLOGIN' end
               )
        from pg_roles
        {where}
        order by rolcanlogin desc, rolname;
    """
    return [
        {"value": row[0], "label": row[0], "description": "  ".join(cell for cell in row[1:] if cell)}
        for row in _rows(target, sql)
        if row
    ]


def resource_health(container: str | None = None) -> dict[str, str]:
    target = _target(container)
    items: list[HealthItem] = []
    try:
        items.extend(_host_health(target))
    except Exception as exc:
        items.append(HealthItem("Host resources", "unavailable", "docker stats/df readable", "INFO", str(exc)))
    try:
        items.extend(_postgres_health(target))
    except Exception as exc:
        items.append(HealthItem("PostgreSQL stats", "unavailable", "pg_stat views readable", "INFO", str(exc)))
    output = _render_health_items(items)
    return {
        "title": "Resource health",
        "sql": f"{_target_name(target)} + pg_stat_activity + pg_stat_database + pg_stat_user_tables",
        "output": output,
    }


def _host_health(container: Any) -> list[HealthItem]:
    items: list[HealthItem] = []
    docker_container = _docker_container(container)
    if docker_container is None:
        items.append(HealthItem(
            "Host resources",
            "remote connection",
            "server OS metrics require agent/ssh/exporter",
            "INFO",
            "generic remote psql cannot read CPU, memory, or filesystem pressure directly",
        ))
        return items
    stats = _docker_output([
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.BlockIO}}",
        docker_container,
    ]).strip()
    if stats:
        row = stats.splitlines()[0].split("|")
        if len(row) >= 4:
            cpu_pct = _percent(row[0])
            mem_pct = _percent(row[2])
            items.append(_health(
                "CPU",
                row[0],
                "<70 OK, 70-85 WATCH, >85 HOT",
                cpu_pct,
                [(85, "CRIT"), (70, "WARN")],
                "container CPU pressure; sustained high CPU means query or worker saturation",
            ))
            items.append(_health(
                "Memory",
                f"{row[1]} ({row[2]})",
                "<70 OK, 70-85 WATCH, >85 HOT",
                mem_pct,
                [(85, "CRIT"), (70, "WARN")],
                "memory headroom for shared buffers, work_mem, OS cache, and backends",
            ))
            items.append(HealthItem("Block IO", row[3], "observe trend", "INFO", "large write/read volume suggests checkpoint, vacuum, or scan pressure"))
    else:
        items.append(HealthItem("Container stats", "unavailable", "docker stats readable", "INFO", "unable to read CPU/memory from docker stats"))

    data_dir = _scalar(container, "show data_directory;")
    df = _docker_output(["exec", docker_container, "df", "-Pk", data_dir or "/var/lib/postgresql/data"]).strip().splitlines()
    if len(df) >= 2:
        parts = df[1].split()
        if len(parts) >= 5:
            used_pct = _percent(parts[4])
            items.append(_health(
                "PGDATA disk",
                f"{parts[4]} used, {parts[3]} KB free",
                "<70 OK, 70-85 WATCH, 85-95 LOW, >95 FULL RISK",
                used_pct,
                [(95, "CRIT"), (85, "WARN"), (70, "WATCH")],
                "disk exhaustion can stop writes, WAL, temp files, and autovacuum progress",
            ))
    return items


def _postgres_health(container: Any) -> list[HealthItem]:
    items: list[HealthItem] = []
    rows = _rows(container, """
        select
          count(*)::text,
          count(*) filter (where state = 'active')::text,
          count(*) filter (where wait_event_type is not null)::text,
          count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)::text,
          current_setting('max_connections')
        from pg_stat_activity;
    """)
    if rows and len(rows[0]) >= 5:
        total = _int(rows[0][0])
        active = _int(rows[0][1])
        waiting = _int(rows[0][2])
        blocked = _int(rows[0][3])
        max_conn = max(1, _int(rows[0][4]))
        conn_pct = total / max_conn * 100
        items.append(_health(
            "Connections",
            f"{total}/{max_conn} ({conn_pct:.1f}%), active={active}",
            "<70 OK, 70-85 WATCH, >85 POOL/CONN RISK",
            conn_pct,
            [(85, "CRIT"), (70, "WARN")],
            "connection slots are finite; high usage can reject clients or hide idle leaks",
        ))
        wait_pct = waiting / max(1, total) * 100
        items.append(_health(
            "Waiting sessions",
            f"{waiting}/{total} ({wait_pct:.1f}%), blocked={blocked}",
            "0 OK, 1-10 WATCH, >10 INVESTIGATE",
            wait_pct,
            [(10, "WARN"), (0.1, "WATCH")],
            "waits indicate lock, IO, client, or LWLock pressure; blocked sessions need troubleshooting",
        ))

    db_rows = _rows(container, """
        select
          coalesce(sum(blks_hit),0)::text,
          coalesce(sum(blks_read),0)::text,
          coalesce(sum(xact_commit),0)::text,
          coalesce(sum(xact_rollback),0)::text,
          coalesce(sum(temp_bytes),0)::text,
          pg_size_pretty(coalesce(sum(pg_database_size(db.datname)),0))
        from pg_stat_database d
        join pg_database db on db.datname = d.datname
        where not db.datistemplate;
    """)
    if db_rows and len(db_rows[0]) >= 6:
        hits = _int(db_rows[0][0])
        reads = _int(db_rows[0][1])
        commits = _int(db_rows[0][2])
        rollbacks = _int(db_rows[0][3])
        temp_bytes = _int(db_rows[0][4])
        hit_ratio = hits / max(1, hits + reads) * 100
        rollback_pct = rollbacks / max(1, commits + rollbacks) * 100
        items.append(_inverse_health(
            "Cache hit ratio",
            f"{hit_ratio:.2f}%",
            ">=99 GOOD, 95-99 WATCH, <95 MEMORY/IO PRESSURE",
            hit_ratio,
            [(95, "CRIT"), (99, "WARN")],
            "low hit ratio can mean working set exceeds memory or heavy sequential reads",
        ))
        items.append(_health(
            "Rollback ratio",
            f"{rollback_pct:.2f}%",
            "<5 OK, 5-20 WATCH, >20 APP/ERROR RISK",
            rollback_pct,
            [(20, "CRIT"), (5, "WARN")],
            "high rollback ratio often points to application errors, deadlocks, or failed transactions",
        ))
        items.append(_health(
            "Temp files",
            _pretty_bytes(temp_bytes),
            "<1GB OK, 1-10GB WATCH, >10GB work_mem/sort risk",
            temp_bytes / 1024 / 1024 / 1024,
            [(10, "CRIT"), (1, "WARN")],
            "temp files are usually large sorts, hashes, or insufficient work_mem",
        ))
        items.append(HealthItem("Database size", db_rows[0][5], "capacity trend item", "INFO", "track growth rate against disk and backup window"))

    table_rows = _rows(container, """
        select
          coalesce(sum(n_live_tup),0)::text,
          coalesce(sum(n_dead_tup),0)::text,
          coalesce(max(extract(epoch from now() - coalesce(last_autovacuum, last_vacuum))),0)::text
        from pg_stat_user_tables;
    """)
    if table_rows and len(table_rows[0]) >= 3:
        live = _int(table_rows[0][0])
        dead = _int(table_rows[0][1])
        dead_pct = dead / max(1, live + dead) * 100
        vacuum_age_hours = _float(table_rows[0][2]) / 3600
        items.append(_health(
            "Dead tuples",
            f"{dead_pct:.2f}% ({dead} dead)",
            "<10 OK, 10-20 WATCH, >20 VACUUM/BLOAT RISK",
            dead_pct,
            [(20, "CRIT"), (10, "WARN")],
            "dead tuples consume space and can slow scans until vacuum reclaims them",
        ))
        items.append(_health(
            "Vacuum freshness",
            f"{vacuum_age_hours:.1f}h since oldest table vacuum",
            "<24h OK, 24-72h WATCH, >72h AUTOVACUUM LAG",
            vacuum_age_hours,
            [(72, "CRIT"), (24, "WARN")],
            "old vacuum age suggests tables may miss cleanup/statistics refresh",
        ))

    age_rows = _rows(container, """
        select coalesce(max(extract(epoch from now() - xact_start)),0)::text
        from pg_stat_activity
        where xact_start is not null;
    """)
    if age_rows and age_rows[0]:
        hours = _float(age_rows[0][0]) / 3600
        items.append(_health(
            "Longest xact",
            f"{hours:.2f}h",
            "<0.5h OK, 0.5-2h WATCH, >2h VACUUM BLOCK RISK",
            hours,
            [(2, "CRIT"), (0.5, "WARN")],
            "long transactions can hold old row versions and delay vacuum cleanup",
        ))
    return items


def run_probe(key: str, container: str | None = None) -> dict[str, str]:
    target = _target(container)
    probe = PROBES.get(key)
    if probe is None:
        raise ValueError(f"unknown probe: {key}")
    started = perf_counter()
    output = _psql_table(target, probe.sql)
    return {"title": probe.title, "sql": " ".join(probe.sql.split()), "output": _with_elapsed(output, started)}


def run_sql(sql: str, container: str | None = None) -> dict[str, str]:
    target = _target(container)
    statement = sql.strip()
    if not statement:
        raise ValueError("empty SQL")
    started = perf_counter()
    if _is_psql_meta_command(statement):
        return {"title": "psql", "sql": statement, "output": _with_elapsed(_psql_meta(target, statement), started)}
    return {"title": "SQL", "sql": statement, "output": _with_elapsed(_psql_table(target, statement), started)}


def _target(container: str | None = None) -> Any:
    if container:
        return _docker_profile(container)
    profiles = _load_connection_profiles()
    selected_id = _active_connection_id()
    selected = next((profile for profile in profiles if str(profile.get("id", "")) == selected_id), None)
    return selected or profiles[0]


def _active_connection_id() -> str:
    if ACTIVE_CONNECTION_ID:
        return ACTIVE_CONNECTION_ID
    configured = _config().get("default")
    profiles = _load_connection_profiles()
    if configured and any(str(profile.get("id", "")) == str(configured) for profile in profiles):
        return str(configured)
    return str(profiles[0].get("id", "local-docker"))


def _load_connection_profiles() -> list[dict[str, Any]]:
    config = _config()
    profiles = config.get("connections")
    if isinstance(profiles, list) and profiles:
        return [_normalize_profile(profile) for profile in profiles if isinstance(profile, dict)]
    return [_docker_profile(os.environ.get("PG_TUI_CONTAINER") or os.environ.get("OPS_CONTAINER", DEFAULT_CONTAINER))]


def _config() -> dict[str, Any]:
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return {}


def _normalize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(profile)
    normalized.setdefault("id", str(normalized.get("label") or "postgres"))
    normalized.setdefault("label", str(normalized["id"]))
    normalized.setdefault("mode", "docker" if normalized.get("container") else "postgres")
    normalized.setdefault("database", "postgres")
    normalized.setdefault("user", "postgres")
    if normalized.get("mode") == "docker":
        normalized.setdefault("container", DEFAULT_CONTAINER)
    else:
        normalized.setdefault("host", "127.0.0.1")
        normalized.setdefault("port", 5432)
    return normalized


def _docker_profile(container: str) -> dict[str, Any]:
    return {
        "id": container,
        "label": container,
        "mode": "docker",
        "container": container,
        "database": "postgres",
        "user": "postgres",
    }


def _connection_description(profile: dict[str, Any]) -> str:
    if profile.get("mode") == "docker":
        return f"docker exec {profile.get('container')} psql -U {profile.get('user', 'postgres')} -d {profile.get('database', 'postgres')}"
    return f"{profile.get('host')}:{profile.get('port', 5432)} db={profile.get('database', 'postgres')} user={profile.get('user', 'postgres')}"


def _target_name(target: Any) -> str:
    if isinstance(target, str):
        return target
    label = str(target.get("label") or target.get("id") or "postgres")
    return f"{label} [{target.get('mode', 'postgres')}]"


def _docker_container(target: Any) -> str | None:
    if isinstance(target, str):
        return target
    if target.get("mode") == "docker":
        return str(target.get("container") or DEFAULT_CONTAINER)
    return None


def _logs(target: Any) -> list[str]:
    container = _docker_container(target)
    if container is None:
        return ["remote connection: PostgreSQL logs are not available through plain psql"]
    return _docker(["logs", "--tail", "10", container]).splitlines()[-10:]


def _scripts_dir() -> Path:
    configured = _config().get("scripts_dir")
    return Path(str(configured)) if configured else DEFAULT_SCRIPT_DIR


def _safe_script_path(script_id: str) -> Path:
    root = _scripts_dir().resolve()
    path = (root / script_id).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() != ".sql":
        raise ValueError(f"invalid script path: {script_id}")
    if not path.exists() or not path.is_file():
        raise ValueError(f"script not found: {script_id}")
    return path


def _script_description(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("--"):
                return stripped.lstrip("-").strip()[:160]
            if stripped:
                return f"{path.stat().st_size} bytes"
    except UnicodeDecodeError:
        return "SQL script; not UTF-8 readable"
    return "empty SQL script"


def _database_stats(container: Any) -> list[DatabaseStat]:
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


def _activity(container: Any) -> list[Activity]:
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


def _locks(container: Any) -> list[LockStat]:
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


def _metrics(container: Any) -> list[Metric]:
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


def _scalar(container: Any, sql: str) -> str:
    rows = _rows(container, sql)
    return rows[0][0] if rows and rows[0] else ""


def _rows(container: Any, sql: str) -> list[list[str]]:
    output = _psql(container, sql)
    rows = []
    for line in output.splitlines():
        if line.strip():
            rows.append(line.split("|"))
    return rows


def _psql(container: Any, sql: str) -> str:
    output = _run_psql(container, [
        "-tA",
        "-F",
        "|",
        "-c",
        " ".join(sql.split()),
    ])
    return output


def _psql_table(container: Any, sql: str) -> str:
    output = _run_psql(container, [
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


def _psql_meta(container: Any, command: str) -> str:
    normalized = command.strip()
    if normalized == r"\q":
        return r"\q closes an interactive psql session. Use q to quit this TUI."
    if normalized.startswith(r"\timing"):
        return "Timing is measured automatically for every command in this TUI."
    if normalized.startswith(r"\x"):
        return r"\x changes formatting inside an interactive psql session. This TUI keeps tabular output stable and supports horizontal scrolling instead."
    return _run_psql(container, [
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


def _run_psql(target: Any, args: list[str]) -> str:
    profile = _normalize_profile(target) if isinstance(target, dict) else _docker_profile(str(target))
    user = str(profile.get("user", "postgres"))
    database = str(profile.get("database", "postgres"))
    if profile.get("mode") == "docker":
        return _docker([
            "exec",
            "-e",
            "COLUMNS=1000",
            str(profile.get("container") or DEFAULT_CONTAINER),
            "psql",
            "-U",
            user,
            "-d",
            database,
            *args,
        ])

    env = os.environ.copy()
    password = str(profile.get("password") or "")
    password_env = str(profile.get("password_env") or "")
    if password_env:
        password = os.environ.get(password_env, password)
    if password:
        env["PGPASSWORD"] = password
    sslmode = str(profile.get("sslmode") or "")
    if sslmode:
        env["PGSSLMODE"] = sslmode
    return subprocess.check_output([
        "psql",
        "-h",
        str(profile.get("host", "127.0.0.1")),
        "-p",
        str(profile.get("port", 5432)),
        "-U",
        user,
        "-d",
        database,
        *args,
    ], text=True, stderr=subprocess.STDOUT, env=env)


def _is_psql_meta_command(statement: str) -> bool:
    return statement.lstrip().startswith("\\")


def _with_elapsed(output: str, started: float) -> str:
    elapsed_ms = (perf_counter() - started) * 1000
    return f"{output.rstrip()}\n\nTime: {elapsed_ms:.1f} ms"


def _health(item: str, current: str, reference: str, value: float, thresholds: list[tuple[float, str]], meaning: str) -> HealthItem:
    status = "OK"
    for threshold, candidate in thresholds:
        if value >= threshold:
            status = candidate
            break
    return HealthItem(item, current, reference, status, meaning)


def _inverse_health(item: str, current: str, reference: str, value: float, thresholds: list[tuple[float, str]], meaning: str) -> HealthItem:
    status = "OK"
    for threshold, candidate in thresholds:
        if value < threshold:
            status = candidate
            break
    return HealthItem(item, current, reference, status, meaning)


def _render_health_items(items: list[HealthItem]) -> str:
    rows = [["Item", "Current", "Reference", "Status", "Meaning"]]
    rows.extend([[item.item, item.current, item.reference, item.status, item.meaning] for item in items])
    return _render_text_table(rows)


def _render_text_table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    column_count = max(len(row) for row in rows)
    for row in rows:
        row.extend([""] * (column_count - len(row)))
    widths = [
        min(52 if index == column_count - 1 else 34, max(len(row[index]) for row in rows))
        for index in range(column_count)
    ]
    rule = "+" + "+".join("-" * (width + 2) for width in widths) + "+"
    lines = [rule, _format_row(rows[0], widths), rule]
    for row in rows[1:]:
        lines.append(_format_row(row, widths))
    lines.append(rule)
    return "\n".join(lines)


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
        cells.append(f" {cell.ljust(width)} ")
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


def _float(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        return 0.0


def _percent(value: str) -> float:
    return _float(value.strip().replace("%", ""))


def _pretty_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    size = float(value)
    unit = units[0]
    for unit in units:
        if size < 1024 or unit == units[-1]:
            break
        size /= 1024
    return f"{size:.1f} {unit}"


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
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            if method == "snapshot":
                _reply(request_id, asdict(load_snapshot(request.get("params", {}).get("container"))))
            elif method == "connection_profiles":
                _reply(request_id, connection_profiles())
            elif method == "set_connection":
                params = request.get("params", {})
                _reply(request_id, set_connection(params.get("connection_id", "")))
            elif method == "script_choices":
                _reply(request_id, script_choices())
            elif method == "run_script":
                params = request.get("params", {})
                _reply(request_id, run_script(params.get("script_id", "")))
            elif method == "probe_menu":
                _reply(request_id, probe_menu())
            elif method == "role_choices":
                params = request.get("params", {})
                _reply(request_id, role_choices(params.get("kind", "roles"), params.get("container")))
            elif method == "resource_health":
                _reply(request_id, resource_health(request.get("params", {}).get("container")))
            elif method == "run_probe":
                params = request.get("params", {})
                _reply(request_id, run_probe(params.get("key", ""), params.get("container")))
            elif method == "run_sql":
                params = request.get("params", {})
                _reply(request_id, run_sql(params.get("sql", ""), params.get("container")))
            elif method == "checkpoint":
                _reply(request_id, {"message": request_checkpoint(request.get("params", {}).get("container"))})
            else:
                _reply(request_id, error=f"unknown method: {method}")
        except Exception as exc:  # The TUI should show errors instead of crashing the gateway.
            _reply(request_id, error=str(exc))


def main() -> None:
    if "--print" in sys.argv:
        print(json.dumps(asdict(load_snapshot()), ensure_ascii=False, indent=2))
        return
    serve()


if __name__ == "__main__":
    main()
