# DB Audit Tool Consolidation Plan

## Goal

Reduce DB audit input-token usage without weakening safety or audit quality.

The current audit agent spends too many tokens on:

- a large set of specialized tool schemas repeated across steps
- large structured tool outputs fed back into the model
- repeated multi-step history in long audit runs

The recommended direction is to replace many narrow DB audit tools with a few bounded, high-level tools that:

- keep strict server-side guardrails
- return compact summaries to the model
- store or preserve full raw detail outside the model-facing payload

This document is meant to be implementation-ready for a follow-up session.

## Non-Goals

- Do not introduce a raw unrestricted bash tool for database auditing.
- Do not expose unrestricted write SQL to the model.
- Do not reduce evidence quality in the final audit report.
- Do not remove GFS validation from the workflow.

## Why This Change

Recent investigation showed that after switching to Azure `gpt-5.2-codex`, reasoning bloat dropped sharply and cache became effective. The remaining token cost is now dominated by:

1. repeated tool schema overhead
2. large structured tool outputs, especially:
   - `runQueries`
   - `get_table_health`
   - `explain_query_plan`
   - `get_bloat_estimates`
   - `get_statistics_health`
3. long multi-step history in the audit loop

This means the next high-value step is tool-surface consolidation and output compaction.

## Recommended Target Design

Replace most DB audit-specific tools in the audit agent path with 3 bounded tools:

1. `db_audit_diagnostics`
2. `db_audit_plan`
3. `db_audit_validate`

These should be optimized for compact model-facing output and strong server-side control.

## Tool 1: `db_audit_diagnostics`

### Purpose

Collect all read-only audit diagnostics through one bounded interface instead of many separate tool definitions.

### Replaces

- `detect_db_engine`
- `get_infra_runtime_signals`
- `get_recent_db_logs`
- `get_statistics_health`
- `get_lock_and_blocking_analysis`
- `get_bloat_estimates`
- `get_replication_health`
- `get_index_health`
- `get_table_health`
- `get_top_slow_queries`
- some `runQuery` and `runQueries` discovery work

### Input shape

Keep the input small and explicit. Example:

```ts
{
  checks: Array<
    | 'engine'
    | 'runtime'
    | 'logs'
    | 'statistics'
    | 'locks'
    | 'bloat'
    | 'replication'
    | 'indexes'
    | 'tables'
    | 'slow_queries'
  >,
  limits?: {
    topTables?: number,
    topIndexes?: number,
    topQueries?: number,
    topEvents?: number,
  }
}
```

### Model-facing output

Return compact summaries only. Example sections:

- `engine`
- `runtimeSummary`
- `topTableFindings`
- `topIndexFindings`
- `statisticsFindings`
- `slowQueryFindings`
- `logSignals`
- `replicationSummary`
- `blockedChecks`
- `artifacts`

### Important rule

Do not return full rows, full nested table stats, or unbounded raw objects to the model.

### Artifact strategy

If full details are needed for UI/debugging, persist them separately and only return references like:

```ts
artifacts: {
  runtime: { id: '...', kind: 'json' },
  tables: { id: '...', kind: 'json' },
  indexes: { id: '...', kind: 'json' }
}
```

## Tool 2: `db_audit_plan`

### Purpose

Run bounded `EXPLAIN ANALYZE` style investigation while returning only the metrics the model actually needs.

### Replaces

- `explain_query_plan`

### Input shape

```ts
{
  label: string,
  query: string,
  mode?: 'analyze' | 'explain',
  capture?: {
    topNodes?: number,
    highlights?: number,
  }
}
```

### Model-facing output

Compact fields only:

```ts
{
  label: string,
  totalTimeMs: number | null,
  executionTimeMs: number | null,
  planningTimeMs: number | null,
  rootNode: string | null,
  worstNode: string | null,
  sharedReadBlocks: number | null,
  sharedHitBlocks: number | null,
  tempReadBlocks: number | null,
  tempWriteBlocks: number | null,
  spilled: boolean,
  parallelUsed: boolean,
  rowEstimateSkew: number | null,
  topSlowNodes: Array<...small objects...>,
  highlights: string[],
  artifact?: { id: string, kind: 'plan-json' }
}
```

### Important rule

Never return the full raw plan tree to the model by default.

## Tool 3: `db_audit_validate`

### Purpose

Run GFS remediation validations with compact, audit-ready result summaries.

### Replaces

- `validate_remediation_in_gfs_cli`

### Input shape

```ts
{
  label: string,
  validationType: 'query' | 'index' | 'config' | 'maintenance',
  validationQuery: string,
  actionStatements: string[],
  rollbackStatements?: string[],
  notes?: string,
}
```

### Model-facing output

Return the exact fields needed for the report and nothing more:

