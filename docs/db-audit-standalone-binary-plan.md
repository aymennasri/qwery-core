# DB Audit Standalone Binary Plan

## Goal

Package the DB performance audit agent into a standalone command-line deliverable that a PostgreSQL expert can run against their own databases.

The binary should:

- run read-only production diagnostics against a PostgreSQL datasource
- use compact audit tools to keep model/token cost controlled
- use an expert-provided SQL dump for GFS sandbox validation
- never dump or mutate the expert's production database automatically
- produce a professional markdown and JSON audit report

## Key Constraint: Expert-Provided Dump

The expert is responsible for creating the database dump separately.

The audit binary must not run `pg_dump` by default. It should only detect and use an existing prepared dump for GFS validation.

Current GFS validation behavior already supports this through environment variables and default dump-path detection in `validate_remediation_in_gfs_cli`.

## Existing Dump Detection Behavior

The validation tool already resolves prepared dumps in this order:

1. `QWERY_GFS_DUMP_FILE`, if set.
2. `QWERY_GFS_DUMPS_DIR`, if set.
3. Default GFS dump directory:
   - Linux/macOS: `~/.cache/qwery/gfs-dumps`
   - Windows: `%LOCALAPPDATA%/qwery/gfs-dumps`

If a dump directory is used, the tool looks for these candidate names:

- `<host>-<port>-<database>.sql`
- `<datasource-name>.sql`
- `<datasource-id>.sql`
- `<database>.sql`

Example for `postgresql://user:pass@db.example.com:5432/appdb`:

```text
~/.cache/qwery/gfs-dumps/db.example.com-5432-appdb.sql
~/.cache/qwery/gfs-dumps/<datasource-name>.sql
~/.cache/qwery/gfs-dumps/<datasource-id>.sql
~/.cache/qwery/gfs-dumps/appdb.sql
```

The current GFS import path expects a plain SQL dump because it imports with:

```bash
gfs import --file <dumpPath> --format sql
```

Expert dump command:

```bash
pg_dump "$POSTGRES_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --file ./prod-snapshot.sql
```

## Recommended User Flow

### 1. Expert Creates Dump

```bash
pg_dump "$POSTGRES_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --file ./prod-snapshot.sql
```

### 2. Expert Runs Doctor

```bash
db-audit doctor \
  --url "$POSTGRES_URL" \
  --dump ./prod-snapshot.sql
```

### 3. Expert Runs Audit

```bash
db-audit audit \
  --url "$POSTGRES_URL" \
  --dump ./prod-snapshot.sql \
  --statement-timeout 30s \
  --max-plan-candidates 3 \
  --out ./postgres-audit.md \
  --json ./postgres-audit.json
```

Alternative using auto-detected dump directory:

```bash
mkdir -p ~/.cache/qwery/gfs-dumps
cp ./prod-snapshot.sql ~/.cache/qwery/gfs-dumps/db.example.com-5432-appdb.sql

db-audit audit \
  --url "$POSTGRES_URL" \
  --dump-dir ~/.cache/qwery/gfs-dumps \
  --out ./postgres-audit.md
```

## CLI Commands

### `db-audit doctor`

Checks local prerequisites and validates that the target database and dump are usable.

Example:

```bash
db-audit doctor --url "$POSTGRES_URL" --dump ./prod-snapshot.sql
```

Checks:

- `gfs` CLI exists
- `psql` exists
- `pg_restore` or `psql` can inspect/import the dump as applicable
- dump file exists and is readable
- dump is plain SQL or at least compatible with `gfs import --format sql`
- GFS audit working directory is writable
- local GFS baseline can be initialized
- PostgreSQL connection succeeds
- connected DB provider is PostgreSQL
- current user privileges are visible
- whether target appears to be primary or replica
- whether `pg_stat_statements` is available
- whether `track_io_timing` is enabled

### `db-audit audit`

Runs the full DB performance audit.

Example:

```bash
db-audit audit --url "$POSTGRES_URL" --dump ./prod-snapshot.sql --out report.md
```

Responsibilities:

- register a temporary local datasource from the URL
- configure dump env vars for GFS validation
- run the `db-performance-audit` agent
- stream concise progress to the terminal
- write markdown report
- optionally write JSON report and tool trace

### `db-audit version`

Prints binary version, git SHA, agent version, and bundled tool version.

### Optional: `db-audit init`

Creates a local config file for repeated use.

Example:

```bash
db-audit init
```

Potential config path:

```text
~/.config/qwery/db-audit/config.json
```

## CLI Flags

Required:

- `--url <postgres-url>`: production or replica PostgreSQL connection URL.
- one of:
  - `--dump <path>`
  - `--dump-dir <path>`

Recommended:

