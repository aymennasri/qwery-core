export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AuditFinding = {
  id: string;
  title: string;
  severity: AuditSeverity;
  category:
    | 'query-plan'
    | 'indexing'
    | 'table-stats'
    | 'locks-waits'
    | 'configuration'
    | 'capacity';
  evidence: string[];
  impact: string;
  recommendation: string;
  sql?: string[];
  confidence: number;
};

export type PlanInsightInput = {
  query: string;
  executionTimeMs: number;
  planningTimeMs?: number;
  seqScanNodes?: number;
  indexScanNodes?: number;
  planRows?: number;
  actualRows?: number;
};

export type SlowQueryInput = {
  query: string;
  meanExecTimeMs?: number;
  totalExecTimeMs?: number;
  calls?: number;
  source?: string;
};

export type IndexHealthInput = {
  highSeqScanTables?: Array<{
    schema: string;
    table: string;
    seqScan: number;
    idxScan: number;
    liveTuples?: number;
    estimatedSeqRowsRead?: number;
    seqScanRatio: number;
  }>;
  unusedIndexes?: Array<{
    schema: string;
    table: string;
    index: string;
    sizeBytes: number;
    isUnique?: boolean;
    isPrimary?: boolean;
    backsConstraint?: boolean;
    dropCandidate?: boolean;
  }>;
  duplicateIndexes?: Array<{
    schema: string;
    table: string;
    indexSignature: string;
    indexNames: string[];
    duplicateCount: number;
    totalSizeBytes?: number;
  }>;
};

export type TableHealthInput = Array<{
  schema: string;
  table: string;
  totalSizeBytes: number;
  deadTuplePct: number;
  seqScan: number;
  idxScan: number;
  liveTuples?: number;
  modSinceAnalyze?: number;
  secondsSinceVacuum?: number | null;
  secondsSinceAnalyze?: number | null;
  autovacuumEnabledOverride?: string | null;
  lastVacuum?: string | null;
  lastAutovacuum?: string | null;
}>;

export type LockSignalsInput = {
  blockingChainCount?: number;
  idleInTransactionCount?: number;
  maxIdleInTransactionSeconds?: number;
  deadlockCount?: number;
  lockWaitSessions?: number;
};

export type ConfigGapInput = {
  trackIoTiming?: string | null;
  logMinDurationStatement?: string | null;
  logLockWaits?: string | null;
  logTempFiles?: string | null;
  checkpointCompletionTarget?: string | null;
  randomPageCost?: string | null;
  workMem?: string | null;
  sharedBuffers?: string | null;
  autovacuum?: string | null;
  pgStatStatementsEnabled?: boolean;
};

export type InfraSignalsInput = {
  capturedAt?: string;
  database?: string;
  postgresVersion?: string;
  os?: {
    uptimeSeconds?: number;
    dataDirectory?: string | null;
    configFile?: string | null;
    hbaFile?: string | null;
    serverAddress?: string | null;
    serverPort?: number | null;
  };
  connection?: {
    maxConnections?: number;
    totalSessions?: number;
    activeSessions?: number;
    idleSessions?: number;
    waitingActiveSessions?: number;
    utilizationPct?: number;
  };
  cpu?: {
    runningActiveSessions?: number;
    waitingActiveSessions?: number;
    maxWorkerProcesses?: number | null;
    maxParallelWorkers?: number | null;
    maxParallelWorkersPerGather?: number | null;
    jit?: string | null;
  };
  network?: {
    networkWaitSessions?: number;
    clientReadWaitSessions?: number;
    clientWriteWaitSessions?: number;
    tcpKeepalivesIdle?: string | null;
    tcpKeepalivesInterval?: string | null;
    tcpKeepalivesCount?: string | null;
  };
  waits?: {
    lockWaitSessions?: number;
    ioWaitSessions?: number;
    networkWaitSessions?: number;
    activeWaitEventTypes?: Array<{
      waitEventType: string;
      sessions: number;
      pctOfActiveSessions?: number;
    }>;
    activeWaitEvents?: Array<{
      waitEvent: string;
      sessions: number;
    }>;
  };
  io?: {
    blksRead?: number;
    blksHit?: number;
    cacheHitPct?: number;
    tempFiles?: number;
    tempBytes?: number;
    deadlocks?: number;
    blockReadTimeMs?: number;
    blockWriteTimeMs?: number;
  };
  checkpoints?: {
    checkpointsTimed?: number;
    checkpointsRequested?: number;
    checkpointWriteTimeMs?: number;
    checkpointSyncTimeMs?: number;
    buffersCheckpoint?: number;
    buffersBackend?: number;
    buffersAlloc?: number;
  };
  config?: {
    sharedBuffers?: string | null;
    workMem?: string | null;
    maintenanceWorkMem?: string | null;
    effectiveCacheSize?: string | null;
    maxWalSize?: string | null;
    checkpointTimeout?: string | null;
    trackIoTiming?: string | null;
    effectiveIoConcurrency?: string | null;
    randomPageCost?: string | null;
    autovacuum?: string | null;
  };
  logging?: {
    loggingCollector?: string | null;
    logDestination?: string | null;
    logDirectory?: string | null;
    logFilename?: string | null;
    logMinDurationStatement?: string | null;
    logStatement?: string | null;
    logCheckpoints?: string | null;
    logLockWaits?: string | null;
    logTempFiles?: string | null;
    logAutovacuumMinDuration?: string | null;
  };
  ioByBackend?: Array<{
    backendType: string;
    object: string;
    reads: number;
    writes: number;
    writebacks: number;
    extends: number;
    fsyncs: number;
    hits: number;
    evictions: number;
    reuses: number;
  }>;
  sourceNotes?: string[];
};

