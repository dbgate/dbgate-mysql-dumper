import type { MysqlConnection } from '../connection/types.js';
import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { MysqlEvent, MysqlRoutine, MysqlTrigger, MysqlView } from '../model/programmable.js';
import { isTransactionalEngine } from '../model/table.js';
import type { MysqlColumn, MysqlTable } from '../model/table.js';
import {
  isEventSelected,
  isRoutineSelected,
  isTableSelected,
  isTriggerSelected,
  isViewSelected,
  normalizeDumpSelection,
} from '../selection/normalize.js';
import { MysqlDumperError, throwIfAborted } from '../utils/errors.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import { detectMysqlVersion } from '../version/detect.js';
import { queryColumns } from './catalog/columns.js';
import { queryCheckConstraints, queryForeignKeys } from './catalog/constraints.js';
import { queryDatabase } from './catalog/database.js';
import { queryIndexes } from './catalog/indexes.js';
import { queryEvents, queryRoutines, queryTriggers, queryViews } from './catalog/programmable.js';
import {
  queryCollationCharacterSets,
  queryLowerCaseTableNames,
  queryTables,
} from './catalog/tables.js';
import {
  showCreateEvent,
  showCreateRoutine,
  showCreateTable,
  showCreateTrigger,
  showCreateView,
} from './catalog/showCreate.js';
import type { IntrospectMysqlOptions, MysqlIntrospectionResult } from './types.js';

/**
 * Builds the normalized {@link MysqlDatabase} model for one database.
 *
 * Everything runs on the **one** connection it is handed, in sequence: a
 * dump's introspection and its data export must observe the same session and
 * the same consistent snapshot, and the MySQL protocol cannot interleave two
 * commands on one connection anyway.
 *
 * `SHOW CREATE ...` is issued once per object and its verbatim text is
 * stored on the model. That is one round trip per object, and it is worth
 * it: the server renders MySQL's `CREATE TABLE` grammar — partitioning,
 * functional key parts, per-column charsets, spatial `SRID`, expression
 * defaults, engine options — exactly right, where reconstructing it from
 * `information_schema` would be an endless game of catching up with the
 * grammar. Pass `includeCreateSql: false` to skip it when only the
 * normalized model is wanted.
 */
