# Postgres Air Optimizer Fixture

This document records the intentionally injected expert-level slow-query workload in the local `postgres_air` PostgreSQL datasource used to test the slow-query optimizer agent.

## Datasource

- Container: `postgres-air`
- Engine: PostgreSQL 16
- Database: `postgres_air`
- Connection string: `postgresql://postgres:postgres@localhost:5434/postgres_air?sslmode=disable`
- `pg_stat_statements`: enabled

## Fixture Goal

Unlike the Pagila audit fixture, this workload is focused on slow-query optimization rather than broad audit findings. The goal is to seed `pg_stat_statements` with realistic, structurally inefficient statements that require expert analysis of execution plans, join fan-out, window churn, late filtering, and query-shape rewrites.

These are not meant to be trivial "missing index" exercises.

## Seeded Workload

The workload is stored in:

- `resources/sql/postgres-air-expert-slow-workload.sql`

Run it with:

```sh
psql "postgresql://postgres:postgres@localhost:5434/postgres_air?sslmode=disable" -f resources/sql/postgres-air-expert-slow-workload.sql
```

## Injected Query Families

### 1. Correlated passenger performance profile

Purpose: create a slow query that repeatedly rescans very large tables from correlated scalar subqueries.

Why it is hard:

- repeated full scans of `boarding_pass`
- repeated scans of `booking_leg`
- scalar correlated subqueries on massive tables
- high cumulative buffer reads despite a tiny outer result set
- requires query-shape rewrite first, not just an index

What a good optimizer should notice:

- the outer filter is tiny, but the subplans dominate runtime
- the same large relations are rescanned multiple times
- the query should be refactored into set-based preaggregation or joined aggregates

### 2. Booking/account rollup with fan-out distortion

Purpose: create a realistic reporting query that multiplies rows across multiple child tables and then spends most of its time repairing that fan-out with `DISTINCT` aggregates and temp-spilling sorts.

Why it is hard:

- join fan-out between `booking`, `passenger`, `booking_leg`, and `phone`
- non-sargable `date_trunc` filter on `booking.update_ts`
- multiple `count(DISTINCT ...)` aggregates
- `string_agg(DISTINCT ...)`
- external merge spills and large temp I/O

What a good optimizer should notice:

- the query should aggregate at the booking or account grain before joining everything together
- the time predicate should be rewritten to a range predicate
- any index work should follow a query rewrite, not precede it blindly

### 3. Passenger connection-gap analysis

Purpose: create a heavy analytical query that materializes a massive passenger-leg stream, sorts it multiple times for window functions, and only filters/group-aggregates after paying that full cost.

Why it is hard:

- `MATERIALIZED` CTE locks in a broad intermediate result
- large window partitions over passenger itineraries
- multiple external merge sorts
- late filtering on `prev_arrival`
- percentile aggregation after expensive windowing

What a good optimizer should notice:

- the query pays for a huge intermediate result before reducing it
- the windowing and grouping strategy can likely be decomposed
- memory pressure and sort spill are first-class parts of the diagnosis

## Expected Runtime Shape

Representative `EXPLAIN ANALYZE` runs showed:

- correlated passenger profile: roughly `30s+`
- booking/account fan-out rollup: roughly `70s+`
- passenger connection-gap analysis: roughly `100s+`

Timings vary with cache state, but the important part is the plan shape and why the statements are slow.

## What A Good Slow-Query Optimizer Should Detect

- repeated correlated rescans as a primary bottleneck
- join fan-out hidden behind `DISTINCT` aggregates
- non-sargable time predicates that should become plain timestamp ranges
- external sort or hash spills with significant temp I/O
- excessive work done before reduction or grouping
- opportunities to rewrite into staged aggregates or smaller intermediates before considering index changes

## Notes

- No schema mutation was required to inject these slow statements; the workload is seeded by execution and captured through `pg_stat_statements`.
- This fixture is intentionally optimization-centric and should stay separate from the broader Pagila audit fixture.