- `--out <path>`: markdown report output path.
- `--json <path>`: JSON report output path.
- `--statement-timeout <duration>`: default `30s`.
- `--max-plan-candidates <n>`: default `3`.
- `--max-validations <n>`: default `3`.
- `--model <provider/model>`: default from env/config.
- `--gfs-audits-dir <path>`: maps to `QWERY_GFS_AUDITS_DIR`.

Safety/behavior flags:

- `--allow-primary`: suppress warning when target appears to be a primary DB.
- `--no-explain-analyze`: allow diagnostics but skip production `EXPLAIN ANALYZE`.
- `--read-replica`: document that the URL points to a replica.
- `--debug-trace <path>`: write tool trace for debugging.

## Environment Variable Mapping

The CLI should translate user-facing flags into the existing env variables used by the GFS validation tool.

| CLI Flag                  | Environment Variable          |
| ------------------------- | ----------------------------- |
| `--dump <path>`           | `QWERY_GFS_DUMP_FILE=<path>`  |
| `--dump-dir <path>`       | `QWERY_GFS_DUMPS_DIR=<path>`  |
| `--gfs-audits-dir <path>` | `QWERY_GFS_AUDITS_DIR=<path>` |

Existing env vars to preserve:

- `QWERY_GFS_DUMP_FILE`
- `QWERY_GFS_DUMPS_DIR`
- `QWERY_GFS_AUDITS_DIR`
- `QWERY_PSQL_BIN`

Model/provider env vars should be defined by the CLI package based on current model-provider conventions in the app.

## Safety Model

### Production Database

The production datasource must be read-only from the agent's perspective.

Allowed production operations:

- compact diagnostics
- read-only SQL
- bounded `EXPLAIN` / `EXPLAIN ANALYZE` on selected queries
- PostgreSQL metadata reads
- `pg_stat_statements` reads when available

Blocked production operations:

- `INSERT`
- `UPDATE`
- `DELETE`
- `DROP`
- `ALTER`
- `CREATE`
- `VACUUM`
- `ANALYZE`
- `COPY`
- `CALL`
- `DO`
- `ALTER SYSTEM`
- `pg_terminate_backend`

The binary should strongly recommend a read-only database user.

### GFS Sandbox

All remediation candidates run inside GFS only.

GFS validation may run:

- `CREATE INDEX`
- `DROP INDEX`
- `ANALYZE`
- `VACUUM`
- session-level config tests
- maintenance/config experiments supported by the existing validator

Report must state:

- original database unchanged
- GFS repo path
- branch name
- checkpoint commit
- after commit
- before/after metrics
- rollback SQL or reset command

## Agent and Tool Surface

The binary should use the consolidated audit path.

Enable only:

- `db_audit_diagnostics`
- `db_audit_plan`
- `validate_remediation_in_gfs_cli`
- tightly controlled read helper if still needed for representative validation SQL selection

Avoid exposing old narrow audit tools directly to the binary agent.

Avoid exposing unrestricted shell or unrestricted write SQL.

## Output Files

Default output directory:

```text
./db-audit-output/<timestamp>/
```

Files:

```text
report.md
report.json
tool-trace.json
gfs-validations.json
artifacts/
```

Markdown report should be the primary expert-facing artifact.

JSON report should include:

- audit context
- diagnostics summary
- findings
- recommendations
- validation results
- GFS metadata
- caveats

Tool trace should be optional because it may contain sensitive query text.

## Current Repo Packaging State

The repo has CLI packaging patterns, but no native standalone audit binary yet.

Existing relevant pieces:

- `apps/tui` has a `bin` entry:
  ```json
  {
    "bin": {
      "qwery-tui": "dist/index.js"
    }
  }
  ```
- `apps/tui` builds with `tsup`.
- `tooling/evals` also has a simple `bin` entry.
- No current evidence of a configured native binary target using `pkg`, `nexe`, Node SEA, or `bun build --compile`.

Recommended first packaging step:

- create a JS CLI package with a `bin` entry and `tsup` build
- ship it as an executable Node CLI first
- add native single-file binary packaging after the CLI behavior is stable

## Recommended Package Location

Create either:

```text
apps/db-audit-cli/
```

or:

```text
packages/db-audit-cli/
```

Recommended: `apps/db-audit-cli`, because it is an application wrapper around existing packages, not a reusable library.

Suggested structure:

```text
apps/db-audit-cli/
  package.json
  tsup.config.ts
  src/
    index.ts
    commands/
      audit.ts
      doctor.ts
      init.ts
      version.ts
    config.ts
    datasource.ts
    dump.ts
    safety.ts
    report-writer.ts
    local-runtime.ts
```

## Implementation Milestones