export async function introspectMysql(
  connection: MysqlConnection,
  options: IntrospectMysqlOptions = {},
  signal?: AbortSignal,
): Promise<MysqlIntrospectionResult> {
  const diagnostics: MysqlDiagnostic[] = [];
  const includeCreateSql = options.includeCreateSql ?? true;

  const version = await detectMysqlVersion(connection, signal);
  const capabilities = detectSourceCapabilities(version);

  if (version.flavor !== 'mysql') {
    diagnostics.push({
      severity: 'warning',
      code: 'unverified-server-flavor',
      message: `Connected server reports flavor "${version.flavor}" (${version.versionString}). This package's compatibility contract covers MySQL; catalog layout, SHOW CREATE output and mysqldump conventions may differ. See docs/known-limitations.md.`,
    });
  }

  const lowerCaseTableNames = await queryLowerCaseTableNames(connection, signal);
  const selection = normalizeDumpSelection(options.selection, {
    caseInsensitiveTableNames: lowerCaseTableNames !== 0,
  });

  const databaseRow = await queryDatabase(
    connection,
    options.databaseName,
    { supportsDefaultEncryption: version.versionNumber >= 80016 && version.flavor === 'mysql' },
    signal,
  );
  if (!databaseRow) {
    throw new MysqlDumperError(
      'database-not-found',
      options.databaseName
        ? `Database ${JSON.stringify(options.databaseName)} does not exist or is not visible to this user`
        : 'The connection has no default database selected; pass options.databaseName or issue USE <database> first',
    );
  }
  const databaseName = databaseRow.databaseName;

  throwIfAborted(signal);
  const [tableRows, collationCharacterSets, columnRows] = [
    await queryTables(connection, databaseName, signal),
    await queryCollationCharacterSets(connection, signal),
    await queryColumns(
      connection,
      databaseName,
      {
        supportsGeneratedColumns: capabilities.supportsGeneratedColumns,
        supportsSpatialReferenceSystems: capabilities.supportsSpatialReferenceSystems,
      },
      signal,
    ),
  ];

  const columnsByTable = new Map<string, MysqlColumn[]>();
  for (const column of columnRows) {
    const list = columnsByTable.get(column.tableName);
    const { tableName: _tableName, ...modelColumn } = column;
    if (list) {
      list.push(modelColumn);
    } else {
      columnsByTable.set(column.tableName, [modelColumn]);
    }
  }

  const baseTableRows = tableRows.filter(
    row =>
      row.tableType.toUpperCase() === 'BASE TABLE' && isTableSelected(row.tableName, selection),
  );
  const viewRows = tableRows.filter(
    row => row.tableType.toUpperCase() === 'VIEW' && isViewSelected(row.tableName, selection),
  );
  for (const row of tableRows) {
    const type = row.tableType.toUpperCase();
    if (type !== 'BASE TABLE' && type !== 'VIEW') {
      diagnostics.push({
        severity: 'warning',
        code: 'unsupported-table-type',
        message: `Object "${row.tableName}" has TABLE_TYPE "${row.tableType}", which this package does not dump`,
        objectReference: { kind: 'table', databaseName, name: row.tableName },
      });
    }
  }

  const tables: MysqlTable[] = [];
  for (const row of baseTableRows) {
    throwIfAborted(signal);
    const createSql = includeCreateSql
      ? ((await showCreateTable(connection, databaseName, row.tableName, signal)) ?? '')
      : '';
    if (includeCreateSql && createSql === '') {
      diagnostics.push({
        severity: 'error',
        code: 'show-create-unavailable',
        message: `SHOW CREATE TABLE returned no definition for "${row.tableName}"; its structure cannot be dumped`,
        objectReference: { kind: 'table', databaseName, name: row.tableName },
      });
    }
    if (!isTransactionalEngine(row.engine)) {
      diagnostics.push({
        severity: 'warning',
        code: 'nontransactional-table-not-snapshot-consistent',
        message: `Table "${row.tableName}" uses the ${row.engine ?? 'unknown'} engine, which does not take part in an InnoDB consistent snapshot. Under consistency "single-transaction" its rows are read outside any snapshot and concurrent writes can appear mid-dump; use consistency "lock-all-tables" if this table must be consistent with the rest.`,
        objectReference: { kind: 'table', databaseName, name: row.tableName },
      });
    }
    tables.push({
      databaseName,
      pureName: row.tableName,
      engine: row.engine,
      autoIncrement: row.autoIncrement,
      tableCollation: row.tableCollation,
      tableCharacterSet: row.tableCollation
        ? (collationCharacterSets.get(row.tableCollation) ?? null)
        : null,
      rowFormat: row.rowFormat,
      createOptions: row.createOptions,
      comment: row.comment,
      createSql,
      columns: columnsByTable.get(row.tableName) ?? [],
      isTransactional: isTransactionalEngine(row.engine),
    });
  }

  const viewCreateSql = new Map<string, string>();
  const viewColumnNames = new Map<string, readonly string[]>();
  for (const row of viewRows) {
    throwIfAborted(signal);
    viewColumnNames.set(
      row.tableName,
      (columnsByTable.get(row.tableName) ?? [])
        .slice()
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map(column => column.columnName),
    );
    if (includeCreateSql) {
      const createSql = await showCreateView(connection, databaseName, row.tableName, signal);
      if (createSql) {
        viewCreateSql.set(row.tableName, createSql);
      } else {
        diagnostics.push({
          severity: 'error',
          code: 'show-create-unavailable',
          message: `SHOW CREATE VIEW returned no definition for "${row.tableName}"; the view cannot be dumped`,
          objectReference: { kind: 'view', databaseName, name: row.tableName },
        });
      }
    }
  }

  const selectedViewNames = new Set(viewRows.map(row => row.tableName));
  const allViews = await queryViews(
    connection,
    databaseName,
    viewColumnNames,
    viewCreateSql,
    signal,
  );
  const views: MysqlView[] = allViews.filter(view => selectedViewNames.has(view.pureName));

  throwIfAborted(signal);
  const indexes = (await queryIndexes(connection, databaseName, capabilities, signal)).filter(
    index => isTableSelected(index.tableName, selection) || selectedViewNames.has(index.tableName),
  );
  const foreignKeys = (await queryForeignKeys(connection, databaseName, signal)).filter(
    foreignKey => isTableSelected(foreignKey.tableName, selection),
  );
  const checkConstraints = capabilities.supportsCheckConstraints
    ? (await queryCheckConstraints(connection, databaseName, signal)).filter(check =>
        isTableSelected(check.tableName, selection),
      )
    : [];

  const routines = await readRoutines(
    connection,
    databaseName,
    includeCreateSql,
    diagnostics,
    signal,
  );
  const triggers = await readTriggers(
    connection,
    databaseName,
    includeCreateSql,
    diagnostics,
    signal,
  );
  const events = capabilities.supportsEvents
    ? await readEvents(connection, databaseName, includeCreateSql, diagnostics, signal)
    : [];

  const database: MysqlDatabase = {
    databaseName,
    characterSetName: databaseRow.characterSetName,
    collationName: databaseRow.collationName,
    defaultEncryption: databaseRow.defaultEncryption,
    tables,
    views,
    indexes,
    foreignKeys,
    checkConstraints,
    routines: routines.filter(routine => isRoutineSelected(routine.pureName, selection)),
    triggers: triggers.filter(trigger => isTriggerSelected(trigger.triggerName, selection)),
    events: events.filter(event => isEventSelected(event.eventName, selection)),
  };

  return { database, version, capabilities, lowerCaseTableNames, diagnostics };
}

