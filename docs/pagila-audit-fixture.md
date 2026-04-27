# Pagila Audit Fixture

This document records the intentionally injected issues in the local `pagila` PostgreSQL datasource used to test the DB audit agent.

## Datasource

- Container: `pagila-postgres`
- Engine: PostgreSQL 16
- Database: `pagila`
- Connection string: `postgresql://postgres:postgres@localhost:5433/pagila?sslmode=disable`
- Prepared GFS import dump: `~/.cache/qwery/gfs-dumps/localhost-5433-pagila.sql`

The DB audit GFS validator does not run `pg_dump` itself. It resolves a prepared SQL dump from `QWERY_GFS_DUMPS_DIR` or, by default, `~/.cache/qwery/gfs-dumps`. For local fixtures, name dumps as `<host>-<port>-<database>.sql` so the tool can find them from the datasource connection URL.

```sh
podman exec pagila-postgres pg_dump --format=plain --no-owner --no-privileges --dbname=pagila --username=postgres > ~/.cache/qwery/gfs-dumps/localhost-5433-pagila.sql
podman exec test-postgres pg_dump --format=plain --no-owner --no-privileges --dbname=postgres --username=postgres > ~/.cache/qwery/gfs-dumps/localhost-5432-postgres.sql
```

## Fixture Goal

The fixture extends the standard Pagila sample database with a dedicated `audit_lab` schema containing large tables and deliberately poor configuration so the audit agent has reproducible performance problems to detect.

## Injected Schema And Data

### Schema

- Added schema: `audit_lab`
- Added table: `audit_lab.customer_activity`
- Added table: `audit_lab.inventory_checks`

### Row counts

- `audit_lab.customer_activity`: about `1,500,000` rows
- `audit_lab.inventory_checks`: about `900,000` rows

### Table options

Both large `audit_lab` tables were created with:

- `autovacuum_enabled=false`

This is meant to produce persistent statistics freshness problems unless the table is analyzed manually.

## Injected Performance Problems

### 1. Missing useful indexes on `audit_lab.customer_activity`

Purpose: force sequential scans on two representative workload queries.

Missing indexes were intentionally left out for these access patterns:

- `WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50`
- `WHERE processed_at IS NULL AND created_at >= now() - interval '7 days'`

Expected symptoms:

- full `Seq Scan` on `customer_activity`
- roughly `300-500 ms` execution time depending on cache state
- high shared block reads
- `idx_scan = 0` on the table

### 2. Suboptimal index shape on `audit_lab.inventory_checks`

Purpose: create a query that uses an index, but still performs poorly due to extra heap filtering.

Existing indexes include:

- `idx_ic_staff_status`
- `idx_ic_staff_status_dup`

But there is no useful index for the tested access pattern:

- `WHERE check_status = 'failed' AND checked_at >= now() - interval '30 days' GROUP BY inventory_id`

Expected symptoms:

- `Bitmap Heap Scan` using `idx_ic_staff_status_dup`
- many rows filtered on `checked_at`
- roughly `200-280 ms` execution time depending on cache state

### 3. Never-analyzed large tables

Purpose: create obvious statistics-quality findings.

Expected symptoms:

- `last_analyze IS NULL`
- `last_autoanalyze IS NULL`
- `modSinceAnalyze` near table row count
- poor planner confidence on large tables

Affected tables:

- `audit_lab.customer_activity`
- `audit_lab.inventory_checks`

### 4. Duplicate and low-value indexes

Purpose: create index-health findings around redundancy and unused footprint.

Injected indexes:

- `idx_ca_store_activity`
- `idx_ca_store_activity_dup`
- `idx_ca_amount_only`
- `idx_ic_staff_status`
- `idx_ic_staff_status_dup`

Expected symptoms:

- duplicate signatures on `(store_id, activity_type)` and `(staff_id, check_status)`
- multiple indexes with `idx_scan = 0`
- measurable wasted index storage

## Injected Configuration Problems

These settings were intentionally changed with `ALTER SYSTEM` to produce infra/config findings:

- `track_io_timing = off`
- `max_parallel_workers_per_gather = 0`
- `log_lock_waits = off`
- `log_temp_files = -1`
- `max_wal_size = 128MB`

Additional low/default values present and relevant during audits:

- `random_page_cost = 4`
- `effective_io_concurrency = 1`
- `log_min_duration_statement = -1`

Expected symptoms:

- no real block I/O timing in plans
- no parallel query execution
- limited temp-file and lock-wait observability
- conservative planner assumptions for SSD-like storage

## Workload Seeded For `pg_stat_statements`

After loading data, representative slow queries were executed repeatedly to populate `pg_stat_statements`.

### Customer activity lookup

```sql
SELECT id, amount, created_at
FROM audit_lab.customer_activity
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 50;
```

### Customer pending-items aggregate

```sql
SELECT customer_id, count(*) AS pending_items
FROM audit_lab.customer_activity
WHERE processed_at IS NULL
  AND created_at >= now() - interval '30 days'
GROUP BY customer_id
ORDER BY pending_items DESC
LIMIT 20;
```

### Inventory failures aggregate

```sql
SELECT inventory_id, count(*) AS failures
FROM audit_lab.inventory_checks
WHERE check_status = 'failed'
  AND checked_at >= now() - interval '14 days'
GROUP BY inventory_id
ORDER BY failures DESC
LIMIT 20;
```

## What A Good Audit Should Detect

A strong report should usually identify most of the following:

- missing useful indexes on `audit_lab.customer_activity`
- suboptimal access path on `audit_lab.inventory_checks`
- `autovacuum_enabled=false` on both `audit_lab` tables
- never-analyzed or stale statistics on both large `audit_lab` tables
- duplicate / unused indexes in `audit_lab`
- `track_io_timing = off`
- `max_parallel_workers_per_gather = 0`
- `log_lock_waits = off`
- `log_temp_files = -1`
- `max_wal_size = 128MB`
- `random_page_cost = 4`
- `effective_io_concurrency = 1`

## What A Weak Audit Often Misses

Based on prior runs, weaker reports tend to:

- over-focus on `customer_activity` and understate `inventory_checks`
- miscount table/index totals
- overstate zero-scan index findings as automatically safe drops
- confuse "never analyzed" with "never autoanalyzed" on unrelated tables

## Notes

- The fixture is intended for audit-agent evaluation, not benchmark purity.
- Query timings vary with cache state, but plan shape and findings should remain stable.
- If GFS remediation validation is used, baseline import size can itself become a test constraint.
