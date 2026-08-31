import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import type { MysqlIndex, MysqlIndexColumn } from '../../model/indexes.js';
import { readNumber, readText, readTextOr } from './common.js';

/**
 * Separator for the composite `table + index` grouping key.
 *
 * NUL rather than a space or a dot: a MySQL identifier may contain either of
 * those, so `("a b", "c")` and `("a", "b c")` would collide on a space, while
 * NUL is the one code point MySQL forbids in an identifier outright.
 */
const SEPARATOR = '\u0000';

/**
 * Reads every index of every table in one database from
 * `information_schema.STATISTICS`, grouping the one-row-per-key-part shape
 * MySQL exposes back into whole indexes.
 *
 * MySQL models a primary key and a unique constraint as *indexes*, not as
 * separate constraint objects, so all three come from this one query and are
 * told apart by `isPrimary`/`isUnique`.
 *
 * `EXPRESSION` (functional key parts) and `IS_VISIBLE` are MySQL 8.0
 * additions and are replaced by `NULL`/`'YES'` on older servers, so one
 * query shape covers 5.7 through 8.4.
 */
export async function queryIndexes(
  connection: MysqlConnection,
  databaseName: string,
  capabilities: { readonly supportsDescendingIndexes: boolean },
  signal?: AbortSignal,
): Promise<MysqlIndex[]> {
  // `EXPRESSION`, `IS_VISIBLE` and a meaningful `COLLATION` direction all
  // arrived with MySQL 8.0, alongside descending indexes.
  const expression = capabilities.supportsDescendingIndexes ? 'EXPRESSION' : 'NULL';
  const isVisible = capabilities.supportsDescendingIndexes ? 'IS_VISIBLE' : "'YES'";

  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          TABLE_NAME AS tableName,
          INDEX_NAME AS indexName,
          NON_UNIQUE AS nonUnique,
          SEQ_IN_INDEX AS seqInIndex,
          COLUMN_NAME AS columnName,
          COLLATION AS keyCollation,
          SUB_PART AS subPart,
          INDEX_TYPE AS indexType,
          INDEX_COMMENT AS indexComment,
          ${expression} AS expression,
          ${isVisible} AS isVisible
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  const byKey = new Map<string, { index: MysqlIndex; columns: MysqlIndexColumn[] }>();

  for (const row of result.rows) {
    const tableName = readTextOr(row.tableName ?? null, '');
    const indexName = readTextOr(row.indexName ?? null, '');
    const key = `${tableName}${SEPARATOR}${indexName}`;

    let entry = byKey.get(key);
    if (!entry) {
      const columns: MysqlIndexColumn[] = [];
      entry = {
        index: {
          databaseName,
          tableName,
          indexName,
          isPrimary: indexName === 'PRIMARY',
          isUnique: (readNumber(row.nonUnique ?? null) ?? 1) === 0,
          indexType: readTextOr(row.indexType ?? null, 'BTREE'),
          comment: readTextOr(row.indexComment ?? null, ''),
          columns,
          isVisible: readTextOr(row.isVisible ?? null, 'YES').toUpperCase() !== 'NO',
        },
        columns,
      };
      byKey.set(key, entry);
    }

    // `STATISTICS.COLLATION` is MySQL's odd encoding of key-part order:
    // 'A' ascending, 'D' descending, NULL for an unordered key part
    // (`HASH`, `FULLTEXT`, `SPATIAL`).
    const keyCollation = readText(row.keyCollation ?? null);
    entry.columns.push({
      columnName: readText(row.columnName ?? null),
      ordinalPosition: readNumber(row.seqInIndex ?? null) ?? entry.columns.length + 1,
      prefixLength: readNumber(row.subPart ?? null),
      direction: keyCollation === 'A' ? 'ASC' : keyCollation === 'D' ? 'DESC' : null,
      expression: readText(row.expression ?? null),
    });
  }

  return [...byKey.values()].map(entry => entry.index);
}
