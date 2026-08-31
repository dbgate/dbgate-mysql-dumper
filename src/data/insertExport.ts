import type { MysqlRow } from '../connection/types.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { MysqlColumn } from '../model/table.js';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../security/identifiers.js';
import { isAbortError, throwIfAborted } from '../utils/errors.js';
import { SqlChunkBuilder } from './chunkBuilder.js';
import type { TableDataExportRequest, TableDataExportResult } from './types.js';
import { isGeneratedColumn, renderColumnValue } from './valueRenderer.js';

/**
 * Default maximum bytes per `INSERT` statement: `mysqldump`'s own
 * `--net-buffer-length` default.
 */
const DEFAULT_MAX_STATEMENT_BYTES = 1_046_528;

/**
 * Fraction of `max_allowed_packet` a generated statement is allowed to
 * occupy.
 *
 * The server rejects any packet above `max_allowed_packet` outright, and the
 * packet carries protocol framing on top of the statement text, so aiming at
 * the exact limit would produce dumps that fail at restore for the largest
 * statements. `mysqldump` leaves the same kind of headroom.
 */
const PACKET_SAFETY_FRACTION = 0.9;

/**
 * Streams one table's rows as `INSERT` statements in `mysqldump`'s layout.
 *
 * Requires a live connection; this is deliberately separate from
 * `renderPlainSql`, which renders schema objects from the static model and
 * never touches the database. The surrounding `LOCK TABLES` /
 * `DISABLE KEYS` frame belongs to the renderer, so this writes statements
 * only — which is why an empty table still produces `mysqldump`'s
 * lock-and-unlock block with nothing in between.
 *
 * Memory is bounded by one statement: rows are consumed from a backpressured
 * stream and flushed as soon as the statement reaches its size cap, so a
 * table of any size dumps in constant memory.
 */
export async function exportTableDataAsInserts(
  request: TableDataExportRequest,
): Promise<TableDataExportResult> {
  const { connection, databaseName, table, writer, signal, onProgress } = request;
  const options = request.options ?? {};
  const extendedInsert = options.extendedInsert ?? true;
  const hexBlob = options.hexBlob ?? true;
  const orderByPrimaryKey = options.orderByPrimaryKey ?? true;
  const maxRowsPerStatement = Math.max(1, options.maxRowsPerStatement ?? Number.POSITIVE_INFINITY);
  const maxStatementBytes = resolveMaxStatementBytes(
    options.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES,
    request.maxAllowedPacket,
  );

  const warnings: MysqlDiagnostic[] = [];
  const qualifiedName = quoteIdentifier(table.pureName);

  const insertableColumns = [...table.columns]
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
    .filter(column => !isGeneratedColumn(column));

  for (const column of table.columns) {
    if (isGeneratedColumn(column)) {
      warnings.push({
        severity: 'info',
        code: 'generated-column-not-exported',
        message: `Column "${table.pureName}"."${column.columnName}" is a ${column.generation} generated column; MySQL derives its value, so it is excluded from INSERT and recomputed on restore.`,
        objectReference: {
          kind: 'column',
          databaseName,
          name: column.columnName,
          parentName: table.pureName,
        },
      });
    }
  }

  if (connection.supportsRawValueReads === false) {
    warnings.push({
      severity: 'warning',
      code: 'lossy-value-mode',
      message: `The supplied connection does not support raw value reads, so row values arrive already converted by the driver. BIGINT and DECIMAL values beyond JavaScript's exact integer range, zero dates, out-of-range TIME values and JSON key order may not survive the dump of table "${table.pureName}". Use the bundled mysql2 adapter, or an adapter that honors MysqlValueMode "raw".`,
      objectReference: { kind: 'table', databaseName, name: table.pureName },
    });
  }

  // A column list is required, not merely nicer, when the positional shape
  // would not line up: generated columns are absent from the insert, and
  // INVISIBLE columns are absent from `SELECT *` yet still insertable.
  const hasInvisibleColumn = insertableColumns.some(column => column.isInvisible);
  const needsColumnList =
    (options.completeInsert ?? false) ||
    insertableColumns.length !== table.columns.length ||
    hasInvisibleColumn;

  let rowsExported = 0;
  let statementsWritten = 0;

  if (insertableColumns.length === 0) {
    // Every column is generated. The table can still hold rows, but there is
    // nothing to insert and no `DEFAULT VALUES` form in MySQL that would
    // help — a fully generated table cannot have rows inserted at all.
    warnings.push({
      severity: 'warning',
      code: 'table-has-no-insertable-columns',
      message: `Table "${table.pureName}" has no insertable columns (every column is generated), so no row data is dumped for it.`,
      objectReference: { kind: 'table', databaseName, name: table.pureName },
    });
    return {
      rowsExported: 0,
      bytesWritten: writer.bytesWritten,
      statementsWritten: 0,
      cancelled: false,
      warnings,
    };
  }

  const orderByClause = buildOrderByClause(request, orderByPrimaryKey, warnings);
  const selectList = insertableColumns.map(column => quoteIdentifier(column.columnName)).join(', ');
  const columnListClause = needsColumnList
    ? ` (${insertableColumns.map(column => quoteIdentifier(column.columnName)).join(', ')})`
    : '';
  const statementPrefix = `INSERT INTO ${qualifiedName}${columnListClause} VALUES `;

  let statement: SqlChunkBuilder | null = null;
  let statementRows = 0;

  const flushStatement = async (): Promise<void> => {
    if (!statement || statementRows === 0) {
      return;
    }
    statement.append(';\n');
    await writer.write(statement.build(), signal);
    statement = null;
    statementRows = 0;
    statementsWritten++;
  };

  const progress = (exportState: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled') => {
    onProgress?.({
      phase: 'exporting-data',
      section: 'table-data',
      databaseName,
      tableName: table.pureName,
      objectName: table.pureName,
      rowsExported,
      bytesWritten: writer.bytesWritten,
      exportState,
    });
  };

  progress('started');
  try {
    const sql = `SELECT ${selectList} FROM ${quoteQualifiedIdentifier([databaseName, table.pureName])}${orderByClause}`;
    for await (const row of connection.stream<MysqlRow>(
      { sql },
      {
        signal,
        ...(options.streamBatchSize === undefined ? {} : { batchSize: options.streamBatchSize }),
        valueMode: 'raw',
      },
    )) {
      throwIfAborted(signal);

      const tuple = buildTuple(row, insertableColumns, hexBlob);

      // Closing *before* appending keeps the byte cap a true upper bound
      // rather than a limit each statement is allowed to overshoot by one
      // row. A statement always holds at least one row, however large that
      // single row is on its own.
      if (
        statement &&
        (!extendedInsert ||
          statementRows >= maxRowsPerStatement ||
          statement.length + tuple.length + 2 > maxStatementBytes)
      ) {
        await flushStatement();
      }

      if (!statement) {
        statement = new SqlChunkBuilder();
        statement.append(statementPrefix);
      } else {
        statement.append(',');
      }
      statement.appendBuilder(tuple);
      statementRows++;
      rowsExported++;

      if (rowsExported % 1000 === 0) {
        progress('progress');
      }
    }

    await flushStatement();
    progress('finished');
    return {
      rowsExported,
      bytesWritten: writer.bytesWritten,
      statementsWritten,
      cancelled: false,
      warnings,
    };
  } catch (error) {
    if (isAbortError(error)) {
      // A partially accumulated statement is deliberately *not* flushed: it
      // would be a syntactically valid INSERT of an arbitrary prefix of the
      // table, which is worse than an obviously truncated dump.
      progress('cancelled');
      return {
        rowsExported,
        bytesWritten: writer.bytesWritten,
        statementsWritten,
        cancelled: true,
        warnings,
      };
    }
    progress('failed');
    throw error;
  }
}

