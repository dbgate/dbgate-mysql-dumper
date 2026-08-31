import type { DumpMode } from '../archive/types.js';
import type { MysqlConsistencyMode } from '../connection/session.js';
import type { TableDataExportOptions } from '../data/types.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { PlainSqlRenderOptions } from '../renderer/types.js';
import type { DumpObjectKinds, DumpSelection } from '../selection/types.js';

export interface DumpMysqlOptions {
  /** `'full'` (default): schema and data. `'schema-only'`: definitions only. `'data-only'`: rows only. */
  readonly mode?: DumpMode;
  /** Database to dump. Defaults to the connection's current database. */
  readonly databaseName?: string;
  readonly selection?: DumpSelection;
  /**
   * Which object kinds to include.
   *
   * All five default to `true`, which is deliberately *not* `mysqldump`'s
   * split (it includes triggers by default but omits routines and events
   * unless `--routines`/`--events` are given). A dump that silently drops a
   * database's stored procedures is a trap, and the sibling dumper packages
   * include every object kind by default too; callers wanting `mysqldump`'s
   * exact set can turn the two off.
   */
  readonly objectKinds?: DumpObjectKinds;
  readonly render?: PlainSqlRenderOptions;
  /** Row batching/streaming options; see `exportTableDataAsInserts`. */
  readonly dataExport?: TableDataExportOptions;
  /**
   * How the dump obtains a consistent view. Defaults to
   * `'single-transaction'`; see {@link MysqlConsistencyMode} for what that
   * does and does not guarantee.
   */
  readonly consistency?: MysqlConsistencyMode;
  /**
   * Session time zone used while reading rows, and written into the dump's
   * own `TIME_ZONE` guard so the two always agree. `'+00:00'` by default
   * (`mysqldump --tz-utc`); `null` leaves the session zone alone and omits
   * the guard.
   */
  readonly timeZone?: string | null;
}

export interface DumpResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly MysqlDiagnostic[];
  readonly cancelled: boolean;
  /** Total rows written across every exported table. */
  readonly rowsExported: number;
  /** Total `INSERT` statements written. */
  readonly statementsWritten: number;
}
