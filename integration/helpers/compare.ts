import type { MysqlConnection, MysqlRow } from '../../src/connection/types.js';
import type { MysqlDatabase } from '../../src/model/database.js';
import type { MysqlCreationContext } from '../../src/model/programmable.js';
import { toPortableSqlMode } from '../../src/renderer/sqlMode.js';
import { quoteIdentifier } from '../../src/security/identifiers.js';

/**
 * Codepoint-ordered comparison. Never `localeCompare`: these tests assert
 * determinism, so the sort itself must not depend on the host locale.
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => byText(key(a), key(b)));
}

/**
 * Normalizes a `SHOW CREATE TABLE` body so two servers holding the same
 * logical table compare equal.
 *
 * Only genuinely incidental differences are erased:
 *
 * - `AUTO_INCREMENT=<n>` is *kept* — preserving it is a documented guarantee
 *   of this package and has its own assertions — but the surrounding
 *   whitespace is normalized.
 * - The database name never appears in `SHOW CREATE TABLE` output, so no
 *   substitution is needed for it.
 * - Trailing whitespace and CRLF are normalized, since they carry no meaning
 *   and differ by client.
 */
export function normalizeCreateTable(createSql: string): string {
  return (
    createSql
      .replace(/\r\n/g, '\n')
      // MySQL re-renders a column's charset differently after a round trip: a
      // column that inherited its charset from the table default at CREATE
      // time comes back with an explicit `CHARACTER SET` once it has been
      // recreated from DDL that named its collation. Verified to happen
      // identically for native mysqldump -> native mysql, so it is a server
      // rendering quirk rather than a dump defect. Dropping the redundant
      // clause is lossless for comparison, because a collation name
      // determines its charset (`latin1_swedish_ci` can only be `latin1`).
      .replace(/ CHARACTER SET [A-Za-z0-9_]+ COLLATE /g, ' COLLATE ')
      .split('\n')
      .map(line => line.replace(/\s+$/, ''))
      .join('\n')
      .trim()
  );
}

/**
 * Projects an introspected {@link MysqlDatabase} onto a comparable shape.
 *
 * Drops what legitimately differs between two databases holding the same
 * logical schema — the database name itself, and each object's `DEFINER`
 * when `stripDefiners` is set (a dump restored with a rewritten definer is
 * still a correct restore) — and sorts every collection by a stable key so
 * iteration order cannot affect the result.
 *
 * What remains is exactly what a correct dump/restore must reproduce, so a
 * deep-equality failure against this projection is a real semantic
 * regression rather than incidental noise.
 */