export type GfsValidationResult = {
  recommendation: string;
  validationType: 'latency' | 'config' | 'maintenance';
  branchName: string;
  checkpointCommit: string;
  afterCommit: string;
  actionTaken: string;
  beforeTimeMs: number | null;
  afterTimeMs: number | null;
  beforeReadBlocks: number | null;
  afterReadBlocks: number | null;
  beforeHitBlocks: number | null;
  afterHitBlocks: number | null;
  deltaMs: number | null;
  deltaPct: number | null;
  recommendationStatus: 'validated' | 'rejected' | 'inconclusive';
  benchmarkSuitability: 'latency-impact' | 'low-latency' | 'non-latency';
  rollback: string;
};

export type BuildAuditReportInput = {
  engine: string;
  datasourceId?: string;
  database?: string;
  planInsights: PlanInsightInput[];
  slowQueries?: SlowQueryInput[];
  indexHealth?: IndexHealthInput;
  tableHealth?: TableHealthInput;
  infraSignals?: InfraSignalsInput;
  lockSignals?: LockSignalsInput;
  configGaps?: ConfigGapInput;
  gfsValidations?: GfsValidationResult[];
};

export type AuditTaskStatus = 'completed' | 'partial' | 'not-collected';

export type AuditTask = {
  id: string;
  title: string;
  status: AuditTaskStatus;
  evidence: string[];
};

export type AuditReport = {
  engine: string;
  generatedAt: string;
  scope: { datasourceId: string; database?: string };
  summary: string;
  severitySummary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  crossLayerSignals: string[];
  auditTasks: AuditTask[];
  findings: AuditFinding[];
  quickWins: string[];
  nextSteps: string[];
  gfsValidations: GfsValidationResult[];
  incompleteReason?: string;
};

const severityOrder: Record<AuditSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const MIN_FINDING_EXECUTION_TIME_MS = 150;
const MB = 1024 * 1024;
const GB = 1024 * MB;

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

function severityFromLatency(executionTimeMs: number): AuditSeverity {
  if (executionTimeMs >= 5000) return 'critical';
  if (executionTimeMs >= 2000) return 'high';
  if (executionTimeMs >= 500) return 'medium';
  if (executionTimeMs >= 150) return 'low';
  return 'info';
}

function isActionablePlanInsight(insight: PlanInsightInput): boolean {
  if (insight.executionTimeMs < MIN_FINDING_EXECUTION_TIME_MS) {
    return false;
  }

  const normalizedQuery = insight.query.trim().toLowerCase();
  if (
    normalizedQuery.includes('information_schema.') ||
    normalizedQuery.includes('pg_catalog.')
  ) {
    return false;
  }

  return (
    normalizedQuery.startsWith('select') || normalizedQuery.startsWith('with')
  );
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
}

