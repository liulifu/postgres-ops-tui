-- Show active and waiting sessions, useful as a first troubleshooting script.
select
  pid,
  usename,
  datname,
  state,
  wait_event_type,
  wait_event,
  now() - query_start as query_age,
  left(regexp_replace(query, E'[\n\r\t]+', ' ', 'g'), 180) as query
from pg_stat_activity
where state <> 'idle' or wait_event_type is not null
order by query_start nulls last
limit 50;