```ts
{
  label: string,
  originalDatabaseUnchanged: boolean,
  repoPath: string,
  branch: string,
  checkpointCommit: string,
  mutationCommit?: string,
  baseline: {
    totalTimeMs?: number,
    executionTimeMs?: number,
    sharedReadBlocks?: number,
    sharedHitBlocks?: number,
  },
  postChange: {
    totalTimeMs?: number,
    executionTimeMs?: number,
    sharedReadBlocks?: number,
    sharedHitBlocks?: number,
  },
  delta: {
    totalTimeMs?: number,
    executionTimeMs?: number,
    totalTimePct?: number,
  },
  assessment: {
    timingOutcome: 'improved' | 'neutral' | 'regressed' | 'inconclusive',
    recommendationStatus: 'validated' | 'rejected' | 'inconclusive',
    benchmarkSuitability: 'latency-impact' | 'low-latency' | 'maintenance',
    rationale: string,
    cautions: string[],
  },
  artifact?: { id: string, kind: 'validation-json' }
}
```

### Important rule

Do not return the full nested raw validation payload to the model unless explicitly debugging.

## Safety Requirements

All safety stays server-side.

### Diagnostics tool

- read-only only
- bounded result counts
- no arbitrary write SQL

### Plan tool

- read-only query only
- validated query shape
- protect against harmful statements

### Validation tool

- preserve existing GFS-only mutation behavior
- preserve one-at-a-time validation execution
- preserve index/drop eligibility checks
- preserve original DB unchanged guarantee

## Output Compaction Rules

This redesign only works if model-facing outputs stay small.

### Required rules

1. Return top-N findings, not full tables.
2. Return derived metrics, not raw row sets.
3. Return artifact references for full detail.
4. Avoid nested repeated structures.
5. Prefer short typed arrays over verbose prose in tool outputs.

### Strong recommendation

Use a shared helper for model-facing DB audit summaries so the compactness rules are enforced in one place.

## Prompt Changes

After the new tools exist, simplify `packages/agent-factory-sdk/src/agents/prompts/db-performance-audit.prompt.ts`.

### Keep

- evidence gates
- GFS validation requirements
- safety rules
- reporting quality rules

### Remove or reduce

- per-tool choreography tied to the old narrow tools
- repeated explanation of benchmark/reference material
- duplicated rules that can move into tool behavior

The prompt should tell the agent what evidence it needs, not how to manually orchestrate ten specialized tools.

## Migration Strategy

### Phase 1: Add new tools alongside old ones

Add the 3 new tools without removing the current tools.

### Phase 2: Switch only `db-performance-audit`

Update the DB audit agent to use only the new consolidated tools.

### Phase 3: Compare behavior

Measure:

- input tokens
- cache read tokens
- report completeness
- validation correctness
- number of steps per run

### Phase 4: Remove redundant old audit tools

Only after the new path is stable.

## Recommended Build Order

This is the lowest-risk order.

### Step 1

Implement `db_audit_plan` first.

Reason:

- `explain_query_plan` is one of the largest remaining payloads
- replacement scope is narrow
- high confidence token savings

### Step 2

Implement `db_audit_validate` second.

Reason:

- validation output is structured and repetitive
- easy to shape into report-ready summaries

### Step 3

Implement `db_audit_diagnostics` last.

Reason:

- it absorbs the most old tools
- it needs the most careful summary design

## File-Level Implementation Guide

Likely touch points:

- `packages/agent-factory-sdk/src/tools/`
  - add:
    - `db-audit-diagnostics.ts`
    - `db-audit-plan.ts`
    - `db-audit-validate.ts`
- `packages/agent-factory-sdk/src/tools/registry.ts`
  - register the new tools
- `packages/agent-factory-sdk/src/agents/db-performance-audit-agent.ts`
  - enable new tools
  - disable old narrow audit tools for this agent once stable
- `packages/agent-factory-sdk/src/agents/prompts/db-performance-audit.prompt.ts`
  - simplify tool instructions after migration

Potential shared helper location:

- `packages/agent-factory-sdk/src/tools/db-audit/shared.ts`

Add helper functions for:

- summary shaping
- top-N filtering
- artifact persistence/references
- common evidence-field normalization

## Acceptance Criteria

The redesign is successful if all are true:

1. DB audit reports remain materially equivalent in quality.
2. `gpt-5.2-codex` audit runs use fewer input tokens than the current specialized-tool path.
3. Tool-facing outputs become significantly smaller.
4. The agent still supports validated GFS-based recommendations only.
5. No raw unrestricted mutation path is exposed to the model.

## Suggested First PR Scope

Keep the first PR intentionally small.

Recommended first PR:

1. add `db_audit_plan`
2. switch audit agent to use it instead of `explain_query_plan`
3. keep all other tools unchanged
4. measure token impact

That will validate the consolidation direction before the broader migration.

## Final Recommendation

Do not implement the "single unrestricted bash tool" pattern for audits.

Implement the safer version instead:

- fewer high-level audit tools
- compact model-facing summaries
- artifact-backed full detail
- strict server-side safety boundaries

That should preserve audit quality while materially reducing token usage.