function extractPrimaryTable(query: string): string | null {
  const match = query.match(/\bfrom\s+([a-zA-Z0-9_."']+)/i);
  if (!match || !match[1]) return null;
  return match[1].replace(/"/g, '');
}

function hasAnyValue(
  value:
    | Record<string, string | number | boolean | null | undefined>
    | undefined,
): boolean {
  if (!value) return false;
  return Object.values(value).some(
    (item) => item !== null && item !== undefined && item !== '',
  );
}

function statusFromFlags(
  completed: boolean,
  partial: boolean,
): AuditTaskStatus {
  if (completed) return 'completed';
  if (partial) return 'partial';
  return 'not-collected';
}

function createCrossLayerSignals(infraSignals?: InfraSignalsInput): string[] {
  if (!infraSignals) return [];

  const signals: string[] = [];
  const utilizationPct = infraSignals.connection?.utilizationPct;
  const networkWaitSessions =
    infraSignals.network?.networkWaitSessions ??
    infraSignals.waits?.networkWaitSessions;
  const lockWaitSessions = infraSignals.waits?.lockWaitSessions;
  const cacheHitPct = infraSignals.io?.cacheHitPct;
  const tempBytes = infraSignals.io?.tempBytes;

  if (typeof utilizationPct === 'number' && utilizationPct >= 75) {
    signals.push(
      `Connection pressure is elevated (${utilizationPct.toFixed(2)}% of max connections in use).`,
    );
  }

  if (typeof networkWaitSessions === 'number' && networkWaitSessions > 0) {
    signals.push(
      `Active client/network waits detected (${networkWaitSessions} session(s) on ClientRead/ClientWrite).`,
    );
  }

  if (typeof lockWaitSessions === 'number' && lockWaitSessions > 0) {
    signals.push(
      `Lock contention is visible (${lockWaitSessions} active lock-wait session(s)).`,
    );
  }

  if (typeof cacheHitPct === 'number' && cacheHitPct < 97) {
    signals.push(
      `Buffer cache hit ratio is below OLTP-friendly range (${cacheHitPct.toFixed(2)}%).`,
    );
  }

  if (typeof tempBytes === 'number' && tempBytes >= 128 * 1024 * 1024) {
    signals.push(
      `Temp file footprint is high (${formatBytes(tempBytes)}), indicating spill pressure.`,
    );
  }

  if (signals.length === 0 && infraSignals.sourceNotes?.length) {
    return infraSignals.sourceNotes.slice(0, 2);
  }

  return signals.slice(0, 4);
}

function createInfraEvidence(
  insight: PlanInsightInput,
  infraSignals?: InfraSignalsInput,
): string[] {
  if (!infraSignals) return [];

  const evidence: string[] = [];
  const seqScanNodes = insight.seqScanNodes ?? 0;
  const executionTimeMs = insight.executionTimeMs;

  const cacheHitPct = infraSignals.io?.cacheHitPct;
  if (seqScanNodes > 0 && typeof cacheHitPct === 'number' && cacheHitPct < 97) {
    evidence.push(
      `Infra metric: cache hit ratio is ${cacheHitPct.toFixed(2)}%, so sequential scans increase storage IO exposure.`,
    );
  }

  const lockWaitSessions = infraSignals.waits?.lockWaitSessions;
  if (
    executionTimeMs >= 1000 &&
    typeof lockWaitSessions === 'number' &&
    lockWaitSessions > 0
  ) {
    evidence.push(
      `Infra metric: ${lockWaitSessions} active session(s) are waiting on locks, which can amplify tail latency.`,
    );
  }

  const networkWaitSessions =
    infraSignals.network?.networkWaitSessions ??
    infraSignals.waits?.networkWaitSessions;
  const activeSessions = infraSignals.connection?.activeSessions;
  if (
    executionTimeMs >= 1000 &&
    typeof networkWaitSessions === 'number' &&
    networkWaitSessions > 0 &&
    typeof activeSessions === 'number' &&
    activeSessions > 0
  ) {
    const pct = Number(
      ((networkWaitSessions / activeSessions) * 100).toFixed(2),
    );
    evidence.push(
      `Infra metric: ClientRead/ClientWrite waits account for ${pct.toFixed(2)}% of active sessions in this sample window.`,
    );
  }

  const tempBytes = infraSignals.io?.tempBytes;
  if (
    executionTimeMs >= 1000 &&
    typeof tempBytes === 'number' &&
    tempBytes >= 128 * 1024 * 1024
  ) {
    evidence.push(
      `Infra metric: temp usage is ${formatBytes(tempBytes)}, consistent with spill-heavy sort/hash patterns.`,
    );
  }

  const utilizationPct = infraSignals.connection?.utilizationPct;
  if (
    executionTimeMs >= 500 &&
    typeof utilizationPct === 'number' &&
    utilizationPct >= 75
  ) {
    evidence.push(
      `Infra metric: connection utilization is ${utilizationPct.toFixed(2)}%, reducing concurrency headroom during spikes.`,
    );
  }

  return evidence;
}

function createFindingFromPlanInsight(
  insight: PlanInsightInput,
  index: number,
  infraSignals?: InfraSignalsInput,
): AuditFinding {
  const severity = severityFromLatency(insight.executionTimeMs);
  const seqScanNodes = insight.seqScanNodes ?? 0;
  const indexScanNodes = insight.indexScanNodes ?? 0;
  const estimatedRows = insight.planRows ?? 0;
  const actualRows = insight.actualRows ?? 0;
  const rowSkew =
    estimatedRows > 0 && actualRows > 0
      ? Number((actualRows / estimatedRows).toFixed(2))
      : null;

  const table = extractPrimaryTable(insight.query);
  const tableToken = table
    ? sanitizeIdentifier(table.split('.').pop() ?? 'table')
    : 'table';

  const evidence = [
    `Plan evidence: ${seqScanNodes} sequential scan node(s), ${indexScanNodes} index scan node(s).`,
    `Metric evidence: execution time ${insight.executionTimeMs.toFixed(2)} ms.`,
  ];

  if (typeof insight.planningTimeMs === 'number') {
    evidence.push(`Planning time: ${insight.planningTimeMs.toFixed(2)} ms.`);
  }

  if (rowSkew !== null) {
    evidence.push(
      `Cardinality skew: actual/estimated rows ratio ${rowSkew.toFixed(2)}x.`,
    );
  }

  evidence.push(...createInfraEvidence(insight, infraSignals));

  const recommendation = [
    'Alternative 1 (Preferred): Add or adjust a targeted index on the filter/join columns used by this query to reduce scanned rows and latency.',
    'Trade-off: Better read latency, but extra write overhead and index maintenance cost.',
    'Alternative 2: Rewrite the query to filter earlier, narrow projection, and reduce row explosion before joins.',
    'Trade-off: Lower runtime and memory pressure, but higher query complexity and maintenance effort.',
    'Validation pair: capture a baseline EXPLAIN ANALYZE now, then rerun the same EXPLAIN ANALYZE after the change and compare execution time plus shared read blocks.',
  ].join('\n');

  const validationSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${insight.query.trim().replace(/;+$/, '')};`;

  return {
    id: `finding_${index + 1}`,
    title: `High-latency query plan candidate #${index + 1}`,
    severity,
    category: 'query-plan',
    evidence,
    impact:
      'This query contributes directly to end-user latency and can amplify response-time tails under load.',
    recommendation,
    sql: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableToken}_audit_candidate ON ${table ?? 'public.<target_table>'} (<filter_or_join_column>);`,
      `-- Alternative query rewrite: refactor ${table ?? '<target_table>'} access path for earlier filtering and narrower projection.`,
      validationSql,
      validationSql,
    ],
    confidence: rowSkew !== null ? 0.88 : 0.8,
  };
}

function createSummary(
  findings: AuditFinding[],
  crossLayerSignals: string[],
): string {
  if (findings.length === 0) {
    return 'No latency-impact findings met the strict plan+metric evidence rule. Run explain_query_plan on user-facing slow SELECT/WITH queries to produce auditable findings.';
  }

  const top = findings.slice(0, 3);
  const fragments = top.map((finding, index) => {
    const firstEvidence = finding.evidence[1] ?? finding.evidence[0] ?? '';
    return `${index + 1}) ${finding.severity.toUpperCase()}: ${finding.title} (${firstEvidence})`;
  });

  const base = `Top ${top.length} latency-impact findings: ${fragments.join(' | ')}`;
  if (crossLayerSignals.length === 0) {
    return base;
  }
  return `${base} Cross-layer context: ${crossLayerSignals[0]}`;
}

// ---------------------------------------------------------------------------
// New finding generators: index, vacuum, lock contention, config gaps
// ---------------------------------------------------------------------------

function createUnusedIndexFinding(
  index: NonNullable<IndexHealthInput['unusedIndexes']>[number],
  findingIndex: number,
): AuditFinding | null {
  // Only produce a finding for drop-candidates with material size
  if (index.sizeBytes < MB) return null;
  if (index.isUnique || index.isPrimary || index.backsConstraint) return null;

  const severity: AuditSeverity =
    index.sizeBytes >= 100 * MB ? 'medium' : 'low';
  const sizeLabel = formatBytes(index.sizeBytes);
  const qualifiedIndex = `${index.schema}.${index.index}`;
  const qualifiedTable = `${index.schema}.${index.table}`;

  return {
    id: `unused_index_${findingIndex + 1}`,
    title: `Unused index consuming ${sizeLabel}: ${qualifiedIndex}`,
    severity,
    category: 'indexing',
    evidence: [
      `Index ${qualifiedIndex} on table ${qualifiedTable} has 0 scans since last pg_stat reset.`,
      `Index size: ${sizeLabel}.`,
      `Confirmed drop candidate: isPrimary=false, backsConstraint=false, isUnique=false.`,
    ],
    impact:
      'Unused indexes consume storage, slow down write operations (INSERT/UPDATE/DELETE), and inflate WAL volume without providing any query acceleration.',
    recommendation: [
      'Alternative 1 (Preferred): Drop the index after verifying it is not used by application code or scheduled jobs. Use a monitoring window to confirm zero usage.',
      'Trade-off: Immediate write-path improvement and storage recovery, but requires rollback plan if a query path was missed.',
      'Alternative 2: Keep the index and schedule a review after enabling pg_stat_statements for a full workload window to confirm zero usage across all query patterns.',
      'Trade-off: No risk, but no benefit either — deferred action.',
      'Validation: Re-run get_index_health after the monitoring window and confirm idx_scan remains 0.',
    ].join('\n'),
    sql: [
      `-- Prerequisite check: confirm index is safe to drop`,
      `SELECT i.indisprimary, i.indisunique,`,
      `       EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid) AS backs_constraint`,
      `FROM pg_stat_user_indexes ix`,
      `JOIN pg_index i ON i.indexrelid = ix.indexrelid`,
      `WHERE ix.indexrelname = '${index.index}';`,
      ``,
      `-- Drop when confirmed safe`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${qualifiedIndex};`,
    ],
    confidence: 0.85,
  };
}

