import type { MysqlColumnValue } from '../connection/types.js';
import type { MysqlColumn } from '../model/table.js';
import {
  escapeMysqlString,
  formatNumberLiteral,
  isSafeNumericLiteral,
  quoteMysqlBytes,
  quoteMysqlString,
  renderHexLiteral,
} from '../security/literals.js';

/**
 * MySQL base types whose value is a *number* and must therefore be written
 * unquoted.
 *
 * `mysqldump` decides this from the column's protocol type, and so does
 * this: quoting a numeric would still restore (MySQL coerces), but it would
 * differ from native output and would change behaviour under
 * `STRICT_*` modes for out-of-range values.
 */
const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'dec',
  'numeric',
  'fixed',
  'float',
  'double',
  'double precision',
  'real',
  'year',
  'bit',
]);

/**
 * Types held as raw bytes rather than characters. These are the ones
 * `--hex-blob` applies to, and the ones that must never be decoded as text.
 */
const BINARY_TYPES: ReadonlySet<string> = new Set([
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'bit',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

/**
 * The spatial family. These are part of {@link BINARY_TYPES} and are written
 * as byte literals, not as `ST_GeomFromText(...)` constructors: MySQL sends
 * a spatial value as its internal representation (a 4-byte SRID followed by
 * WKB) and accepts exactly that form back on `INSERT`. `mysqldump` does the
 * same, so a spatial column round-trips with its SRID intact — which a WKT
 * constructor would drop. Tracked separately only so diagnostics can name
 * the family.
 */
const SPATIAL_TYPES: ReadonlySet<string> = new Set([
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
]);

export interface ValueRenderOptions {
  /** Render binary values as `0x...` rather than `_binary '...'`. */
  readonly hexBlob: boolean;
}

/**
 * Whether a column's value must be treated as bytes.
 *
 * Derived from the introspected type rather than from the wire protocol,
 * because the protocol reports `TEXT` and `BLOB` (and `VARCHAR` and
 * `VARBINARY`) with the same type code and distinguishes them only by
 * collation id — which several drivers do not expose per value. A text
 * column with the `binary` *collation* is still text as far as
 * serialization goes; its bytes are valid in the connection charset.
 */
export function isBinaryColumn(column: Pick<MysqlColumn, 'dataType'>): boolean {
  return BINARY_TYPES.has(column.dataType.toLowerCase());
}

export function isSpatialColumn(column: Pick<MysqlColumn, 'dataType'>): boolean {
  return SPATIAL_TYPES.has(column.dataType.toLowerCase());
}

export function isNumericColumn(column: Pick<MysqlColumn, 'dataType'>): boolean {
  return NUMERIC_TYPES.has(column.dataType.toLowerCase());
}

/**
 * True when a column can never appear in an `INSERT` column list.
 *
 * A generated column's value is derived by the server and MySQL rejects an
 * explicit value for one outright (`ER_NON_INSERTABLE_TABLE` /
 * `ER_BAD_NULL_ERROR` depending on version). An `INVISIBLE` column *can* be
 * inserted explicitly, but it is excluded from `SELECT *` — so it is
 * selected by name instead, and stays insertable; only generated columns are
 * dropped here.
 */
export function isGeneratedColumn(column: Pick<MysqlColumn, 'generation'>): boolean {
  return column.generation !== 'none';
}

/**
 * Renders one column value as a MySQL literal.
 *
 * The value arrives as the raw bytes MySQL sent (see `MysqlValueMode`), so
 * this is the point where the *column's* type decides how those bytes are
 * interpreted — which is exactly the decision `mysqldump` makes, and the
 * reason no JavaScript `Number`, `Date` or `JSON.parse` sits anywhere in
 * this path:
 *
 * - **Numeric** columns emit the server's own text unquoted, so a
 *   `BIGINT UNSIGNED` of `18446744073709551615` and a `DECIMAL(65,30)` keep
 *   every digit. `BIT` is the exception in this set: MySQL sends it as bytes,
 *   not digits, so it goes down the binary path exactly as `mysqldump` does.
 * - **Binary** columns emit `0x...` (`hexBlob`) or `_binary '...'` with
 *   byte-wise escaping, never a decoded string.
 * - **Everything else** — the char/text families, `DATE`/`DATETIME`/
 *   `TIMESTAMP`/`TIME`, `ENUM`, `SET`, `JSON` — is the server's own text,
 *   decoded as UTF-8 (correct for every non-binary column, because the dump
 *   session pins `character_set_results` to `utf8mb4`) and quoted. This is
 *   what preserves `'0000-00-00'`, `'-838:59:59'`, and JSON with its
 *   original spacing and key order.
 *
 * Values that arrive already converted by a driver-native read are handled
 * as a documented fallback, at the fidelity cost `lossy-value-mode` warns
 * about.
 */
export function renderColumnValue(
  value: MysqlColumnValue,
  column: Pick<MysqlColumn, 'dataType' | 'columnType'>,
  options: ValueRenderOptions,
): string | Buffer {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  const dataType = column.dataType.toLowerCase();

  if (Buffer.isBuffer(value)) {
    if (BINARY_TYPES.has(dataType)) {
      return renderBytes(value, options);
    }
    // Non-binary column read in raw mode: the bytes are text in the session
    // charset, which the dump session pinned to utf8mb4.
    const text = value.toString('utf8');
    return NUMERIC_TYPES.has(dataType) ? renderNumericText(text) : quoteMysqlString(text);
  }

  if (typeof value === 'string') {
    if (BINARY_TYPES.has(dataType)) {
      // A driver that decoded a binary column to text has already lost bytes
      // outside the decoder's range; re-encoding as UTF-8 is the best that
      // can be done, and the caller has been warned via `lossy-value-mode`.
      return renderBytes(Buffer.from(value, 'utf8'), options);
    }
    return NUMERIC_TYPES.has(dataType) ? renderNumericText(value) : quoteMysqlString(value);
  }

  return renderNativeValue(value, dataType, options);
}

/**
 * Renders a numeric column's text.
 *
 * The server's own representation is emitted verbatim when it is a valid
 * MySQL numeric literal — that is the whole point, since it carries more
 * precision than any JavaScript number could. Anything else is quoted
 * defensively, so unexpected text can never break statement syntax; MySQL
 * coerces a quoted numeric on the way in.
 */
function renderNumericText(text: string): string {
  return isSafeNumericLiteral(text) ? text : quoteMysqlString(text);
}

function renderBytes(bytes: Buffer, options: ValueRenderOptions): string | Buffer {
  if (options.hexBlob) {
    return renderHexLiteral(bytes);
  }
  // `_binary` tells the server the literal is a byte string regardless of
  // the connection charset — without it, `SET NAMES utf8mb4` would make the
  // server try to interpret the bytes as UTF-8. `mysqldump` emits the same
  // introducer.
  return Buffer.concat([Buffer.from('_binary ', 'latin1'), quoteMysqlBytes(bytes)]);
}

/**
 * Fallback for values a driver already converted to a JavaScript type.
 *
 * Reached only when the connection cannot honor `'raw'` value mode. Each
 * conversion here is lossy in a way the raw path is not, which is why data
 * export reports `lossy-value-mode` when it takes this route.
 */
function renderNativeValue(
  value: Exclude<MysqlColumnValue, string | Buffer | null>,
  dataType: string,
  options: ValueRenderOptions,
): string | Buffer {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return formatNumberLiteral(value);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (value instanceof Date) {
    return quoteMysqlString(formatDateValue(value, dataType));
  }
  if (value instanceof Uint8Array) {
    return renderBytes(Buffer.from(value), options);
  }
  // A driver that parsed a JSON column hands back a plain object or array.
  // Re-serializing cannot reproduce the server's original spacing or key
  // order, but it does preserve the value.
  return quoteMysqlString(JSON.stringify(value));
}

/**
 * Formats a driver-supplied `Date` for a MySQL temporal column.
 *
 * Uses the UTC fields rather than local ones because the dump's own header
 * sets `TIME_ZONE='+00:00'` for the restore, so the two must agree. A driver
 * that built the `Date` from a local-time interpretation has already shifted
 * the value; nothing here can recover that, which is the fidelity cost the
 * `lossy-value-mode` warning describes.
 */
function formatDateValue(value: Date, dataType: string): string {
  const pad = (input: number, width = 2): string => String(input).padStart(width, '0');
  const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  if (dataType === 'date') {
    return date;
  }
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  if (dataType === 'time') {
    return time;
  }
  const milliseconds = value.getUTCMilliseconds();
  const fraction = milliseconds === 0 ? '' : `.${pad(milliseconds, 3)}`;
  return `${date} ${time}${fraction}`;
}

/**
 * Escapes text for a `SET`/`ENUM`-style value list. Exported for the
 * spatial-value path and for tests; the ordinary value path goes through
 * {@link renderColumnValue}.
 */
export { escapeMysqlString };
