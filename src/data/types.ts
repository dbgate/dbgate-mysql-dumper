import type { MysqlConnection } from '../connection/types.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { MysqlIndex } from '../model/indexes.js';
import type { MysqlTable } from '../model/table.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { DumpWriter } from '../writer/types.js';

export interface TableDataExportOptions {
  /** Row-fetch backpressure high-water mark passed through to `connection.stream()`. */
  readonly streamBatchSize?: number;
  /**
   * Emit multi-row `INSERT` statements. Defaults to `true`, matching
   * `mysqldump --opt`.
   */
  readonly extendedInsert?: boolean;
  /**
   * Always name the columns in the `INSERT`. Defaults to `false`.
   *
   * A column list is emitted regardless whenever the table has generated or
   * invisible columns, because those cannot be covered by a positional
   * `VALUES` list — `mysqldump` behaves the same way.
   */
  readonly completeInsert?: boolean;
  /** Render binary values as `0x...`. Defaults to `true`; see `PlainSqlRenderOptions.hexBlob`. */
  readonly hexBlob?: boolean;
  /**
   * Maximum rows in one extended `INSERT`. Defaults to `Infinity`,
   * so {@link maxStatementBytes} is what actually bounds a statement —
   * which is how `mysqldump` behaves (it has no row cap, only
   * `--net-buffer-length`). Set it to cap rows explicitly; `1` produces one
   * statement per row without turning off {@link extendedInsert}'s syntax.
   */
  readonly maxRowsPerStatement?: number;
  /**
   * Approximate maximum size, in bytes, of one `INSERT` statement.
   *
   * Defaults to 1,046,528 — `mysqldump`'s own `--net-buffer-length` default.
   * The cap is *approximate* in the same way `mysqldump`'s is: a statement
   * is closed once adding the next row would exceed it, and a single row
   * larger than the cap is still emitted alone, since splitting one row is
   * not possible.
   *
   * This is additionally clamped against the server's `max_allowed_packet`
   * (see {@link TableDataExportRequest.maxAllowedPacket}), because a
   * statement larger than that is rejected at restore time with
   * `ER_NET_PACKET_TOO_LARGE` no matter how it was produced.
   */
  readonly maxStatementBytes?: number;
  /**
   * Read rows in primary-key order.
   *
   * Defaults to `true`, a deliberate deviation from `mysqldump` (whose
   * `--order-by-primary` is off). Without an `ORDER BY`, MySQL is free to
   * return rows in any order, so two dumps of the same unchanged database
   * can differ — which makes byte-comparing or hashing a dump meaningless.
   * On InnoDB the cost is nil: the table *is* its primary-key index, so an
   * ordered scan is the same scan. Tables with no primary key fall back to
   * unordered reads, and report `unordered-table-read`.
   */
  readonly orderByPrimaryKey?: boolean;
}

export interface TableDataExportRequest {
  readonly connection: MysqlConnection;
  readonly databaseName: string;
  readonly table: MysqlTable;
  /**
   * The table's indexes, used to find the primary key for
   * {@link TableDataExportOptions.orderByPrimaryKey}. Optional; without it
   * rows are read unordered.
   */
  readonly indexes?: readonly MysqlIndex[];
  readonly writer: DumpWriter;
  /**
   * The server's `max_allowed_packet`, which bounds how large a single
   * statement may be at restore time. Statement size is clamped to a
   * fraction of it; omitted, only {@link TableDataExportOptions.maxStatementBytes}
   * applies.
   */
  readonly maxAllowedPacket?: number;
  readonly options?: TableDataExportOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
}

export interface TableDataExportResult {
  readonly rowsExported: number;
  readonly bytesWritten: number;
  readonly statementsWritten: number;
  readonly cancelled: boolean;
  readonly warnings: readonly MysqlDiagnostic[];
}
