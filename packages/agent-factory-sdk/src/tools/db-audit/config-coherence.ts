const MEBIBYTE = 1024 * 1024;

export const DEFAULT_OS_RESERVE_RATIO = 0.3;
export const DEFAULT_ACTIVE_COMPLEX_QUERIES = 2;
export const DEFAULT_SORT_HASH_OPS_PER_QUERY = 2;
export const DEFAULT_AUTOVACUUM_MAX_WORKERS = 3;
export const DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES = 64 * MEBIBYTE;
export const SQL_RUNTIME_SETTABLE_CONFIG_SETTINGS = new Set([
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'random_page_cost',
  'effective_io_concurrency',
  'max_parallel_workers_per_gather',
  'track_io_timing',
  'log_min_duration_statement',
  'log_lock_waits',
  'log_temp_files',
]);

export interface ConfigCoherenceInputs {
  totalMemoryBytes?: number | null;
  activeComplexQueries?: number | null;
  sortHashOpsPerQuery?: number | null;
  sharedBuffersBytes?: number | null;
  maintenanceWorkMemBytes?: number | null;
  autovacuumMaxWorkers?: number | null;
  autovacuumWorkMemBytes?: number | null;
  hashMemMultiplier?: number | null;
  logicalCpuCount?: number | null;
  maxParallelWorkersPerGather?: number | null;
}

export interface ConfigCoherenceResolution {
  sharedBuffersTargetBytes: number | null;
  effectiveCacheSizeTargetBytes: number | null;
  workMemTargetBytes: number | null;
  maxParallelWorkersPerGatherTarget: number | null;
  estimatedPeakMemoryBytes: number | null;
  assumptions: {
    reserveOsRatio: number;
    activeComplexQueries: number;
    activeComplexQueriesAssumed: boolean;
    sortHashOpsPerQuery: number;
    sortHashOpsPerQueryAssumed: boolean;
    autovacuumMaxWorkers: number;
    autovacuumMaxWorkersAssumed: boolean;
    workMemCapBytes: number;
    workMemCapped: boolean;
  };
  notes: string[];
}

export function normalizeConfigSettingName(setting: string): string {
  return setting.trim().replace(/^"|"$/g, '').toLowerCase();
}

export function isSqlRuntimeSettableConfigSetting(setting: string): boolean {
  return SQL_RUNTIME_SETTABLE_CONFIG_SETTINGS.has(
    normalizeConfigSettingName(setting),
  );
}

function normalizePositiveInteger(
  value: number | null | undefined,
  fallback: number,
): { value: number; assumed: boolean } {
  if (Number.isFinite(value) && value != null && value > 0) {
    return { value: Math.floor(value), assumed: false };
  }

  return { value: fallback, assumed: true };
}

function floorToMiB(bytes: number): number {
  return Math.max(MEBIBYTE, Math.floor(bytes / MEBIBYTE) * MEBIBYTE);
}

