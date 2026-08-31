import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import { readText } from './common.js';

export interface CatalogDatabaseRow {
  readonly databaseName: string;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  readonly defaultEncryption: string | null;
}

/**
 * Reads one database's `information_schema.SCHEMATA` row.
 *
 * `DEFAULT_ENCRYPTION` arrived in MySQL 8.0.16, so it is selected only when
 * the caller reports the capability and replaced by `NULL` otherwise — the
 * same one-query-shape approach used throughout this layer, in preference to
 * catching a "column does not exist" error and retrying.
 *
 * When `databaseName` is omitted, `DATABASE()` supplies the connection's
 * current database. A connection with no default database selected then
 * yields no row, which the caller turns into an actionable error rather than
 * dumping something arbitrary.
 */
export async function queryDatabase(
  connection: MysqlConnection,
  databaseName: string | undefined,
  capabilities: { readonly supportsDefaultEncryption: boolean },
  signal?: AbortSignal,
): Promise<CatalogDatabaseRow | null> {
  const defaultEncryption = capabilities.supportsDefaultEncryption ? 'DEFAULT_ENCRYPTION' : 'NULL';
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          SCHEMA_NAME AS databaseName,
          DEFAULT_CHARACTER_SET_NAME AS characterSetName,
          DEFAULT_COLLATION_NAME AS collationName,
          ${defaultEncryption} AS defaultEncryption
        FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = COALESCE(?, DATABASE())`,
      parameters: [databaseName ?? null],
    },
    signal,
    'raw',
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    databaseName: readText(row.databaseName ?? null) ?? '',
    characterSetName: readText(row.characterSetName ?? null),
    collationName: readText(row.collationName ?? null),
    defaultEncryption: readText(row.defaultEncryption ?? null),
  };
}
