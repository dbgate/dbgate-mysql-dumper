import type { MysqlConnection, MysqlRow } from '../../connection/types.js';
import type {
  MysqlCreationContext,
  MysqlEvent,
  MysqlRoutine,
  MysqlSecurityType,
  MysqlTrigger,
  MysqlTriggerEvent,
  MysqlTriggerTiming,
  MysqlView,
} from '../../model/programmable.js';
import { readNumber, readText, readTextOr } from './common.js';

function toSecurityType(value: string | null): MysqlSecurityType {
  return (value ?? '').trim().toUpperCase() === 'INVOKER' ? 'INVOKER' : 'DEFINER';
}

function creationContext(row: MysqlRow): MysqlCreationContext {
  return {
    characterSetClient: readText(row.characterSetClient ?? null),
    collationConnection: readText(row.collationConnection ?? null),
    sqlMode: readText(row.sqlMode ?? null),
  };
}

/**
 * Reads every view of one database.
 *
 * `columnNames` comes from a separate `information_schema.COLUMNS` lookup
 * the caller supplies, because the stub (`SELECT 1 AS a, 1 AS b`) that
 * `mysqldump` emits before the real definitions needs the view's *exposed*
 * column names in order, and `information_schema.VIEWS` does not report
 * them.
 */
export async function queryViews(
  connection: MysqlConnection,
  databaseName: string,
  columnNamesByView: ReadonlyMap<string, readonly string[]>,
  createSqlByView: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<MysqlView[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          TABLE_NAME AS viewName,
          VIEW_DEFINITION AS viewDefinition,
          CHECK_OPTION AS checkOption,
          IS_UPDATABLE AS isUpdatable,
          DEFINER AS definer,
          SECURITY_TYPE AS securityType,
          CHARACTER_SET_CLIENT AS characterSetClient,
          COLLATION_CONNECTION AS collationConnection,
          NULL AS sqlMode
        FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => {
    const pureName = readTextOr(row.viewName ?? null, '');
    const createSql = createSqlByView.get(pureName) ?? '';
    return {
      databaseName,
      pureName,
      definition: readTextOr(row.viewDefinition ?? null, ''),
      createSql,
      definer: readText(row.definer ?? null),
      securityType: toSecurityType(readText(row.securityType ?? null)),
      checkOption: readTextOr(row.checkOption ?? null, 'NONE'),
      isUpdatable: readTextOr(row.isUpdatable ?? null, 'NO').toUpperCase() === 'YES',
      // `information_schema.VIEWS` has no ALGORITHM column; the value only
      // appears in `SHOW CREATE VIEW`, so it is parsed back out of that text.
      algorithm: /ALGORITHM\s*=\s*(\w+)/i.exec(createSql)?.[1]?.toUpperCase() ?? 'UNDEFINED',
      creationContext: creationContext(row),
      columnNames: columnNamesByView.get(pureName) ?? [],
    };
  });
}

export async function queryRoutines(
  connection: MysqlConnection,
  databaseName: string,
  createSqlByRoutine: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<MysqlRoutine[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          ROUTINE_NAME AS routineName,
          ROUTINE_TYPE AS routineType,
          DEFINER AS definer,
          SECURITY_TYPE AS securityType,
          IS_DETERMINISTIC AS isDeterministic,
          SQL_DATA_ACCESS AS dataAccess,
          ROUTINE_COMMENT AS routineComment,
          DTD_IDENTIFIER AS returnType,
          CHARACTER_SET_CLIENT AS characterSetClient,
          COLLATION_CONNECTION AS collationConnection,
          SQL_MODE AS sqlMode
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ?
        ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => {
    const kind =
      readTextOr(row.routineType ?? null, 'PROCEDURE').toUpperCase() === 'FUNCTION'
        ? ('FUNCTION' as const)
        : ('PROCEDURE' as const);
    const pureName = readTextOr(row.routineName ?? null, '');
    const createSql = createSqlByRoutine.get(`${kind}:${pureName}`) ?? '';
    return {
      databaseName,
      pureName,
      kind,
      createSql,
      definer: readText(row.definer ?? null),
      securityType: toSecurityType(readText(row.securityType ?? null)),
      isDeterministic: readTextOr(row.isDeterministic ?? null, 'NO').toUpperCase() === 'YES',
      dataAccess: readTextOr(row.dataAccess ?? null, 'CONTAINS SQL'),
      comment: readTextOr(row.routineComment ?? null, ''),
      // `information_schema.ROUTINES.PARAMETER_STYLE`/`DTD_IDENTIFIER` do not
      // carry the formal parameter list; it is only in `SHOW CREATE`, and the
      // DDL comes from there anyway. Recorded as `null` rather than
      // reconstructed from `information_schema.PARAMETERS`, which would risk
      // disagreeing with the authoritative text.
      parameterList: null,
      returnType: kind === 'FUNCTION' ? readText(row.returnType ?? null) : null,
      creationContext: creationContext(row),
    };
  });
}