function buildTuple(
  row: MysqlRow,
  columns: readonly MysqlColumn[],
  hexBlob: boolean,
): SqlChunkBuilder {
  const tuple = new SqlChunkBuilder();
  tuple.append('(');
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index] as MysqlColumn;
    if (index > 0) {
      tuple.append(',');
    }
    tuple.append(renderColumnValue(row[column.columnName] ?? null, column, { hexBlob }));
  }
  tuple.append(')');
  return tuple;
}

/**
 * Builds the `ORDER BY` that makes a dump reproducible.
 *
 * Only the primary key is used. A unique index would order rows just as
 * deterministically, but it can contain `NULL`s (MySQL allows them in a
 * unique index), and rows tied on a nullable key would still come back in an
 * arbitrary order — so a table without a primary key is reported rather than
 * given a false guarantee.
 */
function buildOrderByClause(
  request: TableDataExportRequest,
  orderByPrimaryKey: boolean,
  warnings: MysqlDiagnostic[],
): string {
  if (!orderByPrimaryKey) {
    return '';
  }
  const primaryKey = request.indexes?.find(
    index => index.isPrimary && index.tableName === request.table.pureName,
  );
  const columns = primaryKey?.columns
    .slice()
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
    .map(column => column.columnName)
    .filter((name): name is string => name !== null);

  if (!columns || columns.length === 0) {
    warnings.push({
      severity: 'info',
      code: 'unordered-table-read',
      message: `Table "${request.table.pureName}" has no primary key, so its rows are read in whatever order the server returns them. Two dumps of the same unchanged table may therefore differ in row order; the data itself is unaffected.`,
      objectReference: {
        kind: 'table',
        databaseName: request.databaseName,
        name: request.table.pureName,
      },
    });
    return '';
  }
  return ` ORDER BY ${columns.map(quoteIdentifier).join(', ')}`;
}

function resolveMaxStatementBytes(requested: number, maxAllowedPacket: number | undefined): number {
  const bounded = Math.max(1024, requested);
  if (!maxAllowedPacket || !Number.isFinite(maxAllowedPacket)) {
    return bounded;
  }
  return Math.max(1024, Math.min(bounded, Math.floor(maxAllowedPacket * PACKET_SAFETY_FRACTION)));
}
