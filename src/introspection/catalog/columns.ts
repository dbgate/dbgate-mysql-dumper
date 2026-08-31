import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import type { MysqlColumn, MysqlColumnGeneration } from '../../model/table.js';
import { readNumber, readText, readTextOr, readYesNo } from './common.js';

/**
 * `COLUMNS.EXTRA` is a space-separated bag of attributes rather than a
 * single value. On MySQL 8.0 a generated column with an `ON UPDATE` clause
 * and an invisible flag can read
 * `DEFAULT_GENERATED on update CURRENT_TIMESTAMP`, so each attribute is
 * matched independently instead of comparing the whole string.
 */
function parseExtra(extra: string): {
  isAutoIncrement: boolean;
  generation: MysqlColumnGeneration;
  isInvisible: boolean;
  isDefaultGenerated: boolean;
  onUpdate: string | null;
} {
  const normalized = extra.toUpperCase();
  const onUpdateMatch = /ON UPDATE (.+?)(?:\s+(?:VIRTUAL|STORED) GENERATED|\s+INVISIBLE|$)/i.exec(
    extra,
  );
  return {
    isAutoIncrement: normalized.includes('AUTO_INCREMENT'),
    generation: normalized.includes('VIRTUAL GENERATED')
      ? 'virtual'
      : normalized.includes('STORED GENERATED')
        ? 'stored'
        : 'none',
    isInvisible: /\bINVISIBLE\b/.test(normalized),
    isDefaultGenerated: normalized.includes('DEFAULT_GENERATED'),
    onUpdate: onUpdateMatch ? (onUpdateMatch[1] as string).trim() : null,
  };
}

/**
 * True when a `COLUMN_DEFAULT` is an expression rather than a literal, for
 * servers that do not report `DEFAULT_GENERATED` in `EXTRA` (before MySQL
 * 8.0.13).
 *
 * On those versions the only expression default MySQL accepts is
 * `CURRENT_TIMESTAMP` on a `TIMESTAMP`/`DATETIME` column, optionally with a
 * fractional-second precision — so recognizing exactly that form is complete,
 * not a heuristic that might miss cases.
 */
function isLegacyExpressionDefault(defaultValue: string | null): boolean {
  return defaultValue !== null && /^CURRENT_TIMESTAMP(\(\d*\))?$/i.test(defaultValue.trim());
}

export interface CatalogColumnRow extends MysqlColumn {
  readonly tableName: string;
}

/**
 * Reads every column of every table and view in one database.
 *
 * `SRS_ID` and `GENERATION_EXPRESSION` do not exist on all supported
 * servers, so the caller passes capability flags and the corresponding
 * `SELECT` items are replaced by `NULL` literals — one query shape that
 * works on 5.7 through 8.4 without probing for a column and retrying on
 * failure.
 */
export async function queryColumns(
  connection: MysqlConnection,
  databaseName: string,
  capabilities: {
    readonly supportsGeneratedColumns: boolean;
    readonly supportsSpatialReferenceSystems: boolean;
  },
  signal?: AbortSignal,
): Promise<CatalogColumnRow[]> {
  const generationExpression = capabilities.supportsGeneratedColumns
    ? 'GENERATION_EXPRESSION'
    : 'NULL';
  const srsId = capabilities.supportsSpatialReferenceSystems ? 'SRS_ID' : 'NULL';

  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          TABLE_NAME AS tableName,
          COLUMN_NAME AS columnName,
          ORDINAL_POSITION AS ordinalPosition,
          DATA_TYPE AS dataType,
          COLUMN_TYPE AS columnType,
          IS_NULLABLE AS isNullable,
          COLUMN_DEFAULT AS columnDefault,
          EXTRA AS extra,
          CHARACTER_SET_NAME AS characterSetName,
          COLLATION_NAME AS collationName,
          CHARACTER_MAXIMUM_LENGTH AS characterMaximumLength,
          NUMERIC_PRECISION AS numericPrecision,
          NUMERIC_SCALE AS numericScale,
          DATETIME_PRECISION AS datetimePrecision,
          ${generationExpression} AS generationExpression,
          ${srsId} AS srsId,
          COLUMN_COMMENT AS columnComment
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => {
    const extra = readTextOr(row.extra ?? null, '');
    const parsed = parseExtra(extra);
    const defaultValue = readText(row.columnDefault ?? null);
    const columnType = readTextOr(row.columnType ?? null, '');

    return {
      tableName: readTextOr(row.tableName ?? null, ''),
      columnName: readTextOr(row.columnName ?? null, ''),
      ordinalPosition: readNumber(row.ordinalPosition ?? null) ?? 0,
      dataType: readTextOr(row.dataType ?? null, '').toLowerCase(),
      columnType,
      isNullable: readYesNo(row.isNullable ?? null),
      // `COLUMN_TYPE` is the only place `information_schema` reports
      // signedness; there is no dedicated column for it.
      isUnsigned: /\bunsigned\b/i.test(columnType),
      defaultValue,
      isDefaultExpression: parsed.isDefaultGenerated || isLegacyExpressionDefault(defaultValue),
      isAutoIncrement: parsed.isAutoIncrement,
      generation: parsed.generation,
      generationExpression: readText(row.generationExpression ?? null),
      isInvisible: parsed.isInvisible,
      onUpdate: parsed.onUpdate,
      characterSetName: readText(row.characterSetName ?? null),
      collationName: readText(row.collationName ?? null),
      characterMaximumLength: readNumber(row.characterMaximumLength ?? null),
      numericPrecision: readNumber(row.numericPrecision ?? null),
      numericScale: readNumber(row.numericScale ?? null),
      datetimePrecision: readNumber(row.datetimePrecision ?? null),
      srsId: readNumber(row.srsId ?? null),
      comment: readTextOr(row.columnComment ?? null, ''),
    };
  });
}