function createDuplicateIndexFinding(
  dup: NonNullable<IndexHealthInput['duplicateIndexes']>[number],
  findingIndex: number,
): AuditFinding | null {
  if (dup.duplicateCount < 2) return null;

  const qualifiedTable = `${dup.schema}.${dup.table}`;
  const nameList = dup.indexNames.join(', ');
  const sizeNote =
    dup.totalSizeBytes != null && dup.totalSizeBytes > 0
      ? ` (combined size: ${formatBytes(dup.totalSizeBytes)})`
      : '';

  return {
    id: `duplicate_index_${findingIndex + 1}`,
    title: `Duplicate index group on ${qualifiedTable}: ${dup.duplicateCount} indexes with identical signature`,
    severity: 'medium',
    category: 'indexing',
    evidence: [
      `Table ${qualifiedTable} has ${dup.duplicateCount} indexes with the same effective definition: ${nameList}.`,
      `Index signature: ${dup.indexSignature}${sizeNote}.`,
      `PostgreSQL will maintain all duplicates on every write, multiplying write overhead.`,
    ],
    impact:
      'Duplicate indexes impose redundant write overhead on every INSERT/UPDATE/DELETE and waste storage. Only one of the duplicates is needed.',
    recommendation: [
      'Alternative 1 (Preferred): Keep the index with the most descriptive name or the oldest creation date (typically the one constraining a PK/FK), and DROP CONCURRENTLY the others.',
      'Trade-off: Immediate write-path and storage savings with minimal risk if done with CONCURRENTLY.',
      'Alternative 2: Rename duplicates to a "_deprecated" suffix and monitor idx_scan for a week before dropping.',
      'Trade-off: No immediate win, but safer if query-level index hints are in use (rare in PostgreSQL).',
    ].join('\n'),
    sql: [
      `-- List all duplicates for this group`,
      `SELECT indexname, pg_relation_size(indexrelid) AS size_bytes, idx_scan`,
      `FROM pg_stat_user_indexes`,
      `WHERE relname = '${dup.table}' AND schemaname = '${dup.schema}'`,
      `  AND indexrelname = ANY(ARRAY[${dup.indexNames.map((n) => `'${n}'`).join(', ')}]);`,
      ``,
      `-- Drop one duplicate (keep the other) — adjust name as needed`,
      `DROP INDEX CONCURRENTLY IF EXISTS ${dup.schema}.${dup.indexNames[dup.indexNames.length - 1]};`,
    ],
    confidence: 0.9,
  };
}

