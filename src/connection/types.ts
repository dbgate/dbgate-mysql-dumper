/**
 * Client-agnostic MySQL connection abstraction.
 *
 * The core package never imports a Node.js driver directly. Callers provide
 * a {@link MysqlConnection} (or a {@link MysqlConnectionSource} that can
 * acquire one) implemented by an adapter such as `dbgate-mysql-dumper/mysql2`.
 */

/** Scalar values accepted as bound query parameters (`?` placeholders). */
export type MysqlParameterValue = string | number | bigint | boolean | Buffer | Date | null;

/** A single SQL statement plus its positional (`?`) parameters. */
export interface MysqlQuery {
  readonly sql: string;
  /** Bound in order for each `?` placeholder. Adapters must never string-interpolate these. */
  readonly parameters?: readonly MysqlParameterValue[];
  /** Statement-level timeout in milliseconds. Adapters that cannot honor it may ignore it. */
  readonly timeoutMs?: number;
}

/**
 * Scalar values that can appear in a returned row.
 *
 * `string` and `Buffer` are the only shapes this package relies on for
 * *exact* fidelity — see {@link MysqlValueMode}. The remaining members exist
 * so an adapter that hands back driver-native JavaScript values still works,
 * at the documented fidelity cost.
 */
export type MysqlColumnValue =
  | string
  | number
  | bigint
  | boolean
  | Buffer
  | Date
  | null
  | { readonly [key: string]: unknown }
  | readonly unknown[];

/** A single result row, keyed by column name. */
export interface MysqlRow {
  readonly [column: string]: MysqlColumnValue;
}

/**
 * How an adapter should materialize column values.
 *
 * - `'raw'`: every value arrives as the **exact bytes MySQL sent** — a
 *   `Buffer`, or `null` for SQL `NULL`. No parsing, no conversion, no
 *   JavaScript numeric or `Date` type in between. This is what `mysqldump`
 *   itself works from, and the only mode that preserves `BIGINT`/`DECIMAL`
 *   precision, `'0000-00-00'` zero dates, `TIME` values outside `Date`'s
 *   range (`'-838:59:59'`), the server's own `DOUBLE` formatting, and JSON
 *   text with its original key order and spacing.
 *
 *   Text columns are still *encoded*, in whatever `character_set_results`
 *   the session has — which the dump session pins to `utf8mb4`, so
 *   `buffer.toString('utf8')` is correct for every non-binary column
 *   regardless of that column's own charset. Binary columns
 *   (`BLOB`/`BINARY`/`VARBINARY`/`BIT`, collation id `63`) are never
 *   converted by the server and must be kept as bytes.
 *
 *   Returning `Buffer` for *everything*, rather than `string` for text and
 *   `Buffer` for binary, is deliberate: the wire protocol reports the
 *   distinction only through a column's collation id, and several drivers
 *   (`mysql2` among them) do not expose that to a per-value hook. Deciding
 *   in the serializer, which already has the introspected column type, is
 *   the one place the answer is reliably known.
 * - `'native'`: driver-native JavaScript values (`Date`, `number`, parsed
 *   JSON objects, ...). Used for catalog queries, whose values are known to
 *   be safe; never used for table data.
 *
 * Adapters that cannot honor `'raw'` should report
 * {@link MysqlConnection.supportsRawValueReads} as `false`; data export
 * still works, but emits a fidelity warning.
 */
export type MysqlValueMode = 'raw' | 'native';

/** Metadata for one column of a query result, as reported by the driver. */
export interface MysqlResultColumn {
  readonly name: string;
  /** Protocol column type name when the adapter can report it, e.g. `NEWDECIMAL`, `BLOB`. */
  readonly type?: string;
  /** Raw protocol type code (`field.columnType`), when available. */
  readonly columnType?: number;
  /** Raw protocol flags bitmask (`field.flags`), when available. */
  readonly flags?: number;
  /** Collation/charset id; `63` is `binary`, which distinguishes BLOB from TEXT. */
  readonly characterSet?: number;
}

/** Buffered result of a non-streaming query. */
export interface MysqlQueryResult<Row extends MysqlRow = MysqlRow> {
  readonly rows: readonly Row[];
  readonly columns: readonly MysqlResultColumn[];
  /** `affectedRows` for DML/DDL; `0` for a plain `SELECT`. */
  readonly affectedRows: number;
  /** `LAST_INSERT_ID()` when the server reported one. */
  readonly insertId?: number | bigint;
  /** Server warning count, when the adapter reports it. */
  readonly warningCount?: number;
}