async function readRoutines(
  connection: MysqlConnection,
  databaseName: string,
  includeCreateSql: boolean,
  diagnostics: MysqlDiagnostic[],
  signal?: AbortSignal,
): Promise<MysqlRoutine[]> {
  const withoutSql = await queryRoutines(connection, databaseName, new Map(), signal);
  if (!includeCreateSql) {
    return withoutSql;
  }

  const createSqlByRoutine = new Map<string, string>();
  for (const routine of withoutSql) {
    throwIfAborted(signal);
    const createSql = await showCreateRoutine(
      connection,
      routine.kind,
      databaseName,
      routine.pureName,
      signal,
    );
    if (createSql) {
      createSqlByRoutine.set(`${routine.kind}:${routine.pureName}`, createSql);
    } else {
      // `SHOW CREATE PROCEDURE` returns an empty body — not an error — when
      // the caller lacks the privilege to see it. Reporting it as a warning
      // keeps the rest of the dump usable while making the gap explicit.
      diagnostics.push({
        severity: 'warning',
        code: 'routine-definition-unavailable',
        message: `SHOW CREATE ${routine.kind} returned no definition for "${routine.pureName}". This usually means the current user lacks the privileges to view the routine body; the routine will be skipped.`,
        objectReference: {
          kind: routine.kind === 'FUNCTION' ? 'function' : 'procedure',
          databaseName,
          name: routine.pureName,
        },
      });
    }
  }
  return withoutSql.map(routine => ({
    ...routine,
    createSql: createSqlByRoutine.get(`${routine.kind}:${routine.pureName}`) ?? '',
  }));
}

async function readTriggers(
  connection: MysqlConnection,
  databaseName: string,
  includeCreateSql: boolean,
  diagnostics: MysqlDiagnostic[],
  signal?: AbortSignal,
): Promise<MysqlTrigger[]> {
  const withoutSql = await queryTriggers(connection, databaseName, new Map(), signal);
  if (!includeCreateSql) {
    return withoutSql;
  }

  const createSqlByTrigger = new Map<string, string>();
  for (const trigger of withoutSql) {
    throwIfAborted(signal);
    const createSql = await showCreateTrigger(
      connection,
      databaseName,
      trigger.triggerName,
      signal,
    );
    if (createSql) {
      createSqlByTrigger.set(trigger.triggerName, createSql);
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'trigger-definition-unavailable',
        message: `SHOW CREATE TRIGGER returned no definition for "${trigger.triggerName}"; the trigger will be skipped`,
        objectReference: {
          kind: 'trigger',
          databaseName,
          name: trigger.triggerName,
          parentName: trigger.tableName,
        },
      });
    }
  }
  return withoutSql.map(trigger => ({
    ...trigger,
    createSql: createSqlByTrigger.get(trigger.triggerName) ?? '',
  }));
}

async function readEvents(
  connection: MysqlConnection,
  databaseName: string,
  includeCreateSql: boolean,
  diagnostics: MysqlDiagnostic[],
  signal?: AbortSignal,
): Promise<MysqlEvent[]> {
  const withoutSql = await queryEvents(connection, databaseName, new Map(), signal);
  if (!includeCreateSql) {
    return withoutSql;
  }

  const createSqlByEvent = new Map<string, string>();
  for (const event of withoutSql) {
    throwIfAborted(signal);
    const createSql = await showCreateEvent(connection, databaseName, event.eventName, signal);
    if (createSql) {
      createSqlByEvent.set(event.eventName, createSql);
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'event-definition-unavailable',
        message: `SHOW CREATE EVENT returned no definition for "${event.eventName}"; the event will be skipped`,
        objectReference: { kind: 'event', databaseName, name: event.eventName },
      });
    }
  }
  return withoutSql.map(event => ({
    ...event,
    createSql: createSqlByEvent.get(event.eventName) ?? '',
  }));
}
