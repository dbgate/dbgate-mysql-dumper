import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import type { SourceCapabilities } from '../version/types.js';

/**
 * A restore target's capabilities have the same shape as a source's, but the
 * two stay distinct concepts: a source's describe what its catalog may
 * contain, a target's what it can accept. They share a derivation function
 * today only because both are pure functions of the detected `MysqlVersion`.
 */
export type TargetCapabilities = SourceCapabilities;

export { detectSourceCapabilities as detectTargetCapabilities };

const FEATURE_LABELS: Record<keyof TargetCapabilities, string> = {
  supportsCheckConstraints: 'CHECK constraints (MySQL 8.0.16+)',
  supportsGeneratedColumns: 'generated columns (MySQL 5.7.6+)',
  supportsJsonType: 'the JSON data type (MySQL 5.7.8+)',
  supportsInvisibleColumns: 'INVISIBLE columns (MySQL 8.0.23+)',
  supportsDescendingIndexes: 'descending and functional indexes (MySQL 8.0+)',
  supportsUtf8mb40900Collations: 'utf8mb4_0900_* collations (MySQL 8.0+)',
  supportsEvents: 'scheduled events',
  supportsExpressionDefaults: 'expression column defaults (MySQL 8.0.13+)',
  supportsSpatialReferenceSystems: 'spatial reference system ids (MySQL 8.0+)',
  reportsDefaultGeneratedExtra: 'DEFAULT_GENERATED reporting (MySQL 8.0.13+)',
};

/**
 * Reports what a dump of `database` needs that `target` cannot provide.
 *
 * Deliberately *feature*-level rather than statement-level: this package
 * emits the server's own `SHOW CREATE` text, so it cannot know in advance
 * exactly which clause an older target will choke on. What it can do is name
 * the features the source model actually uses and check each against the
 * target, which turns "restore failed with a syntax error at line 4713" into
 * "the target is MySQL 5.7 and this dump contains CHECK constraints".
 *
 * Never throws: callers decide whether an unsupported feature blocks the
 * restore or is merely reported.
 */
export function checkTargetCompatibility(
  database: MysqlDatabase,
  target: TargetCapabilities,
): MysqlDiagnostic[] {
  const diagnostics: MysqlDiagnostic[] = [];

  const require = (
    feature: keyof TargetCapabilities,
    used: boolean,
    detail: string,
    objectReference?: MysqlDiagnostic['objectReference'],
  ): void => {
    if (used && !target[feature]) {
      diagnostics.push({
        severity: 'error',
        code: 'unsupported-target-feature',
        message: `Restore target does not support ${FEATURE_LABELS[feature]}, which this dump uses: ${detail}`,
        ...(objectReference === undefined ? {} : { objectReference }),
      });
    }
  };

  if (database.checkConstraints.length > 0) {
    const first = database.checkConstraints[0];
    require('supportsCheckConstraints', true, `constraint "${first?.constraintName}" on table "${first?.tableName}"`, first
      ? {
          kind: 'checkConstraint',
          databaseName: database.databaseName,
          name: first.constraintName,
          parentName: first.tableName,
        }
      : undefined);
  }

  for (const table of database.tables) {
    for (const column of table.columns) {
      if (column.generation !== 'none') {
        require('supportsGeneratedColumns', true, `column "${table.pureName}"."${column.columnName}"`, {
          kind: 'column',
          databaseName: database.databaseName,
          name: column.columnName,
          parentName: table.pureName,
        });
      }
      if (column.isInvisible) {
        require('supportsInvisibleColumns', true, `column "${table.pureName}"."${column.columnName}"`, {
          kind: 'column',
          databaseName: database.databaseName,
          name: column.columnName,
          parentName: table.pureName,
        });
      }
      if (column.dataType === 'json') {
        require('supportsJsonType', true, `column "${table.pureName}"."${column.columnName}"`, {
          kind: 'column',
          databaseName: database.databaseName,
          name: column.columnName,
          parentName: table.pureName,
        });
      }
      if (column.isDefaultExpression && !/^CURRENT_TIMESTAMP/i.test(column.defaultValue ?? '')) {
        require('supportsExpressionDefaults', true, `column "${table.pureName}"."${column.columnName}" has an expression default`, {
          kind: 'column',
          databaseName: database.databaseName,
          name: column.columnName,
          parentName: table.pureName,
        });
      }
      if (column.srsId !== null) {
        require('supportsSpatialReferenceSystems', true, `column "${table.pureName}"."${column.columnName}" declares SRID ${column.srsId}`, {
          kind: 'column',
          databaseName: database.databaseName,
          name: column.columnName,
          parentName: table.pureName,
        });
      }
    }
    if ((table.tableCollation ?? '').startsWith('utf8mb4_0900')) {
      require('supportsUtf8mb40900Collations', true, `table "${table.pureName}" uses collation ${table.tableCollation}`, {
        kind: 'table',
        databaseName: database.databaseName,
        name: table.pureName,
      });
    }
  }

  for (const index of database.indexes) {
    if (index.columns.some(column => column.direction === 'DESC' || column.expression !== null)) {
      require('supportsDescendingIndexes', true, `index "${index.indexName}" on table "${index.tableName}"`, {
        kind: 'index',
        databaseName: database.databaseName,
        name: index.indexName,
        parentName: index.tableName,
      });
    }
  }

  if (database.events.length > 0) {
    require('supportsEvents', true, `event "${database.events[0]?.eventName}"`);
  }

  return diagnostics;
}