function createVacuumFinding(
  table: TableHealthInput[number],
  findingIndex: number,
): AuditFinding | null {
  const isAutovacuumDisabled =
    typeof table.autovacuumEnabledOverride === 'string' &&
    table.autovacuumEnabledOverride.toLowerCase() === 'off';

  const highDeadTuples = table.deadTuplePct >= 15;
  const longSinceVacuum =
    typeof table.secondsSinceVacuum === 'number' &&
    table.secondsSinceVacuum > 7 * 24 * 3600; // > 7 days

  const highModSinceAnalyze =
    typeof table.modSinceAnalyze === 'number' &&
    typeof table.liveTuples === 'number' &&
    table.liveTuples > 0 &&
    table.modSinceAnalyze / table.liveTuples > 0.1;

  if (
    !isAutovacuumDisabled &&
    !highDeadTuples &&
    !longSinceVacuum &&
    !highModSinceAnalyze
  ) {
    return null;
  }

  const qualifiedTable = `${table.schema}.${table.table}`;
  const severity: AuditSeverity = isAutovacuumDisabled
    ? 'high'
    : table.deadTuplePct >= 30
      ? 'high'
      : 'medium';

  const evidence: string[] = [];
  if (highDeadTuples) {
    const bloatBytes = (table.deadTuplePct / 100) * table.totalSizeBytes;
    evidence.push(
      `Dead tuple percentage: ${table.deadTuplePct.toFixed(2)}% (estimated bloat: ~${formatBytes(bloatBytes)} of ${formatBytes(table.totalSizeBytes)} total).`,
    );
  }
  if (isAutovacuumDisabled) {
    evidence.push(
      `autovacuum is explicitly DISABLED on this table via storage parameter.`,
    );
  }
  if (longSinceVacuum && typeof table.secondsSinceVacuum === 'number') {
    const days = (table.secondsSinceVacuum / 86400).toFixed(1);
    const lastTs = table.lastAutovacuum ?? table.lastVacuum ?? 'never';
    evidence.push(`Last vacuum: ${lastTs} (${days} days ago).`);
  }
  if (highModSinceAnalyze && typeof table.modSinceAnalyze === 'number') {
    evidence.push(
      `${table.modSinceAnalyze.toLocaleString()} rows modified since last ANALYZE — statistics may be stale, leading to cardinality misestimates.`,
    );
  }

  return {
    id: `vacuum_bloat_${findingIndex + 1}`,
    title: `Vacuum/bloat risk on ${qualifiedTable}: ${isAutovacuumDisabled ? 'autovacuum disabled' : `${table.deadTuplePct.toFixed(1)}% dead tuples`}`,
    severity,
    category: 'table-stats',
    evidence,
    impact:
      'Excessive dead tuples inflate table size, degrade sequential and index scan performance by increasing page reads, and can eventually lead to transaction ID wraparound if not addressed.',
    recommendation: [
      'Alternative 1 (Preferred): Run VACUUM ANALYZE on this table during a low-traffic window to reclaim dead tuple space and refresh statistics.',
      'Trade-off: Fast and safe for VACUUM (non-blocking), but may hold a brief share lock for ANALYZE.',
      isAutovacuumDisabled
        ? 'Alternative 2: Re-enable autovacuum on this table (remove autovacuum_enabled=off from storage parameters) and tune scale factor/threshold for its churn rate.'
        : 'Alternative 2: Tune autovacuum_vacuum_scale_factor and autovacuum_vacuum_threshold for this table to trigger vacuums more aggressively given its write rate.',
      'Trade-off: Requires a configuration change and monitoring window to confirm autovacuum keeps pace.',
      `Validation: Re-run get_table_health after the action and confirm n_dead_tup drops below 5% and last_autovacuum timestamp advances.`,
    ].join('\n'),
    sql: [
      `-- Immediate relief`,
      `VACUUM (ANALYZE, VERBOSE) ${qualifiedTable};`,
      ``,
      isAutovacuumDisabled
        ? `-- Re-enable autovacuum\nALTER TABLE ${qualifiedTable} RESET (autovacuum_enabled);`
        : `-- Tune autovacuum for high-churn table\nALTER TABLE ${qualifiedTable} SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.005);`,
      ``,
      `-- Validation: check dead tuple % after vacuum`,
      `SELECT relname, n_dead_tup, n_live_tup,`,
      `       ROUND(n_dead_tup::numeric / NULLIF(n_live_tup + n_dead_tup, 0) * 100, 2) AS dead_pct`,
      `FROM pg_stat_user_tables WHERE relname = '${table.table}';`,
    ],
    confidence: isAutovacuumDisabled ? 0.95 : 0.85,
  };
}

function createLockContentionFinding(
  lockSignals: LockSignalsInput,
  findingIndex: number,
): AuditFinding | null {
  const blockingChains = lockSignals.blockingChainCount ?? 0;
  const idleInTransaction = lockSignals.idleInTransactionCount ?? 0;
  const lockWaitSessions = lockSignals.lockWaitSessions ?? 0;
  const deadlocks = lockSignals.deadlockCount ?? 0;

  if (
    blockingChains === 0 &&
    idleInTransaction === 0 &&
    lockWaitSessions === 0 &&
    deadlocks === 0
  ) {
    return null;
  }

  const severity: AuditSeverity =
    deadlocks > 0 || blockingChains >= 3
      ? 'high'
      : blockingChains > 0 || idleInTransaction >= 3
        ? 'medium'
        : 'low';

  const evidence: string[] = [];
  if (blockingChains > 0) {
    evidence.push(
      `${blockingChains} active blocking chain(s) detected via pg_blocking_pids().`,
    );
  }
  if (idleInTransaction > 0) {
    const maxSecs = lockSignals.maxIdleInTransactionSeconds;
    evidence.push(
      `${idleInTransaction} session(s) in 'idle in transaction' state${maxSecs != null ? ` (longest: ${maxSecs.toFixed(0)}s)` : ''} — holding locks while doing nothing.`,
    );
  }
  if (lockWaitSessions > 0) {
    evidence.push(
      `${lockWaitSessions} active session(s) waiting on lock acquisition.`,
    );
  }
  if (deadlocks > 0) {
    evidence.push(
      `${deadlocks} cumulative deadlock(s) recorded in pg_stat_database since last reset.`,
    );
  }

  return {
    id: `lock_contention_${findingIndex + 1}`,
    title: `Lock contention: ${blockingChains} blocking chain(s), ${idleInTransaction} idle-in-transaction session(s)`,
    severity,
    category: 'locks-waits',
    evidence,
    impact:
      'Lock contention directly causes query queuing and tail-latency spikes. Idle-in-transaction sessions hold row-level locks indefinitely, blocking concurrent writers and escalating to table-level lock waits.',
    recommendation: [
      'Alternative 1 (Preferred): Identify and terminate long-running idle-in-transaction sessions with pg_terminate_backend(), then set idle_in_transaction_session_timeout to prevent recurrence.',
      'Trade-off: Immediate contention relief; terminated sessions may lose in-flight work.',
      'Alternative 2: Shorten transaction scope in application code — commit or rollback sooner, and avoid application-level think-time inside transactions.',
      'Trade-off: Requires application change but is the correct long-term fix.',
      'Validation: Re-run get_lock_and_blocking_analysis and confirm blockingChains=0 and idleInTransactionSessions=[]. Monitor pg_stat_database.deadlocks for reduction.',
    ].join('\n'),
    sql: [
      `-- Identify current blocker chain`,
      `SELECT blocked.pid, blocked.usename, blocked.state,`,
      `       blocker.pid AS blocker_pid, blocker.usename AS blocker_user,`,
      `       blocker.state AS blocker_state, blocker.query AS blocker_query`,
      `FROM pg_stat_activity blocked`,
      `JOIN pg_stat_activity blocker`,
      `  ON blocker.pid = ANY(pg_blocking_pids(blocked.pid))`,
      `WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;`,
      ``,
      `-- Terminate idle-in-transaction sessions older than 5 minutes`,
      `SELECT pg_terminate_backend(pid)`,
      `FROM pg_stat_activity`,
      `WHERE state = 'idle in transaction'`,
      `  AND state_change < clock_timestamp() - interval '5 minutes';`,
      ``,
      `-- Prevent future idle-in-transaction accumulation`,
      `ALTER SYSTEM SET idle_in_transaction_session_timeout = '5min';`,
      `SELECT pg_reload_conf();`,
    ],
    confidence: blockingChains > 0 ? 0.95 : 0.8,
  };
}

