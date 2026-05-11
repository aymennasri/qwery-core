import { describe, expect, it } from 'vitest';

import {
  CONFIG_COHERENCE_RULES_MARKDOWN,
  DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES,
  SQL_RUNTIME_SETTABLE_CONFIG_RULES_MARKDOWN,
  isSqlRuntimeSettableConfigSetting,
  resolveConfigCoherence,
} from '../../src/tools/db-audit/config-coherence';

describe('resolveConfigCoherence', () => {
  it('derives coherent RAM-based targets and caps assumption-driven work_mem', () => {
    const result = resolveConfigCoherence({
      totalMemoryBytes: 33247145984,
      sharedBuffersBytes: 128 * 1024 * 1024,
      maintenanceWorkMemBytes: 64 * 1024 * 1024,
      autovacuumWorkMemBytes: 64 * 1024 * 1024,
      hashMemMultiplier: 2,
    });

    expect(result.sharedBuffersTargetBytes).toBe(8311013376);
    expect(result.effectiveCacheSizeTargetBytes).toBe(24935137280);
    expect(result.workMemTargetBytes).toBe(
      DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES,
    );
    expect(result.assumptions.workMemCapped).toBe(true);
    expect(result.estimatedPeakMemoryBytes).not.toBeNull();
    expect(result.notes).toContain(
      'Capped work_mem target at 64 MB because the concurrency inputs are assumption-driven.',
    );
  });

  it('uses observed concurrency inputs without assumption notes', () => {
    const result = resolveConfigCoherence({
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      activeComplexQueries: 6,
      sortHashOpsPerQuery: 3,
      sharedBuffersBytes: 128 * 1024 * 1024,
      maintenanceWorkMemBytes: 64 * 1024 * 1024,
      autovacuumMaxWorkers: 2,
      autovacuumWorkMemBytes: 64 * 1024 * 1024,
    });

    expect(result.assumptions.activeComplexQueriesAssumed).toBe(false);
    expect(result.assumptions.sortHashOpsPerQueryAssumed).toBe(false);
    expect(result.assumptions.workMemCapped).toBe(false);
    expect(
      result.notes.some((note) => note.includes('active_complex_queries=')),
    ).toBe(false);
    expect(result.workMemTargetBytes).toBeGreaterThan(
      DEFAULT_ASSUMPTION_DRIVEN_WORK_MEM_CAP_BYTES,
    );
  });

  it('caps max_parallel_workers_per_gather by logical CPU count', () => {
    const result = resolveConfigCoherence({
      logicalCpuCount: 3,
      maxParallelWorkersPerGather: 0,
    });

    expect(result.maxParallelWorkersPerGatherTarget).toBe(3);
  });
});

describe('CONFIG_COHERENCE_RULES_MARKDOWN', () => {
  it('documents the coherence pass and assumption-driven cap', () => {
    expect(CONFIG_COHERENCE_RULES_MARKDOWN).toContain(
      'Apply a single coherence pass across RAM-sensitive settings',
    );
    expect(CONFIG_COHERENCE_RULES_MARKDOWN).toContain(
      'cap assumption-driven outputs at `64 MB`',
    );
  });
});

describe('isSqlRuntimeSettableConfigSetting', () => {
  it('accepts session-settable tuning and observability settings only', () => {
    expect(isSqlRuntimeSettableConfigSetting('work_mem')).toBe(true);
    expect(isSqlRuntimeSettableConfigSetting('random_page_cost')).toBe(true);
    expect(isSqlRuntimeSettableConfigSetting('effective_cache_size')).toBe(true);
    expect(isSqlRuntimeSettableConfigSetting('shared_buffers')).toBe(false);
    expect(isSqlRuntimeSettableConfigSetting('max_wal_size')).toBe(false);
  });

  it('documents that restart-only settings stay out of GFS config tests', () => {
    expect(SQL_RUNTIME_SETTABLE_CONFIG_RULES_MARKDOWN).toContain(
      'Do not schedule GFS config validations for restart-only or config-file-only settings such as `shared_buffers`',
    );
  });
});
