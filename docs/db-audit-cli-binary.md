# DB Audit CLI Binary

The `db-audit` binary runs the `db-performance-audit` agent from a terminal against a PostgreSQL datasource. It does not dump or mutate the source database. Remediation SQL is validated only inside GFS branches created from a prepared plain SQL dump.

## Build

```bash
pnpm --filter ./apps/db-audit-cli build
```

The build writes the executable CommonJS bundle to:

```text
apps/db-audit-cli/dist/index.cjs
```

The package bin entry maps `db-audit` to that file.

## Runtime Requirements

- Node.js 22-compatible runtime.
- `psql` available on `PATH`, or set `QWERY_PSQL_BIN`.
- `gfs` available on `PATH` for remediation validation.
- A reachable PostgreSQL URL.
- A prepared plain SQL dump for the same database.
- A configured model provider for the agent runtime.

The CLI reads model provider configuration from the process environment. For local testing, source the existing app environment before running the binary, without printing secrets:

```bash
set -a
. apps/server/.env
set +a
```

If no model is configured, the SDK may fall back to a local OpenAI-compatible endpoint such as `http://localhost:8080/v1`. In that case the audit fails with `ECONNREFUSED` unless that service is running.

For a standalone starting point, copy `apps/db-audit-cli/.env.example` and replace the placeholder model credentials. Do not commit real `.env` files.

## Dump Resolution

Pass exactly one of `--dump` or `--dump-dir`.

Use `--dump` when you know the exact plain SQL file:

```bash
db-audit doctor \
  --url postgresql://user:password@localhost:5433/pagila \
  --dump /home/aymen/.cache/qwery/gfs-dumps/pagila.sql
```

Use `--dump-dir` when dumps are stored in the GFS-compatible cache directory:

```bash
db-audit doctor \
  --url postgresql://user:password@localhost:5433/pagila \
  --dump-dir /home/aymen/.cache/qwery/gfs-dumps
```

For a URL database named `pagila` on `localhost:5433`, directory mode checks these candidates in order:

```text
localhost-5433-pagila.sql
pagila.sql
```

The default dump directory on Linux is:

```text
~/.cache/qwery/gfs-dumps
```

The dump must be plain SQL. Custom-format `.dump` files are rejected because GFS import expects SQL.

## Commands

### `version`

Prints the CLI version, git version, agent id, and registered audit tools.

```bash
db-audit version
db-audit --version
db-audit -v
```

### `doctor`

Checks local prerequisites before running a real audit.

```bash
db-audit doctor \
  --url postgresql://user:password@localhost:5433/pagila \
  --dump /home/aymen/.cache/qwery/gfs-dumps/pagila.sql
```

`doctor` verifies:

- `gfs` availability.
- `psql` availability.
- Dump readability and dump mode.
- PostgreSQL connectivity with `select version()`.

Datasource URLs are redacted in output, including failed `psql` command details.

### `audit`

Runs the full agent workflow and writes report artifacts.

```bash
db-audit audit \
  --url postgresql://user:password@localhost:5433/pagila \
  --dump /home/aymen/.cache/qwery/gfs-dumps/pagila.sql \
  --out /tmp/pagila-audit/report.md \
  --json /tmp/pagila-audit/report.json \
  --gfs-audits-dir /tmp/pagila-audit/gfs
```

Useful flags:

- `--out <path>` writes the Markdown report. Defaults to `./db-audit-output/<timestamp>/report.md`.
- `--json <path>` writes a JSON companion artifact with redacted context and usage.
- `--gfs-audits-dir <path>` controls where GFS baseline repositories and validation branches are created.
- `--statement-timeout <value>` gives the agent timeout guidance. Default: `30s`.
- `--max-plan-candidates <number>` limits remediation candidates. Default: `3`.
- `--max-validations <number>` limits GFS validation runs. Default: `3`.
- `--model <provider/model>` overrides the environment-selected model.
- `--debug-trace` suppresses compact tool-name logging and leaves lower-level runtime traces visible.

The audit command:

1. Resolves and validates the prepared dump.
2. Exports dump configuration to `QWERY_GFS_DUMP_FILE` or `QWERY_GFS_DUMPS_DIR` for validation tools.
3. Creates an in-memory project, conversation, and PostgreSQL datasource.
4. Runs the `db-performance-audit` agent.
5. Allows read-only diagnostics against the source database.
6. Runs remediation tests only through GFS using the prepared dump.
7. Writes Markdown and optional JSON artifacts.

## Safety Model

- The source PostgreSQL database is used for diagnostics only.
- Audit SQL tools block write-capable statements against the source database.
- Remediation SQL runs only in isolated GFS branches.
- Generated report JSON redacts datasource credentials.
- `doctor` redacts datasource credentials in normal and failed connection output.

## Pagila Smoke Test

With Pagila running on `localhost:5433` and a dump in `~/.cache/qwery/gfs-dumps`:

```bash
set -a
. apps/server/.env
set +a

node apps/db-audit-cli/dist/index.cjs doctor \
  --url postgresql://postgres:postgres@localhost:5433/pagila \
  --dump /home/aymen/.cache/qwery/gfs-dumps/pagila.sql

node apps/db-audit-cli/dist/index.cjs audit \
  --url postgresql://postgres:postgres@localhost:5433/pagila \
  --dump /home/aymen/.cache/qwery/gfs-dumps/pagila.sql \
  --out /tmp/opencode/pagila-audit/report.md \
  --json /tmp/opencode/pagila-audit/report.json \
  --gfs-audits-dir /tmp/opencode/pagila-audit/gfs
```

A successful full run writes a professional Markdown audit report and a JSON companion file. The Markdown report should include findings, evidence, GFS validation metadata, rollback notes, caveats, and an original database unchanged guarantee.

## Troubleshooting

### `Cannot connect to API` or `ECONNREFUSED localhost:8080`

The agent runtime selected a model endpoint that is not running. Source the correct environment file or pass `--model` with a configured provider.

### `Use only one of --dump or --dump-dir.`

The CLI accepts one dump source. Remove one of the flags.

### `Dump must be plain SQL`

Create a plain SQL dump:

```bash
pg_dump "$POSTGRES_URL" --format=plain --no-owner --no-privileges --file prod-snapshot.sql
```

### `No prepared plain SQL dump found`

Either pass `--dump <path>` or put a matching file in the dump directory. For `localhost:5433/pagila`, use `localhost-5433-pagila.sql` or `pagila.sql`.

### Full audit succeeds but report is shallow

Avoid overly restrictive smoke-test limits. The default `--max-plan-candidates 3 --max-validations 3` produced a complete Pagila audit in testing, while `1/1` was too constrained for a useful report.