function createConfigGapFindings(config: ConfigGapInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let idx = 0;

  // track_io_timing off
  if (config.trackIoTiming && config.trackIoTiming.startsWith('off')) {
    findings.push({
      id: `config_gap_${++idx}`,
      title:
        'track_io_timing is off — storage latency invisible to diagnostics',
      severity: 'medium',
      category: 'configuration',
      evidence: [
        'track_io_timing=off means blk_read_time and blk_write_time in pg_stat_database and pg_stat_statements are always 0.',
        'Without IO timing, the agent cannot distinguish between CPU-bound and IO-bound slow queries.',
      ],
      impact:
        'Inability to measure actual storage read/write latency hides disk bottlenecks and prevents accurate diagnosis of IO-bound queries.',
      recommendation: [
        'Enable track_io_timing: ALTER SYSTEM SET track_io_timing = on; SELECT pg_reload_conf();',
        'This adds a small overhead per block read/write (typically <1% on modern hardware).',
        'Validation: Check blk_read_time > 0 in pg_stat_database after enabling.',
      ].join('\n'),
      sql: [
        `ALTER SYSTEM SET track_io_timing = on;`,
        `SELECT pg_reload_conf();`,
        `-- Validation`,
        `SELECT blk_read_time, blk_write_time FROM pg_stat_database WHERE datname = current_database();`,
      ],
      confidence: 0.99,
    });
  }

  // pg_stat_statements not enabled
  if (config.pgStatStatementsEnabled === false) {
    findings.push({
      id: `config_gap_${++idx}`,
      title: 'pg_stat_statements not enabled — workload profiling unavailable',
      severity: 'high',
      category: 'configuration',
      evidence: [
        'pg_stat_statements extension is not loaded. Slow query candidates were sourced from pg_stat_activity (point-in-time snapshot only).',
        'Without pg_stat_statements, cumulative per-query statistics (total time, call count, stddev) are unavailable.',
      ],
      impact:
        'Workload profiling is severely degraded. Top-N slow queries by total execution time, high-call queries, and query variance cannot be identified.',
      recommendation: [
        "Add 'pg_stat_statements' to shared_preload_libraries in postgresql.conf and restart PostgreSQL.",
        'Then run: CREATE EXTENSION IF NOT EXISTS pg_stat_statements;',
        'This is the single highest-value observability improvement for any PostgreSQL instance.',
      ].join('\n'),
      sql: [
        `-- Add to postgresql.conf (requires restart):`,
        `-- shared_preload_libraries = 'pg_stat_statements'`,
        ``,
        `-- After restart:`,
        `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`,
        ``,
        `-- Verify`,
        `SELECT * FROM pg_stat_statements LIMIT 5;`,
      ],
      confidence: 0.99,
    });
  }

  // log_min_duration_statement not set
  if (
    config.logMinDurationStatement === null ||
    config.logMinDurationStatement === undefined ||
    config.logMinDurationStatement === '-1'
  ) {
    findings.push({
      id: `config_gap_${++idx}`,
      title:
        'log_min_duration_statement is disabled — slow queries not captured in logs',
      severity: 'low',
      category: 'configuration',
      evidence: [
        'log_min_duration_statement=-1 (disabled). Slow queries will not appear in PostgreSQL logs.',
        'Without this setting, log-based slow query analysis is impossible and incidents cannot be reconstructed after the fact.',
      ],
      impact:
        'Slow query incidents cannot be diagnosed from logs. Post-incident analysis is severely limited.',
      recommendation: [
        'Set log_min_duration_statement to 500 or 1000 (milliseconds) to capture slow queries.',
        'ALTER SYSTEM SET log_min_duration_statement = 500;',
        'Combined with pg_stat_statements, this provides both cumulative and per-incident slow query visibility.',
      ].join('\n'),
      sql: [
        `ALTER SYSTEM SET log_min_duration_statement = 500; -- log queries > 500ms`,
        `SELECT pg_reload_conf();`,
      ],
      confidence: 0.95,
    });
  }

  return findings;
}

function createQuickWins(
  input: BuildAuditReportInput,
  findings: AuditFinding[],
  gfsValidations: GfsValidationResult[],
): string[] {
  const validatedQuickWins = gfsValidations
    .filter((validation) => validation.recommendationStatus === 'validated')
    .map((validation) => `Validated in GFS: ${validation.recommendation}`);

  if (validatedQuickWins.length > 0) {
    return Array.from(new Set(validatedQuickWins)).slice(0, 5);
  }

  if (findings.length === 0) {
    return [];
  }

  return [];
}

function createNextSteps(
  findings: AuditFinding[],
  gfsValidations: GfsValidationResult[] = [],
): string[] {
  const validatedNextSteps = gfsValidations
    .filter((validation) => validation.recommendationStatus === 'validated')
    .map(
      (validation) =>
        `Use the validated GFS evidence for ${validation.recommendation.toLowerCase()} before any rollout decision.`,
    );

  if (validatedNextSteps.length > 0) {
    return Array.from(new Set(validatedNextSteps)).slice(0, 3);
  }

  if (findings.length === 0) {
    return [];
  }

  return [];
}