export interface MysqlStreamOptions {
  readonly signal?: AbortSignal;
  /**
   * Backpressure high-water mark: adapters that support it stop reading
   * rows off the socket once this many are buffered ahead of the consumer,
   * and resume once the buffer drains.
   */
  readonly batchSize?: number;
  /** Defaults to `'raw'`; see {@link MysqlValueMode}. */
  readonly valueMode?: MysqlValueMode;
  /**
   * Called once, before the first row, with the result's column metadata.
   *
   * An `AsyncIterable<Row>` has nowhere else to carry it, and data export
   * needs the collation id to tell a `TEXT` column from a `BLOB` when it has
   * no introspected model to consult. Adapters that cannot report column
   * metadata simply never call it.
   */
  readonly onColumns?: (columns: readonly MysqlResultColumn[]) => void;
}

/** The collation id MySQL uses for `binary`; identifies non-character columns. */
export const BINARY_CHARACTER_SET_ID = 63;

/**
 * True when a result column holds bytes rather than characters, and so must
 * never be decoded as text. Recognized from the collation id the server
 * reports — the only place the protocol carries the distinction, since
 * `TEXT` and `BLOB` (and `VARCHAR` and `VARBINARY`) share a column type.
 */
export function isBinaryResultColumn(column: MysqlResultColumn): boolean {
  return column.characterSet === BINARY_CHARACTER_SET_ID;
}

/** Result of executing one statement through {@link MysqlConnection.execute}. */
export interface MysqlExecResult {
  readonly affectedRows: number;
  readonly warningCount?: number;
}

/** Structured information about a MySQL server error, extracted by an adapter. */
export interface MysqlServerErrorInfo {
  /** Server error number, e.g. `1146` for `ER_NO_SUCH_TABLE`. */
  readonly errno?: number;
  /** Symbolic driver/server code, e.g. `ER_NO_SUCH_TABLE`. */
  readonly code?: string;
  /** Five-character `SQLSTATE`, e.g. `42S02`. */
  readonly sqlState?: string;
  readonly message: string;
}

/**
 * One physical MySQL session.
 *
 * Implementations must serialize statements sent through the same
 * connection: the MySQL client/server protocol is strictly request/response
 * on a single connection and cannot interleave two commands.
 */
export interface MysqlConnection {
  /**
   * Whether {@link MysqlStreamOptions.valueMode} `'raw'` is honored. When
   * `false`, values arrive driver-native and data export reports a
   * `lossy-value-mode` warning rather than silently degrading fidelity.
   */
  readonly supportsRawValueReads?: boolean;

  query<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    signal?: AbortSignal,
    valueMode?: MysqlValueMode,
  ): Promise<MysqlQueryResult<Row>>;

  /** Streams rows without buffering the full result set in memory. */
  stream<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    options?: MysqlStreamOptions,
  ): AsyncIterable<Row>;

  /**
   * Executes one already-complete statement's SQL text with no parameter
   * binding and no client-side rewriting.
   *
   * Restore routes every statement through this rather than `query()`
   * because a dump's statement text must reach the server byte for byte: a
   * driver that treats `?` as a placeholder would corrupt any `INSERT`
   * carrying a literal question mark, and a driver that strips comments
   * would drop MySQL executable comments, which carry real, version-gated
   * SQL. Adapters that cannot make this guarantee may omit it; callers then
   * fall back to `query()` with no parameters.
   */
  execute?(sql: string, signal?: AbortSignal): Promise<MysqlExecResult>;

  /** Extracts structured server-error fields from a driver error, for diagnostics. */
  describeError?(error: unknown): MysqlServerErrorInfo | undefined;

  /** Requests cancellation of the currently executing statement, if any. */
  cancel(): Promise<void>;
}

/** A connection acquired from a pool-like source, plus its release callback. */
export interface AcquiredMysqlConnection {
  readonly connection: MysqlConnection;
  /**
   * Whether this connection is exclusively held for the duration of the
   * operation. `false` for a bare {@link MysqlConnection} the caller handed
   * over directly — it may be shared, so session-scoped state must be
   * restored rather than assumed discarded.
   */
  readonly dedicated: boolean;
  /** Idempotent; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Represents a resource that must be acquired to obtain one physical
 * connection, such as a connection pool. Direct {@link MysqlConnection}
 * instances are borrowed by the library and are never closed by it.
 */
export interface MysqlConnectionSource {
  acquire(signal?: AbortSignal): Promise<AcquiredMysqlConnection>;
}

/** Anything the public API accepts in place of a physical connection. */
export type MysqlConnectionInput = MysqlConnection | MysqlConnectionSource;

export function isMysqlConnectionSource(
  input: MysqlConnectionInput,
): input is MysqlConnectionSource {
  return typeof (input as MysqlConnectionSource).acquire === 'function';
}