export function resolveConfigCoherence(
  input: ConfigCoherenceInputs,
): ConfigCoherenceResolution {
  const notes: string[] = [];
  const totalMemoryBytes = input.totalMemoryBytes ?? null;
  const logicalCpuCount = input.logicalCpuCount ?? null;
  const maxParallelWorkersPerGather =
    input.maxParallelWorkersPerGather ?? null;

  const activeComplexQueries = normalizePositiveInteger(
    input.activeComplexQueries,
    DEFAULT_ACTIVE_COMPLEX_QUERIES,
  );
  const sortHashOpsPerQuery = normalizePositiveInteger(
    input.sortHashOpsPerQuery,
    DEFAULT_SORT_HASH_OPS_PER_QUERY,
  );
  const autovacuumMaxWorkers = normalizePositiveInteger(
    input.autovacuumMaxWorkers,
    DEFAULT_AUTOVACUUM_MAX_WORKERS,
  );
  const assumptionDrivenWorkMem =
    activeComplexQueries.assumed || sortHashOpsPerQuery.assumed;

  let sharedBuffersTargetBytes: number | null = null;
  let effectiveCacheSizeTargetBytes: number | null = null;
  let workMemTargetBytes: number | null = null;
  let maxParallelWorkersPerGatherTarget: number | null = null;
  let estimatedPeakMemoryBytes: number | null = null;
  let workMemCapped = false;

  if (totalMemoryBytes != null && totalMemoryBytes > 0) {
    sharedBuffersTargetBytes = floorToMiB(
      Math.min(totalMemoryBytes * 0.25, totalMemoryBytes * 0.4),
    );
    effectiveCacheSizeTargetBytes = floorToMiB(totalMemoryBytes * 0.75);

    const sharedBuffersBudget = Math.max(
      sharedBuffersTargetBytes,
      input.sharedBuffersBytes ?? 0,
    );
    const maintenanceWorkMemBytes = Math.max(
      0,
      input.maintenanceWorkMemBytes ?? 0,
    );
    const autovacuumWorkMemBytes = Math.max(
      0,
      input.autovacuumWorkMemBytes ?? 0,
    );
    const hashMemMultiplier = Math.max(1, input.hashMemMultiplier ?? 1);
    const autovacuumBudget =
      autovacuumMaxWorkers.value * autovacuumWorkMemBytes;
    const safeMemoryBudget =
      totalMemoryBytes * (1 - DEFAULT_OS_RESERVE_RATIO) -
      sharedBuffersBudget -
      maintenanceWorkMemBytes -
      autovacuumBudget;

    if (safeMemoryBudget > 0) {
      const denominator = Math.max(
        1,
        activeComplexQueries.value * sortHashOpsPerQuery.value,
      );
      const uncappedWorkMemBytes = floorToMiB(safeMemoryBudget / denominator);
      const cappedWorkMemBytes = assumptionDrivenWorkMem
        ? Math.min(
            uncappedWorkMemBytes,
            DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES,
          )
        : uncappedWorkMemBytes;

      workMemTargetBytes = cappedWorkMemBytes;
      workMemCapped = cappedWorkMemBytes !== uncappedWorkMemBytes;

      const effectiveWorkMemLimit = Math.round(
        workMemTargetBytes * hashMemMultiplier,
      );
      estimatedPeakMemoryBytes = Math.round(
        sharedBuffersBudget +
          activeComplexQueries.value *
            sortHashOpsPerQuery.value *
            effectiveWorkMemLimit +
          maintenanceWorkMemBytes +
          autovacuumBudget,
      );

      if (estimatedPeakMemoryBytes > totalMemoryBytes) {
        const safeHeadroomBytes = Math.max(
          0,
          totalMemoryBytes -
            sharedBuffersBudget -
            maintenanceWorkMemBytes -
            autovacuumBudget,
        );
        const reducedWorkMemBytes = floorToMiB(
          safeHeadroomBytes /
            Math.max(
              1,
              activeComplexQueries.value *
                sortHashOpsPerQuery.value *
                hashMemMultiplier,
            ),
        );

        workMemTargetBytes = reducedWorkMemBytes;
        estimatedPeakMemoryBytes = Math.round(
          sharedBuffersBudget +
            activeComplexQueries.value *
              sortHashOpsPerQuery.value *
              reducedWorkMemBytes *
              hashMemMultiplier +
            maintenanceWorkMemBytes +
            autovacuumBudget,
        );
        notes.push(
          'Reduced work_mem target to keep estimated peak memory within total RAM.',
        );
      }
    } else {
      notes.push(
        'Memory budget is fully consumed by shared buffers and maintenance allowances.',
      );
    }
  }

  if (
    logicalCpuCount != null &&
    logicalCpuCount > 0 &&
    (maxParallelWorkersPerGather == null ||
      maxParallelWorkersPerGather === 0 ||
      maxParallelWorkersPerGather > logicalCpuCount)
  ) {
    maxParallelWorkersPerGatherTarget = Math.min(4, logicalCpuCount);
  }

  if (activeComplexQueries.assumed) {
    notes.push(
      `Assumed active_complex_queries=${activeComplexQueries.value} for conservative memory sizing.`,
    );
  }
  if (sortHashOpsPerQuery.assumed) {
    notes.push(
      `Assumed sort_hash_ops_per_query=${sortHashOpsPerQuery.value} for conservative memory sizing.`,
    );
  }
  if (autovacuumMaxWorkers.assumed) {
    notes.push(
      `Assumed autovacuum_max_workers=${autovacuumMaxWorkers.value} while budgeting maintenance memory.`,
    );
  }
  if (workMemCapped) {
    notes.push(
      'Capped work_mem target at 64 MB because the concurrency inputs are assumption-driven.',
    );
  }

  return {
    sharedBuffersTargetBytes,
    effectiveCacheSizeTargetBytes,
    workMemTargetBytes,
    maxParallelWorkersPerGatherTarget,
    estimatedPeakMemoryBytes,
    assumptions: {
      reserveOsRatio: DEFAULT_OS_RESERVE_RATIO,
      activeComplexQueries: activeComplexQueries.value,
      activeComplexQueriesAssumed: activeComplexQueries.assumed,
      sortHashOpsPerQuery: sortHashOpsPerQuery.value,
      sortHashOpsPerQueryAssumed: sortHashOpsPerQuery.assumed,
      autovacuumMaxWorkers: autovacuumMaxWorkers.value,
      autovacuumMaxWorkersAssumed: autovacuumMaxWorkers.assumed,
      workMemCapBytes: DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES,
      workMemCapped,
    },
    notes,
  };
}

