# Lightweight GFS Remediation Validation Redesign

## Goal

Redesign remediation validation from scratch so it is lightweight, simpler, faster, and less error-prone.

The new design must support the DB audit agent by validating suggested remediations with GFS against a safe test environment, without using the current validator as an implementation reference.

## Mandatory Branching Rule

All work in `db-audit` must be done on a dedicated git branch, not on `main`.

Suggested branch name in `db-audit`:
`feat/lightweight-gfs-validation-redesign`

A separate feature branch should also be used in `gfs` for the direct-seed capability required by this redesign.

## Core Decision

Target model:
GFS should seed a repo directly from the attached PostgreSQL datasource URL once, then all validations should run inside the GFS-managed database environment.

This means:
- clone the database state, not the podman container
- do not run validations against the original datasource
- do not make Qwery dump or import the database itself
- do not couple the design to the source podman container internals

## Why The Current Design Must Be Replaced

The current validator in `packages/agent-factory-sdk/src/tools/validate-remediation-in-gfs-cli.ts` is too heavy because it combines too many responsibilities:
- datasource resolution
- PostgreSQL client binary discovery and version matching
- full `pg_dump`
- `gfs init`
- `gfs compute start`
- `gfs import`
- baseline cache creation and publication
- repo copying for isolated runs
- branch management
- benchmark execution
- result assessment
- locking and queueing
- stale-cache cleanup
- podman-based permission repair

This creates the current problems:
- slow baseline creation
- too many subprocess and environment dependencies
- readiness races
- filesystem and permission failures
- podman-specific edge cases
- unnecessary complexity for a tool whose real job is only validation

## Current High-Cost Steps To Eliminate

These steps should not exist in the new `db-audit` design:
- `pg_dump` from the original database
- `gfs import` orchestration from Qwery
- PostgreSQL client binary resolution with `psql` and `pg_dump`
- recursive copy of cached GFS repos for each run
- podman permission repair with `podman unshare`
- global baseline cache cleanup logic
- cross-process stale-lock recovery logic unless proven necessary

## Target Architecture

The new architecture should be split cleanly.

### GFS Responsibilities

GFS should own:
- creating a new repo from an external PostgreSQL datasource URL
- creating the initial baseline commit
- managing the GFS compute database
- branching and committing database state
- exposing connection details in a machine-readable way

### DB-Audit Responsibilities

`db-audit` should own:
- resolving the attached datasource from Qwery
- calling GFS to create or reuse a validation repo
- running before and after benchmarks inside the GFS-managed database
- applying remediation SQL inside the GFS-managed database
- parsing EXPLAIN output
- assessing validation outcome
- returning structured results to the audit agent

## Required GFS Capability

Public GFS docs show:
- `gfs init`
- `gfs checkout -b`
- `gfs checkout`
- `gfs commit`
- `gfs status --output json`
- `gfs query`

But there is no documented existing public command for direct seeding from an external PostgreSQL URL.

The redesign therefore depends on a small new GFS feature.

### Proposed GFS CLI Contract

One of these shapes should be added in `gfs`:
- `gfs clone --source-url <postgres-url>`
- or `gfs init --source-url <postgres-url>`

Required behavior:
- connect to the external PostgreSQL datasource using the provided URL
- seed a fresh local GFS repo directly from that database state
- create an initial baseline commit
- make the repo fully GFS-managed after seeding
- expose enough machine-readable state for `db-audit` to consume reliably

Preferred machine-readable follow-up:
- `gfs status --output json` should expose branch, compute status, and connection string consistently

## New Validator Design In DB-Audit

Do not retrofit the current tool internals.

Create a new validator with a simplified API and implementation.

### Proposed Tool Shape

Suggested new tool name:
`validate_remediation_in_gfs`

Suggested parameters:
- `benchmarkQuery`: the representative query or benchmark payload used for before and after comparison
- `actionStatements`: required array of SQL statements to execute in the GFS environment
- `label`: optional short human-readable experiment name