export function normalizeDatabase(
  database: MysqlDatabase,
  options: { readonly stripDefiners?: boolean } = {},
): unknown {
  const stripDefiners = options.stripDefiners ?? false;
  const definer = (value: string | null): string | null => (stripDefiners ? null : value);

  /**
   * Replaces the database's own name with a fixed placeholder.
   *
   * `information_schema.VIEWS.VIEW_DEFINITION` is fully qualified, so a view
   * in `src_db` and the same view restored into `tgt_db` legitimately differ
   * by exactly that name — and by nothing else. Substituting it makes the
   * comparison about the view rather than about which database it landed in.
   */
  const anonymizeDatabase = (sql: string): string =>
    sql.split('`' + database.databaseName + '`.').join('`<db>`.');

  /**
   * Drops `sql_mode` flags MySQL 8.0 removed from a stored program's
   * recorded creation context.
   *
   * A MySQL 5.7 server's default `sql_mode` contains `NO_AUTO_CREATE_USER`,
   * and both `mysqldump` and this package strip it so the dump still
   * restores on 8.0 — so a restored object legitimately records a shorter
   * mode than the source did. Verified to happen identically for
   * native mysqldump -> native mysql, so it is a portability decision of the
   * dump format, not a defect. See `src/renderer/sqlMode.ts`.
   */
  const normalizeCreationContext = (context: MysqlCreationContext): MysqlCreationContext => ({
    ...context,
    sqlMode: toPortableSqlMode(context.sqlMode, 'portable').sqlMode,
  });

  const stripDefinerClause = (sql: string): string =>
    anonymizeDatabase(
      stripDefiners ? sql.replace(/\bDEFINER\s*=\s*`(?:[^`]|``)*`@`(?:[^`]|``)*`\s*/i, '') : sql,
    );

  return {
    characterSetName: database.characterSetName,
    collationName: database.collationName,

    tables: sortBy(database.tables, table => table.pureName).map(table => ({
      pureName: table.pureName,
      engine: table.engine,
      autoIncrement: table.autoIncrement,
      tableCollation: table.tableCollation,
      comment: table.comment,
      createSql: anonymizeDatabase(normalizeCreateTable(table.createSql)),
      columns: [...table.columns]
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map(column => ({
          columnName: column.columnName,
          ordinalPosition: column.ordinalPosition,
          dataType: column.dataType,
          columnType: column.columnType,
          isNullable: column.isNullable,
          isUnsigned: column.isUnsigned,
          defaultValue: column.defaultValue,
          isAutoIncrement: column.isAutoIncrement,
          generation: column.generation,
          generationExpression:
            column.generationExpression === null
              ? null
              : anonymizeDatabase(column.generationExpression),
          isInvisible: column.isInvisible,
          onUpdate: column.onUpdate,
          characterSetName: column.characterSetName,
          collationName: column.collationName,
          numericPrecision: column.numericPrecision,
          numericScale: column.numericScale,
          datetimePrecision: column.datetimePrecision,
          comment: column.comment,
        })),
    })),

    indexes: sortBy(database.indexes, index => `${index.tableName}.${index.indexName}`).map(
      index => ({
        tableName: index.tableName,
        indexName: index.indexName,
        isPrimary: index.isPrimary,
        isUnique: index.isUnique,
        indexType: index.indexType,
        isVisible: index.isVisible,
        columns: [...index.columns]
          .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
          .map(column => ({
            columnName: column.columnName,
            ordinalPosition: column.ordinalPosition,
            prefixLength: column.prefixLength,
            direction: column.direction,
            expression: column.expression,
          })),
      }),
    ),

    foreignKeys: sortBy(
      database.foreignKeys,
      foreignKey => `${foreignKey.tableName}.${foreignKey.constraintName}`,
    ).map(foreignKey => ({
      tableName: foreignKey.tableName,
      constraintName: foreignKey.constraintName,
      referencedTableName: foreignKey.referencedTableName,
      updateAction: foreignKey.updateAction,
      deleteAction: foreignKey.deleteAction,
      columns: [...foreignKey.columns].sort((a, b) => a.ordinalPosition - b.ordinalPosition),
    })),

    checkConstraints: sortBy(
      database.checkConstraints,
      check => `${check.tableName}.${check.constraintName}`,
    ).map(check => ({
      tableName: check.tableName,
      constraintName: check.constraintName,
      checkClause: anonymizeDatabase(check.checkClause),
      isEnforced: check.isEnforced,
    })),

    views: sortBy(database.views, view => view.pureName).map(view => ({
      pureName: view.pureName,
      definition: anonymizeDatabase(view.definition),
      createSql: stripDefinerClause(view.createSql),
      definer: definer(view.definer),
      securityType: view.securityType,
      checkOption: view.checkOption,
      algorithm: view.algorithm,
      columnNames: view.columnNames,
      creationContext: normalizeCreationContext(view.creationContext),
    })),

    routines: sortBy(database.routines, routine => `${routine.kind}.${routine.pureName}`).map(
      routine => ({
        pureName: routine.pureName,
        kind: routine.kind,
        createSql: stripDefinerClause(routine.createSql),
        definer: definer(routine.definer),
        securityType: routine.securityType,
        isDeterministic: routine.isDeterministic,
        dataAccess: routine.dataAccess,
        returnType: routine.returnType,
        comment: routine.comment,
        creationContext: normalizeCreationContext(routine.creationContext),
      }),
    ),

    triggers: sortBy(
      database.triggers,
      trigger => `${trigger.tableName}.${trigger.triggerName}`,
    ).map(trigger => ({
      triggerName: trigger.triggerName,
      tableName: trigger.tableName,
      timing: trigger.timing,
      event: trigger.event,
      actionStatement: anonymizeDatabase(trigger.actionStatement),
      actionOrientation: trigger.actionOrientation,
      createSql: stripDefinerClause(trigger.createSql),
      definer: definer(trigger.definer),
      creationContext: normalizeCreationContext(trigger.creationContext),
    })),

    events: sortBy(database.events, event => event.eventName).map(event => ({
      eventName: event.eventName,
      eventType: event.eventType,
      intervalValue: event.intervalValue,
      intervalField: event.intervalField,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      executeAt: event.executeAt,
      status: event.status,
      onCompletion: event.onCompletion,
      comment: event.comment,
      timeZone: event.timeZone,
      createSql: stripDefinerClause(event.createSql),
      definer: definer(event.definer),
      creationContext: normalizeCreationContext(event.creationContext),
    })),
  };
}