export const CONFIG_COHERENCE_RULES_MARKDOWN = `- Apply a single coherence pass across RAM-sensitive settings before writing final Section 7 targets.
- Use these conservative fallback assumptions when evidence is incomplete and label them explicitly: \`reserve_os_ratio = 30%\`, \`active_complex_queries = 2\`, \`sort_hash_ops_per_query = 2\`, and \`autovacuum_max_workers = 3\`.
- Derive \`shared_buffers_target = min(0.25 * RAM, 0.40 * RAM)\` and \`effective_cache_size_target = 0.75 * RAM\` for dedicated database hosts unless measured evidence justifies a different bound.
- Derive \`available_query_memory = (RAM * (1 - reserve_os_ratio)) - shared_buffers_budget - maintenance_work_mem - (autovacuum_max_workers * autovacuum_work_mem)\` before sizing \`work_mem\`.
- Derive \`work_mem_target = floor(available_query_memory / max(1, active_complex_queries * sort_hash_ops_per_query))\`, then cap assumption-driven outputs at \`64 MB\` unless stronger evidence and explicit concurrency data justify a higher value.
- If the memory budget becomes negative or the derived targets conflict with the peak-memory safety budget, clamp or withhold the target and explain the conflict instead of emitting contradictory values.`;

export const SQL_RUNTIME_SETTABLE_CONFIG_RULES_MARKDOWN = `- For GFS configuration validation candidates, only test settings that can be changed in SQL with \`SET\`, \`SET LOCAL\`, and \`RESET\` during the validation session.
- Allowed session-level config examples: \`work_mem\`, \`maintenance_work_mem\`, \`effective_cache_size\`, \`random_page_cost\`, \`effective_io_concurrency\`, \`max_parallel_workers_per_gather\`, \`track_io_timing\`, \`log_min_duration_statement\`, \`log_lock_waits\`, and \`log_temp_files\`.
- Do not schedule GFS config validations for restart-only or config-file-only settings such as \`shared_buffers\`, \`max_wal_size\`, \`checkpoint_timeout\`, or \`checkpoint_completion_target\`. These may still appear in Section 7 as calculated gaps, but not as session-level GFS config tests.`;
