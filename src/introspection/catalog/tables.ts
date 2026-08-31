import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import { readNumber, readText, readTextOr } from './common.js';

export interface CatalogTableRow {
  readonly tableName: string;
  readonly tableType: string;
  readonly engine: string | null;
  readonly autoIncrement: string | null;
  readonly tableCollation: string | null;
  readonly rowFormat: string | null;
  readonly createOptions: string | null;
  readonly comment: string;
}

/**
 * Lists base tables and views of one database.
 *
 * `AUTO_INCREMENT` is read as text rather than a number: for a
 * `BIGINT UNSIGNED` key it can legitimately exceed `Number.MAX_SAFE_INTEGER`
 * (up to 18446744073709551615), where a JavaScript number would round and
 * the restored table would resume generating keys at a *different* value
 * than the source. `CAST(... AS CHAR)` guarantees the text form even from a
 * driver that would otherwise narrow it.
 *
 * Views are included in the same listing on purpose: `mysqldump` iterates
 * one name-ordered list containing both, and the archive planner reproduces
 * that interleaving.
 */
export async function queryTables(
  connection: MysqlConnection,
  databaseName: string,
  signal?: AbortSignal,
): Promise<CatalogTableRow[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          TABLE_NAME AS tableName,
          TABLE_TYPE AS tableType,
          ENGINE AS engine,
          CAST(AUTO_INCREMENT AS CHAR) AS autoIncrement,
          TABLE_COLLATION AS tableCollation,
          ROW_FORMAT AS rowFormat,
          CREATE_OPTIONS AS createOptions,
          TABLE_COMMENT AS tableComment
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => ({
    tableName: readTextOr(row.tableName ?? null, ''),
    tableType: readTextOr(row.tableType ?? null, ''),
    engine: readText(row.engine ?? null),
    autoIncrement: readText(row.autoIncrement ?? null),
    tableCollation: readText(row.tableCollation ?? null),
    rowFormat: readText(row.rowFormat ?? null),
    createOptions: readText(row.createOptions ?? null),
    comment: readTextOr(row.tableComment ?? null, ''),
  }));
}

/**
 * Maps collation names to their character set, so a table's charset can be
 * derived from `TABLES.TABLE_COLLATION` (which is all `information_schema`
 * reports at the table level).
 */
export async function queryCollationCharacterSets(
  connection: MysqlConnection,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT COLLATION_NAME AS collationName, CHARACTER_SET_NAME AS characterSetName
            FROM information_schema.COLLATIONS`,
    },
    signal,
    'raw',
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    const collation = readText(row.collationName ?? null);
    const characterSet = readText(row.characterSetName ?? null);
    if (collation && characterSet) {
      map.set(collation, characterSet);
    }
  }
  return map;
}

/**
 * Reads `@@lower_case_table_names`, which decides whether table and view
 * names compare case-insensitively on this server (`1` on Windows and the
 * usual macOS setup, `2` on case-preserving-but-insensitive filesystems,
 * `0` on Linux). Selection normalization needs it to match the way the
 * server itself resolves the names the caller passed in.
 */
export async function queryLowerCaseTableNames(
  connection: MysqlConnection,
  signal?: AbortSignal,
): Promise<number> {
  const result = await connection.query<MysqlRow>(
    { sql: 'SELECT @@GLOBAL.lower_case_table_names AS value' },
    signal,
    'raw',
  );
  return readNumber(result.rows[0]?.value ?? null) ?? 0;
}