function sanitizeFindingRecommendations(
  findings: AuditFinding[],
): AuditFinding[] {
  return findings.map((finding) => ({
    ...finding,
    recommendation:
      'Remediation details are reported only through executed GFS validations.',
    sql: undefined,
  }));
}

function createAuditTasks(input: BuildAuditReportInput): AuditTask[] {
  const slowQueryCount = input.slowQueries?.length ?? 0;
  const planInsightCount = input.planInsights.length;
  const infra = input.infraSignals;

  const networkWaitSessions =
    infra?.network?.networkWaitSessions ?? infra?.waits?.networkWaitSessions;
  const clientReadWaitSessions =
    infra?.network?.clientReadWaitSessions ??
    infra?.waits?.activeWaitEvents?.find(
      (event) => event.waitEvent === 'ClientRead',
    )?.sessions;
  const clientWriteWaitSessions =
    infra?.network?.clientWriteWaitSessions ??
    infra?.waits?.activeWaitEvents?.find(
      (event) => event.waitEvent === 'ClientWrite',
    )?.sessions;

  const osCompleted =
    !!infra &&
    (!!infra.postgresVersion ||
      !!infra.os?.uptimeSeconds ||
      !!infra.os?.dataDirectory);
  const cpuCompleted =
    !!infra?.cpu &&
    (typeof infra.cpu.runningActiveSessions === 'number' ||
      typeof infra.cpu.waitingActiveSessions === 'number' ||
      typeof infra.cpu.maxWorkerProcesses === 'number');
  const diskCompleted =
    !!infra?.io &&
    (typeof infra.io.blksRead === 'number' ||
      typeof infra.io.tempBytes === 'number') &&
    !!infra?.checkpoints;
  const configCompleted = hasAnyValue(infra?.config);
  const loggingCompleted = hasAnyValue(infra?.logging);

  return [
    {
      id: 'collect_query_workload',
      title: 'Collect query workload candidates',
      status: statusFromFlags(slowQueryCount > 0, false),
      evidence:
        slowQueryCount > 0
          ? [`Captured ${slowQueryCount} slow-query candidate(s).`]
          : ['No slow-query candidates were captured in this run.'],
    },
    {
      id: 'collect_query_plans',
      title: 'Collect explain plan evidence',
      status: statusFromFlags(planInsightCount > 0, false),
      evidence:
        planInsightCount > 0
          ? [
              `Collected plan+metric evidence for ${planInsightCount} query(ies).`,
            ]
          : ['No explain_query_plan evidence was provided.'],
    },
    {
      id: 'collect_os_metadata',
      title: 'Collect OS/runtime metadata',
      status: statusFromFlags(osCompleted, !!infra),
      evidence: [
        infra?.postgresVersion
          ? `PostgreSQL version: ${infra.postgresVersion}.`
          : 'PostgreSQL version metadata not captured.',
        typeof infra?.os?.uptimeSeconds === 'number'
          ? `Server uptime seconds: ${infra.os.uptimeSeconds.toFixed(0)}.`
          : 'Uptime metadata not captured.',
      ],
    },
    {
      id: 'collect_network_signals',
      title: 'Collect network wait signals',
      status: statusFromFlags(
        typeof networkWaitSessions === 'number',
        !!infra?.waits || !!infra?.network,
      ),
      evidence: [
        typeof networkWaitSessions === 'number'
          ? `Active client/network wait sessions: ${networkWaitSessions}.`
          : 'Network wait sessions were not captured.',
        `ClientRead waits: ${clientReadWaitSessions ?? 0}; ClientWrite waits: ${clientWriteWaitSessions ?? 0}.`,
      ],
    },
    {
      id: 'collect_cpu_signals',
      title: 'Collect CPU/concurrency proxies',
      status: statusFromFlags(
        cpuCompleted,
        !!infra?.connection || !!infra?.cpu,
      ),
      evidence: [
        typeof infra?.cpu?.runningActiveSessions === 'number'
          ? `Running active sessions: ${infra.cpu.runningActiveSessions}.`
          : 'Running active session count not captured.',
        typeof infra?.cpu?.maxParallelWorkers === 'number'
          ? `max_parallel_workers: ${infra.cpu.maxParallelWorkers}.`
          : 'Parallel worker config not captured.',
      ],
    },
    {
      id: 'collect_disk_signals',
      title: 'Collect disk and checkpoint signals',
      status: statusFromFlags(
        diskCompleted,
        !!infra?.io || !!infra?.checkpoints,
      ),
      evidence: [
        typeof infra?.io?.tempBytes === 'number'
          ? `Temp bytes observed: ${formatBytes(infra.io.tempBytes)}.`
          : 'Temp byte metric not captured.',
        typeof infra?.io?.cacheHitPct === 'number'
          ? `Buffer cache hit ratio: ${infra.io.cacheHitPct.toFixed(2)}%.`
          : 'Cache hit ratio not captured.',
      ],
    },
    {
      id: 'collect_config_metadata',
      title: 'Collect configuration metadata',
      status: statusFromFlags(configCompleted, !!infra),
      evidence: [
        infra?.config?.workMem
          ? `work_mem: ${infra.config.workMem}.`
          : 'work_mem setting not captured.',
        infra?.config?.trackIoTiming
          ? `track_io_timing: ${infra.config.trackIoTiming}.`
          : 'track_io_timing setting not captured.',
      ],
    },
    {
      id: 'collect_logging_metadata',
      title: 'Collect logging metadata',
      status: statusFromFlags(loggingCompleted, !!infra),
      evidence: [
        infra?.logging?.loggingCollector
          ? `logging_collector: ${infra.logging.loggingCollector}.`
          : 'logging_collector setting not captured.',
        infra?.logging?.logMinDurationStatement
          ? `log_min_duration_statement: ${infra.logging.logMinDurationStatement}.`
          : 'log_min_duration_statement setting not captured.',
      ],
    },
  ];
}

