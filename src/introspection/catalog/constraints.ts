import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import type {
  MysqlCheckConstraint,
  MysqlForeignKey,
  MysqlForeignKeyColumn,
  MysqlReferentialAction,
} from '../../model/constraint.js';
import { readNumber, readText, readTextOr } from './common.js';

/**
 * Separator for the composite `table + constraint` grouping key.
 *
 * NUL rather than a space: a MySQL identifier may contain a space, so
 * `("a b", "c")` and `("a", "b c")` would collide, while NUL is the one code
 * point MySQL forbids in an identifier outright.
 */
const SEPARATOR = '\u0000';

const REFERENTIAL_ACTIONS: ReadonlySet<string> = new Set([
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'NO ACTION',
  'SET DEFAULT',
]);

/**
 * Normalizes a `REFERENTIAL_CONSTRAINTS` action.
 *
 * MySQL omits an explicit clause when the action is the default, reporting
 * `NO ACTION` (or, on some versions, an empty string) — both mean the same
 * thing to the server, and `RESTRICT` is InnoDB's actual behaviour for
 * either. `NO ACTION` is kept as the normalized value because that is what
 * `SHOW CREATE TABLE` omits, so a model comparison against a restored
 * database matches.
 */
function toReferentialAction(value: string | null): MysqlReferentialAction {
  const normalized = (value ?? '').trim().toUpperCase();
  return REFERENTIAL_ACTIONS.has(normalized) ? (normalized as MysqlReferentialAction) : 'NO ACTION';
}

/**
 * Reads every foreign key of one database, joining
 * `REFERENTIAL_CONSTRAINTS` (which carries the actions and the referenced
 * table) with `KEY_COLUMN_USAGE` (which carries the column pairs, one row
 * per pair).
 */
export async function queryForeignKeys(
  connection: MysqlConnection,
  databaseName: string,
  signal?: AbortSignal,
): Promise<MysqlForeignKey[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          rc.CONSTRAINT_NAME AS constraintName,
          rc.TABLE_NAME AS tableName,
          rc.UNIQUE_CONSTRAINT_SCHEMA AS referencedDatabaseName,
          rc.REFERENCED_TABLE_NAME AS referencedTableName,
          rc.UPDATE_RULE AS updateRule,
          rc.DELETE_RULE AS deleteRule,
          kcu.COLUMN_NAME AS columnName,
          kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
          kcu.ORDINAL_POSITION AS ordinalPosition
        FROM information_schema.REFERENTIAL_CONSTRAINTS rc
        JOIN information_schema.KEY_COLUMN_USAGE kcu
          ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
         AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
         AND kcu.TABLE_NAME = rc.TABLE_NAME
        WHERE rc.CONSTRAINT_SCHEMA = ?
        ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  const byKey = new Map<
    string,
    { foreignKey: MysqlForeignKey; columns: MysqlForeignKeyColumn[] }
  >();

  for (const row of result.rows) {
    const tableName = readTextOr(row.tableName ?? null, '');
    const constraintName = readTextOr(row.constraintName ?? null, '');
    const key = `${tableName}${SEPARATOR}${constraintName}`;

    let entry = byKey.get(key);
    if (!entry) {
      const columns: MysqlForeignKeyColumn[] = [];
      entry = {
        foreignKey: {
          databaseName,
          tableName,
          constraintName,
          referencedDatabaseName: readTextOr(row.referencedDatabaseName ?? null, databaseName),
          referencedTableName: readTextOr(row.referencedTableName ?? null, ''),
          updateAction: toReferentialAction(readText(row.updateRule ?? null)),
          deleteAction: toReferentialAction(readText(row.deleteRule ?? null)),
          columns,
        },
        columns,
      };
      byKey.set(key, entry);
    }

    entry.columns.push({
      columnName: readTextOr(row.columnName ?? null, ''),
      referencedColumnName: readTextOr(row.referencedColumnName ?? null, ''),
      ordinalPosition: readNumber(row.ordinalPosition ?? null) ?? entry.columns.length + 1,
    });
  }

  return [...byKey.values()].map(entry => entry.foreignKey);
}

/**
 * Reads `CHECK` constraints. MySQL only started *enforcing* — and
 * cataloguing — these in 8.0.16; earlier servers parse a `CHECK` clause and
 * discard it entirely, so there is nothing to read and the caller skips this
 * query based on {@link SourceCapabilities.supportsCheckConstraints}.
 *
 * `ENFORCED` lives in `TABLE_CONSTRAINTS`, not `CHECK_CONSTRAINTS`, hence
 * the join: a `NOT ENFORCED` check still exists in the DDL but is never
 * evaluated, and the distinction has to survive a round trip.
 */
export async function queryCheckConstraints(
  connection: MysqlConnection,
  databaseName: string,
  signal?: AbortSignal,
): Promise<MysqlCheckConstraint[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          cc.CONSTRAINT_NAME AS constraintName,
          tc.TABLE_NAME AS tableName,
          cc.CHECK_CLAUSE AS checkClause,
          tc.ENFORCED AS enforced
        FROM information_schema.CHECK_CONSTRAINTS cc
        JOIN information_schema.TABLE_CONSTRAINTS tc
          ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
         AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
         AND tc.CONSTRAINT_TYPE = 'CHECK'
        WHERE cc.CONSTRAINT_SCHEMA = ?
        ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => ({
    databaseName,
    tableName: readTextOr(row.tableName ?? null, ''),
    constraintName: readTextOr(row.constraintName ?? null, ''),
    checkClause: readTextOr(row.checkClause ?? null, ''),
    isEnforced: readTextOr(row.enforced ?? null, 'YES').toUpperCase() !== 'NO',
  }));
}