/**
 * Reads every row of `tableName` as raw bytes, hex-encoded.
 *
 * Hex rather than decoded text on purpose: the comparison must catch a
 * single flipped byte in a `BLOB`, a lost trailing space in a `CHAR`, or a
 * `DECIMAL` that came back with a different number of trailing zeros — all
 * of which a text comparison through a lossy decode would hide.
 *
 * Rows are ordered by every column so the result is stable even for a table
 * with no primary key.
 */
export async function readTableSnapshot(
  connection: MysqlConnection,
  databaseName: string,
  tableName: string,
  columnNames: readonly string[],
): Promise<string[]> {
  if (columnNames.length === 0) {
    return [];
  }
  const selectList = columnNames.map(name => quoteIdentifier(name)).join(', ');
  const orderBy = columnNames.map(name => quoteIdentifier(name)).join(', ');
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT ${selectList} FROM ${quoteIdentifier(databaseName)}.${quoteIdentifier(tableName)} ORDER BY ${orderBy}`,
    },
    undefined,
    'raw',
  );

  return result.rows.map(row =>
    columnNames
      .map(name => {
        const value = row[name];
        if (value === null || value === undefined) {
          return 'NULL';
        }
        return Buffer.isBuffer(value)
          ? value.toString('hex')
          : Buffer.from(String(value), 'utf8').toString('hex');
      })
      .join('|'),
  );
}

/**
 * Compares the data of every table in `database` between two connections.
 *
 * Generated columns are included: a restore must reproduce them, and it does
 * so by recomputing rather than copying — which is exactly the behaviour
 * worth checking.
 */
export async function compareTableData(
  database: MysqlDatabase,
  sourceConnection: MysqlConnection,
  sourceDatabaseName: string,
  targetConnection: MysqlConnection,
  targetDatabaseName: string,
): Promise<{ readonly tableName: string; readonly source: string[]; readonly target: string[] }[]> {
  const differences: {
    tableName: string;
    source: string[];
    target: string[];
  }[] = [];

  for (const table of [...database.tables].sort((a, b) => byText(a.pureName, b.pureName))) {
    const columnNames = [...table.columns]
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map(column => column.columnName);
    const source = await readTableSnapshot(
      sourceConnection,
      sourceDatabaseName,
      table.pureName,
      columnNames,
    );
    const target = await readTableSnapshot(
      targetConnection,
      targetDatabaseName,
      table.pureName,
      columnNames,
    );
    if (source.join('\n') !== target.join('\n')) {
      differences.push({ tableName: table.pureName, source, target });
    }
  }

  return differences;
}

/**
 * Normalizes generated dump text so two dumps of the *same logical*
 * database can be compared.
 *
 * Only lines that legitimately differ are removed: the producer line
 * (`mysqldump` names its own version, this package names itself), the
 * `Host:`/`Database:` line (the target database has a different name by
 * construction), and the completion timestamp.
 */
export function normalizeDumpText(sql: string, databaseName?: string): string {
  const withoutVariableLines = sql
    .split(/\r?\n/)
    .filter(
      line =>
        !line.startsWith('-- MySQL dump ') &&
        !line.startsWith('-- Host:') &&
        !line.startsWith('-- Dump completed'),
    )
    .join('\n')
    // Same server rendering quirk `normalizeCreateTable` handles: a table
    // recreated from DDL that named a column's collation comes back with an
    // explicit `CHARACTER SET` the original did not have, so a
    // dump -> restore -> dump cycle is *not* byte-idempotent. Native
    // mysqldump behaves identically; see `normalizeCreateTable`.
    .replace(/ CHARACTER SET [A-Za-z0-9_]+ COLLATE /g, ' COLLATE ');

  return databaseName === undefined
    ? withoutVariableLines
    : withoutVariableLines.split(databaseName).join('<db>');
}