export function buildAuditReport(input: BuildAuditReportInput): AuditReport {
  const crossLayerSignals = createCrossLayerSignals(input.infraSignals);
  const auditTasks = createAuditTasks(input);

  // ------------------------------------------------------------------
  // 1. Query plan findings (existing — strict plan+metric evidence gate)
  // ------------------------------------------------------------------
  const planFindings = input.planInsights
    .filter((insight) => isActionablePlanInsight(insight))
    .sort((left, right) => right.executionTimeMs - left.executionTimeMs)
    .map((insight, index) =>
      createFindingFromPlanInsight(insight, index, input.infraSignals),
    );

  // ------------------------------------------------------------------
  // 2. Unused index findings
  // ------------------------------------------------------------------
  const unusedIndexFindings: AuditFinding[] = [];
  for (const [i, idx] of (input.indexHealth?.unusedIndexes ?? []).entries()) {
    const finding = createUnusedIndexFinding(idx, i);
    if (finding) unusedIndexFindings.push(finding);
  }

  // ------------------------------------------------------------------
  // 3. Duplicate index findings
  // ------------------------------------------------------------------
  const duplicateIndexFindings: AuditFinding[] = [];
  for (const [i, dup] of (
    input.indexHealth?.duplicateIndexes ?? []
  ).entries()) {
    const finding = createDuplicateIndexFinding(dup, i);
    if (finding) duplicateIndexFindings.push(finding);
  }

  // ------------------------------------------------------------------
  // 4. Vacuum / bloat findings
  // ------------------------------------------------------------------
  const vacuumFindings: AuditFinding[] = [];
  for (const [i, table] of (input.tableHealth ?? []).entries()) {
    const finding = createVacuumFinding(table, i);
    if (finding) vacuumFindings.push(finding);
  }

  // ------------------------------------------------------------------
  // 5. Lock contention finding
  // ------------------------------------------------------------------
  const lockFindings: AuditFinding[] = [];
  if (input.lockSignals) {
    const finding = createLockContentionFinding(input.lockSignals, 0);
    if (finding) lockFindings.push(finding);
  } else {
    // Derive from infraSignals when no explicit lockSignals provided
    const lockWaitSessions = input.infraSignals?.waits?.lockWaitSessions ?? 0;
    if (lockWaitSessions > 0) {
      const derived = createLockContentionFinding(
        {
          lockWaitSessions,
          deadlockCount: input.infraSignals?.io?.deadlocks ?? 0,
        },
        0,
      );
      if (derived) lockFindings.push(derived);
    }
  }

  // ------------------------------------------------------------------
  // 6. Configuration gap findings
  // ------------------------------------------------------------------
  const configFindings: AuditFinding[] = [];
  if (input.configGaps) {
    configFindings.push(...createConfigGapFindings(input.configGaps));
  } else if (
    input.infraSignals &&
    (hasAnyValue(input.infraSignals.config) ||
      hasAnyValue(input.infraSignals.logging))
  ) {
    // Derive config gaps from infraSignals when no explicit configGaps provided
    const cfg = input.infraSignals.config;
    const logging = input.infraSignals.logging;
    configFindings.push(
      ...createConfigGapFindings({
        trackIoTiming: cfg?.trackIoTiming ?? null,
        logMinDurationStatement: logging?.logMinDurationStatement ?? null,
        logLockWaits: logging?.logLockWaits ?? null,
        logTempFiles: logging?.logTempFiles ?? null,
        randomPageCost: cfg?.randomPageCost ?? null,
        workMem: cfg?.workMem ?? null,
        sharedBuffers: cfg?.sharedBuffers ?? null,
        autovacuum: cfg?.autovacuum ?? null,
      }),
    );
  }

  // ------------------------------------------------------------------
  // 7. Merge all findings and sort by severity then confidence
  // ------------------------------------------------------------------
  const allFindings: AuditFinding[] = [
    ...planFindings,
    ...lockFindings,
    ...vacuumFindings,
    ...duplicateIndexFindings,
    ...unusedIndexFindings,
    ...configFindings,
  ]
    .sort((a, b) => {
      const severityDelta =
        severityOrder[b.severity] - severityOrder[a.severity];
      if (severityDelta !== 0) return severityDelta;
      return b.confidence - a.confidence;
    })
    .slice(0, 20);

  const sanitizedFindings = sanitizeFindingRecommendations(allFindings);

  const severitySummary = allFindings.reduce(
    (summary, finding) => {
      summary[finding.severity] += 1;
      return summary;
    },
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );

  const gfsValidations = input.gfsValidations ?? [];
  const validatedCount = gfsValidations.filter(
    (v) => v.recommendationStatus === 'validated',
  ).length;
  const rejectedCount = gfsValidations.filter(
    (v) => v.recommendationStatus === 'rejected',
  ).length;
  const inconclusiveCount = gfsValidations.filter(
    (v) => v.recommendationStatus === 'inconclusive',
  ).length;
  const incompleteReason =
    rejectedCount > 0 ||
    inconclusiveCount > 0 ||
    validatedCount < sanitizedFindings.length
      ? 'Audit incomplete: not all solutions could be executed in GFS.'
      : undefined;

  return {
    engine: input.engine,
    generatedAt: new Date().toISOString(),
    scope: {
      datasourceId: input.datasourceId ?? 'unknown',
      ...(input.database ? { database: input.database } : {}),
    },
    summary: createSummary(sanitizedFindings, crossLayerSignals),
    severitySummary,
    crossLayerSignals,
    auditTasks,
    findings: sanitizedFindings,
    quickWins: createQuickWins(input, sanitizedFindings, gfsValidations),
    nextSteps: createNextSteps(sanitizedFindings, gfsValidations),
    gfsValidations,
    incompleteReason,
  };
}