Avoid these unless there is a proven need:
- no caller-provided branch name
- no explicit validation type field if it can be inferred
- no repo path input from the model
- no cache-control input from the model

## Validation Flow

1. Resolve the attached PostgreSQL datasource from Qwery.
2. Extract the datasource connection URL.
3. Look up a conversation-scoped validation session for that datasource.
4. If no session exists, create a fresh GFS repo using the new direct-seed GFS command.
5. Record the repo path, baseline commit, and compute connection details.
6. Reuse that repo for the rest of the audit conversation.
7. For each remediation validation, reset or checkout back to the baseline revision.
8. Create a fresh audit branch.
9. Connect to the GFS-managed database.
10. Run the before benchmark.
11. Apply the remediation SQL.
12. Commit if persistent state changed.
13. Run the after benchmark.
14. Compute deltas and classify the result.
15. Return structured output for the audit agent.

## Session Model

Use a conversation-scoped session, not a global baseline cache.

This means:
- one seeded GFS repo per datasource per conversation
- reuse the repo for repeated validations in the same audit run
- keep compute warm during the conversation if practical
- stop compute when the conversation ends or the session expires
- avoid global 7-day cache cleanup and global baseline directories

Benefits:
- much simpler lifecycle
- much faster repeated validations
- fewer shared-state race conditions
- cleaner failure domain

## Database Execution Strategy

Use the existing Node PostgreSQL driver stack, not shell-based `psql`.

Relevant existing implementation:
- `packages/extensions/postgresql/src/driver.ts`

Why:
- removes `psql` and `pg_dump` dependency from `db-audit`
- removes Postgres client version matching logic
- keeps DB access in-process and easier to test
- reduces startup and shell failure modes

## Benchmark Strategy

The benchmark logic should focus on measurement and repeatability, not safety restrictions.

Rules:
- the tool may execute destructive SQL because the GFS environment is intentionally disposable
- the benchmark should still have a consistent before and after shape so results are interpretable
- config experiments should prefer session-level settings when possible
- use the same representative benchmark before and after the change
- return timing and plan-level evidence, not just success or failure

Minimal correctness checks are acceptable only when they improve reliability of measurement, not when they are meant to protect the disposable test environment.

## Minimal Internal Module Split

Create smaller focused modules instead of one giant file.

Suggested split:
- `gfs-validation-session.ts`
- `gfs-validation-db.ts`
- `gfs-validation-assessment.ts`
- `validate-remediation-in-gfs.ts`

### Module Responsibilities

`gfs-validation-session.ts`
- resolve or create a conversation-scoped GFS repo
- call the new GFS direct-seed command
- track baseline revision
- create fresh audit branches
- manage lightweight session reuse

`gfs-validation-db.ts`
- connect to the GFS-managed PostgreSQL instance
- run readiness checks
- run benchmark SQL
- run remediation SQL
- collect EXPLAIN output or equivalent benchmark evidence

`gfs-validation-assessment.ts`
- parse EXPLAIN JSON or equivalent benchmark results
- extract metrics and plan summary
- compute before and after deltas
- classify result as validated, rejected, or inconclusive

`validate-remediation-in-gfs.ts`
- tool entrypoint
- lightweight input normalization only where useful for execution consistency
- orchestration across the above modules
- metadata and result formatting for the agent

## Concurrency Model

Keep concurrency simple.

Rules:
- only one remediation validation per datasource per conversation at a time
- fail fast if another validation is already running in the same conversation
- do not add complex cross-process lock recovery unless real production usage proves it is necessary

This aligns with the audit agent prompt rule that validations should already be executed one at a time.

## What To Preserve Conceptually From The Old Tool

The old tool has a bad architecture, but a few small ideas inside it are still useful.

Keep only the ideas that help correctness or measurement quality:
- action statement normalization
- session-versus-persistent change handling
- EXPLAIN JSON parsing or equivalent structured benchmark parsing
- timing and I/O delta assessment
- structured result shape for the agent

