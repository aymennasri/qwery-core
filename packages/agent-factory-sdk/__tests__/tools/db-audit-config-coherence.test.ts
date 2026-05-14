import { describe, expect, it } from 'vitest';

import {
  CONFIG_COHERENCE_RULES_MARKDOWN,
  SQL_RUNTIME_SETTABLE_CONFIG_RULES_MARKDOWN,
  isSqlRuntimeSettableConfigSetting,
} from '../../src/tools/db-audit/config-coherence';

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
    expect(isSqlRuntimeSettableConfigSetting('effective_cache_size')).toBe(
      true,
    );
    expect(isSqlRuntimeSettableConfigSetting('shared_buffers')).toBe(false);
    expect(isSqlRuntimeSettableConfigSetting('max_wal_size')).toBe(false);
  });

  it('documents that restart-only settings stay out of GFS config tests', () => {
    expect(SQL_RUNTIME_SETTABLE_CONFIG_RULES_MARKDOWN).toContain(
      'Do not schedule GFS config validations for restart-only or config-file-only settings such as `shared_buffers`',
    );
  });
});
