import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import { quoteQualifiedIdentifier } from '../../security/identifiers.js';
import { readText } from './common.js';

/**
 * Runs one `SHOW CREATE <kind>` and returns the DDL column of its single row.
 *
 * `SHOW CREATE` takes an identifier, not a string, so its argument cannot be
 * a bound parameter — the name is backtick-quoted through
 * `quoteQualifiedIdentifier` instead, which is the same escaping MySQL itself
 * defines and the only correct way to interpolate an identifier. The names
 * reaching here always come from `information_schema`, never from caller
 * input.
 *
 * The DDL column's *name* differs per object kind (`Create Table`,
 * `Create View`, `SQL Original Statement`, ...) and has changed between
 * releases, so the value is taken positionally-by-search rather than by a
 * hardcoded key: the first column whose name starts with `Create`, or
 * `Statement`, else the last column. That keeps this working across 5.7,
 * 8.0 and 8.4 without a per-version table.
 */
async function showCreate(
  connection: MysqlConnection,
  kind: string,
  qualifiedName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await connection.query<MysqlRow>(
    { sql: `SHOW CREATE ${kind} ${qualifiedName}` },
    signal,
    'raw',
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const columnNames =
    result.columns.length > 0 ? result.columns.map(c => c.name) : Object.keys(row);
  const ddlColumn =
    columnNames.find(name => /^Create\b/i.test(name)) ??
    columnNames.find(name => /Statement$/i.test(name)) ??
    columnNames[columnNames.length - 1];

  return ddlColumn === undefined ? null : readText(row[ddlColumn] ?? null);
}

export function showCreateTable(
  connection: MysqlConnection,
  databaseName: string,
  tableName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return showCreate(
    connection,
    'TABLE',
    quoteQualifiedIdentifier([databaseName, tableName]),
    signal,
  );
}

export function showCreateView(
  connection: MysqlConnection,
  databaseName: string,
  viewName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return showCreate(connection, 'VIEW', quoteQualifiedIdentifier([databaseName, viewName]), signal);
}

export function showCreateRoutine(
  connection: MysqlConnection,
  kind: 'PROCEDURE' | 'FUNCTION',
  databaseName: string,
  routineName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return showCreate(
    connection,
    kind,
    quoteQualifiedIdentifier([databaseName, routineName]),
    signal,
  );
}

export function showCreateTrigger(
  connection: MysqlConnection,
  databaseName: string,
  triggerName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return showCreate(
    connection,
    'TRIGGER',
    quoteQualifiedIdentifier([databaseName, triggerName]),
    signal,
  );
}

/**
 * `SHOW CREATE EVENT` accepts a qualified name, but unlike the other kinds
 * MySQL returns the statement in a column named `Create Event`, and the row
 * additionally carries the creation-time `time_zone`, `sql_mode` and charset
 * context that `mysqldump` restores around the `CREATE`. The caller reads
 * those from `information_schema.EVENTS` instead, so only the DDL is taken
 * here.
 */
export function showCreateEvent(
  connection: MysqlConnection,
  databaseName: string,
  eventName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return showCreate(
    connection,
    'EVENT',
    quoteQualifiedIdentifier([databaseName, eventName]),
    signal,
  );
}
