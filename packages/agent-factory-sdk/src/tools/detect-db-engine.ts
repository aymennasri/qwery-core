import { z } from 'zod';
import { Tool } from './tool';
import {
  isPostgresDatasource,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';

const DESCRIPTION =
  'Detect the connected database engine, version, and audit capabilities for the attached datasource.';

export const DetectDbEngineTool = Tool.define('detect_db_engine', {
  description: DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      const versionResult = await query(
        'SELECT version() AS version, current_database() AS database, current_schema() AS schema',
      );

      const row = versionResult.rows[0] ?? {};
      const version = toString(row['version']);
      const database = toString(row['database']);
      const schema = toString(row['schema']);

      let pgStatStatements = false;
      if (isPostgresDatasource(datasource)) {
        try {
          const extensionResult = await query(
            "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS enabled",
          );
          const enabled = extensionResult.rows[0]?.['enabled'];
          pgStatStatements =
            enabled === true || enabled === 't' || enabled === 1;
        } catch {
          pgStatStatements = false;
        }
      }

      return {
        engine: isPostgresDatasource(datasource)
          ? 'postgresql'
          : datasource.datasource_provider,
        provider: datasource.datasource_provider,
        datasourceId: datasource.id,
        version,
        database,
        schema,
        capabilities: {
          explainAnalyze: true,
          pgStatStatements,
          strictReadOnlyAudit: true,
        },
      };
    });
  },
});