### Why These Are Worth Preserving

`action statement normalization`
- helps clean up messy LLM-generated SQL
- makes execution more predictable
- avoids trivial parsing and formatting failures

`session-versus-persistent change handling`
- distinguishes changes that only affect one session from changes that mutate database state
- ensures the validator knows when a commit is meaningful and when a single-session experiment is enough

`EXPLAIN JSON parsing or equivalent structured benchmark parsing`
- gives stable machine-readable evidence instead of relying on raw text
- makes it easier to compare plan shape, timing, and I/O before and after a remediation

`timing and I/O delta assessment`
- turns raw measurements into a verdict
- lets the validator decide whether a remediation improved, regressed, or did not materially change the benchmark

`structured result shape for the agent`
- gives the DB audit agent a stable contract
- makes it easier for the agent to include only measured, validated outcomes in the final report

## What To Remove Entirely

Remove these implementation patterns from the new validator:
- baseline dump generation
- GFS import retry orchestration from Qwery
- version-aware CLI binary lookup
- repo copy-per-run
- podman permission repair
- filesystem cache publication
- stale cache scavenging
- persistent startup blocker caches unless later proven necessary
- safety-driven SQL restrictions for the disposable GFS test environment

## Testing Plan

The new validator should be tested mainly with integration tests, not only helper tests.

### Required Integration Coverage

1. Source PostgreSQL is running in podman.
2. Qwery resolves the attached datasource URL.
3. GFS seeds a repo directly from that datasource.
4. The validator creates a baseline and branch correctly.
5. A simple benchmark runs successfully.
6. A maintenance remediation such as `ANALYZE` runs and is assessed.
7. A schema remediation such as `CREATE INDEX` runs and is assessed.
8. A session-level config experiment runs and is assessed.
9. A second validation in the same conversation reuses the session and is faster.
10. Startup and connectivity failures are surfaced cleanly.

### Regression Coverage

Add tests to ensure the new path does not depend on:
- `psql`
- `pg_dump`
- `podman unshare`
- global repo cache directories
- recursive repo copies

## Rollout Plan

1. Create the dedicated `db-audit` feature branch.
2. Create the required feature branch in `gfs`.
3. Implement the new direct-seed capability in `gfs`.
4. Validate the new GFS flow independently first.
5. Implement the new lightweight validator in `db-audit`.
6. Update the DB audit agent to use the new validator.
7. Run integration tests against a real podman-backed PostgreSQL datasource.
8. Compare reliability and speed against the old validator.
9. Remove the old validator only after parity and stability are confirmed.

## Success Criteria

The redesign is complete when all of the following are true:
- all work was implemented on a dedicated `db-audit` branch
- `db-audit` no longer creates dumps of the source database
- validations run only against the GFS-managed test database
- repeated validations in one audit session are fast
- the validator no longer depends on local `psql` or `pg_dump`
- the validator no longer contains podman permission-repair logic
- the implementation is materially smaller and easier to reason about than the old one
- failure modes are limited to a small number of clear integration points

## Practical Notes For The Next Session

When implementation starts:
- do not modify the old validator first
- create the new validator beside it
- keep the old one available for comparison until the new path is proven
- begin with the GFS direct-seed capability because the `db-audit` redesign depends on it
- always work from the dedicated `db-audit` branch

## Recommended First Execution Steps

1. Create the `db-audit` branch:
`feat/lightweight-gfs-validation-redesign`

2. Inspect `gfs` and define the exact direct-seed CLI contract.

3. Implement and validate the GFS direct-seed feature.

4. In `db-audit`, add the new validator modules without touching the old implementation yet.

5. Wire the DB audit agent to the new tool only after integration tests exist.

## Final Principle

Treat the current validator as a list of edge cases and useful small parsing ideas, not as a design to preserve.

The desired end state is:
- thin Qwery orchestration
- GFS-native database seeding
- in-process PostgreSQL execution from Node
- conversation-scoped validation sessions
- minimal moving parts