export async function queryTriggers(
  connection: MysqlConnection,
  databaseName: string,
  createSqlByTrigger: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<MysqlTrigger[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          TRIGGER_NAME AS triggerName,
          EVENT_OBJECT_TABLE AS tableName,
          ACTION_TIMING AS actionTiming,
          EVENT_MANIPULATION AS eventManipulation,
          ACTION_STATEMENT AS actionStatement,
          ACTION_ORIENTATION AS actionOrientation,
          ACTION_ORDER AS actionOrder,
          DEFINER AS definer,
          CHARACTER_SET_CLIENT AS characterSetClient,
          COLLATION_CONNECTION AS collationConnection,
          SQL_MODE AS sqlMode
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?
        ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => {
    const triggerName = readTextOr(row.triggerName ?? null, '');
    return {
      databaseName,
      triggerName,
      tableName: readTextOr(row.tableName ?? null, ''),
      timing: readTextOr(row.actionTiming ?? null, 'BEFORE').toUpperCase() as MysqlTriggerTiming,
      event: readTextOr(row.eventManipulation ?? null, 'INSERT').toUpperCase() as MysqlTriggerEvent,
      createSql: createSqlByTrigger.get(triggerName) ?? '',
      actionStatement: readTextOr(row.actionStatement ?? null, ''),
      actionOrientation: readTextOr(row.actionOrientation ?? null, 'ROW'),
      actionOrder: readNumber(row.actionOrder ?? null),
      definer: readText(row.definer ?? null),
      creationContext: creationContext(row),
    };
  });
}

export async function queryEvents(
  connection: MysqlConnection,
  databaseName: string,
  createSqlByEvent: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<MysqlEvent[]> {
  const result = await connection.query<MysqlRow>(
    {
      sql: `SELECT
          EVENT_NAME AS eventName,
          DEFINER AS definer,
          EVENT_TYPE AS eventType,
          CAST(INTERVAL_VALUE AS CHAR) AS intervalValue,
          INTERVAL_FIELD AS intervalField,
          CAST(EXECUTE_AT AS CHAR) AS executeAt,
          CAST(STARTS AS CHAR) AS startsAt,
          CAST(ENDS AS CHAR) AS endsAt,
          STATUS AS status,
          ON_COMPLETION AS onCompletion,
          EVENT_COMMENT AS eventComment,
          TIME_ZONE AS timeZone,
          CHARACTER_SET_CLIENT AS characterSetClient,
          COLLATION_CONNECTION AS collationConnection,
          SQL_MODE AS sqlMode
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?
        ORDER BY EVENT_NAME`,
      parameters: [databaseName],
    },
    signal,
    'raw',
  );

  return result.rows.map(row => {
    const eventName = readTextOr(row.eventName ?? null, '');
    return {
      databaseName,
      eventName,
      createSql: createSqlByEvent.get(eventName) ?? '',
      definer: readText(row.definer ?? null),
      eventType: readTextOr(row.eventType ?? null, 'ONE TIME'),
      intervalValue: readText(row.intervalValue ?? null),
      intervalField: readText(row.intervalField ?? null),
      executeAt: readText(row.executeAt ?? null),
      startsAt: readText(row.startsAt ?? null),
      endsAt: readText(row.endsAt ?? null),
      status: readTextOr(row.status ?? null, 'ENABLED'),
      onCompletion: readTextOr(row.onCompletion ?? null, 'NOT PRESERVE'),
      comment: readTextOr(row.eventComment ?? null, ''),
      timeZone: readText(row.timeZone ?? null),
      creationContext: creationContext(row),
    };
  });
}