### Milestone 1: CLI Shell

- create `apps/db-audit-cli`
- add `bin` entry: `db-audit`
- add `tsup` build
- implement argument parsing
- implement `version`
- implement `doctor` skeleton

Acceptance:

- `pnpm --filter db-audit-cli build` succeeds
- `db-audit version` prints version info
- `db-audit doctor --help` works

### Milestone 2: Dump Resolution

- implement `--dump` and `--dump-dir`
- validate file/directory exists
- map flags to `QWERY_GFS_DUMP_FILE` / `QWERY_GFS_DUMPS_DIR`
- expose detected candidate paths in `doctor`
- fail clearly if no dump is found

Acceptance:

- explicit `--dump` works
- `--dump-dir` works with existing candidate naming
- missing dump produces actionable error with `pg_dump --format=plain` command

### Milestone 3: Local Audit Runtime

- create temporary local datasource from `--url`
- initialize minimal local repositories/storage
- instantiate `db-performance-audit`
- provide required tool context including attached datasource
- route tool metadata/progress to CLI output

Acceptance:

- local `postgres_air` audit runs from CLI
- report is written to disk
- original DB remains unchanged

### Milestone 4: Safety Guardrails

- set `statement_timeout` for production reads
- warn on superuser connections
- warn on primary connections unless `--allow-primary`
- cap plan candidates and validation count
- surface `pg_stat_statements` availability
- prefer workload evidence over ad hoc heavy probes

Acceptance:

- read queries inherit timeout
- production write SQL remains blocked
- `doctor` reports safety warnings

### Milestone 5: Reports and Artifacts

- write `report.md`
- write optional `report.json`
- write optional `tool-trace.json`
- write `gfs-validations.json`
- redact connection URL credentials in outputs

Acceptance:

- reports include GFS branch/checkpoint/after commit
- reports include rollback SQL
- no credentials appear in report files

### Milestone 6: Native Binary Packaging

Evaluate options:

1. Node SEA
2. Bun `--compile`
3. `pkg` or `nexe`

Recommended initial native path: Node SEA, because the repo targets Node 22+.

Fallback: distribute the JS CLI with Node requirement first.

Acceptance:

- single executable runs `version`
- single executable runs `doctor`
- single executable runs local `postgres_air` audit
- release artifact documented for Linux first

## Expert Testing Runbook

Send the expert this minimal runbook.

### 1. Prepare Dump

```bash
pg_dump "$POSTGRES_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --file ./prod-snapshot.sql
```

### 2. Run Doctor

```bash
db-audit doctor --url "$POSTGRES_URL" --dump ./prod-snapshot.sql
```

### 3. Run Audit

```bash
db-audit audit \
  --url "$POSTGRES_URL" \
  --dump ./prod-snapshot.sql \
  --statement-timeout 30s \
  --max-plan-candidates 3 \
  --max-validations 3 \
  --out ./postgres-audit.md \
  --json ./postgres-audit.json
```

### 4. Review

Expert reviews:

- top findings
- GFS validation evidence
- rollback SQL
- caveats
- whether workload stats represent real production traffic

## Production Read-Side Warnings

Even with GFS sandboxing, production reads can have impact.

Warn the expert:

- `EXPLAIN ANALYZE` executes the query
- large read-only scans can consume IO/cache
- run first on a read replica when possible
- use `statement_timeout`
- run first during low-traffic windows
- ensure `pg_stat_statements` is enabled to reduce ad hoc probing

## Acceptance Criteria

The binary is ready for external expert testing when all are true:

1. Runs from a clean checkout/build as `db-audit`.
2. Accepts `--url` and `--dump`.
3. Does not run `pg_dump` automatically.
4. Fails clearly if dump is missing or incompatible.
5. Uses `QWERY_GFS_DUMP_FILE` / `QWERY_GFS_DUMPS_DIR` under the hood.
6. Runs original DB access as read-only diagnostics and bounded plans.
7. Runs remediation SQL only inside GFS.
8. Produces markdown and JSON reports.
9. Includes original DB unchanged guarantee in report.
10. Includes GFS repo, branch, checkpoint commit, after commit, before/after metrics, and rollback SQL.
11. Redacts connection credentials from outputs.
12. `doctor` catches missing `gfs`, `psql`, dump, and connection problems.
13. Local `postgres_air` test completes successfully.

## Open Decisions

- Whether first external delivery should be Node CLI or native binary.
- Whether to include `runQuery` at all or replace it with a smaller bounded helper.
- Whether `doctor` should perform a lightweight GFS import smoke test by default or only with `--deep`.
- Whether to support custom-format dumps later by adding `pg_restore` conversion before GFS import.
- Which model/provider configuration format should be used for external expert testing.
