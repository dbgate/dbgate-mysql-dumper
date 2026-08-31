import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { DumpSelection } from '../selection/types.js';
import type { MysqlVersion, SourceCapabilities } from '../version/types.js';

export interface IntrospectMysqlOptions {
  /**
   * Database to introspect. Defaults to the connection's current database
   * (`DATABASE()`); introspection fails with an actionable error when the
   * connection has none selected, rather than silently picking one.
   */
  readonly databaseName?: string;
  /**
   * Restricts which objects are read. Applied during assembly, not in the
   * catalog queries: `information_schema` filtering by a caller-supplied
   * name list would need either a generated `IN (...)` list or one query per
   * object, and reading a whole database's catalog is a handful of queries
   * regardless of how many objects survive the filter.
   */
  readonly selection?: DumpSelection;
  /**
   * Read the verbatim `SHOW CREATE ...` text for every object. Defaults to
   * `true`; the renderer needs it, but a caller that only wants the
   * normalized model can turn off the one-round-trip-per-object cost.
   */
  readonly includeCreateSql?: boolean;
}

export interface MysqlIntrospectionResult {
  readonly database: MysqlDatabase;
  readonly version: MysqlVersion;
  readonly capabilities: SourceCapabilities;
  /**
   * The server's `lower_case_table_names`, which decides whether table and
   * view names compare case-insensitively.
   */
  readonly lowerCaseTableNames: number;
  readonly diagnostics: readonly MysqlDiagnostic[];
}
