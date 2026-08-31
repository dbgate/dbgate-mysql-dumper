/**
 * MySQL string-literal escaping.
 *
 * This reproduces `mysql_real_escape_string_quote(..., '\'')` — the exact
 * function `mysqldump` itself uses for every value it writes — rather than
 * inventing an escaping scheme:
 *
 * | code point | escape |
 * | ---------- | ------ |
 * | `U+0000` (NUL)  | `\0`  |
 * | `U+000A` (LF)   | `\n`  |
 * | `U+000D` (CR)   | `\r`  |
 * | `U+001A` (SUB)  | `\Z`  |
 * | `U+0022` (`"`)  | `\"`  |
 * | `U+0027` (`'`)  | `\'`  |
 * | `U+005C` (`\`)  | `\\`  |
 *
 * Two absences are deliberate, not oversights:
 *
 * - **TAB is not escaped.** A literal tab inside a quoted string is valid
 *   MySQL and needs no escape; `mysql_real_escape_string` leaves it alone,
 *   so escaping it here would make output differ from `mysqldump` for no
 *   benefit. (Tab only becomes significant in the tab-separated
 *   `SELECT ... INTO OUTFILE` format, which this package does not produce.)
 * - **Ctrl+Z is escaped as `\Z`** even though MySQL would accept the raw
 *   byte, because a raw `0x1A` terminates input on Windows when a dump is
 *   piped through `cmd`'s redirection. This is exactly why
 *   `mysql_real_escape_string` escapes it, and it is why a dump produced
 *   here stays restorable via `mysql < dump.sql` on Windows.
 *
 * ## Dependence on `NO_BACKSLASH_ESCAPES`
 *
 * Backslash escapes only mean anything when the *restoring* session does not
 * have `NO_BACKSLASH_ESCAPES` in its `sql_mode`. Every dump this package
 * produces therefore opens with
 * `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' &#42;/`,
 * which replaces the restore session's whole `sql_mode` — clearing
 * `NO_BACKSLASH_ESCAPES` if it was set — and restores it in the footer. That
 * header line is the reason this escaping is safe, which is why
 * `PlainSqlRenderOptions.includeSessionGuards` cannot be disabled without a
 * `backslash-escapes-unguarded` warning: turning it off while the target
 * session has `NO_BACKSLASH_ESCAPES` would silently corrupt every value
 * containing a backslash or quote.
 */

/** Escape sequences by code point, for the seven code points MySQL escapes. */
const STRING_ESCAPES = new Map<number, string>([
  [0x00, '\\0'],
  [0x0a, '\\n'],
  [0x0d, '\\r'],
  [0x1a, '\\Z'],
  [0x22, '\\"'],
  [0x27, "\\'"],
  [0x5c, '\\\\'],
]);

/**
 * Escapes `value` for inclusion between single quotes, without adding the
 * quotes themselves.
 *
 * Scans by UTF-16 code unit. That is safe for multi-byte text: every code
 * point this escapes is ASCII, and no UTF-16 code unit of an astral-plane
 * character (a surrogate, `0xD800`-`0xDFFF`) or of any non-ASCII BMP
 * character can collide with one — so an emoji, a CJK ideograph or a
 * combining mark passes through untouched, byte-identical after UTF-8
 * encoding.
 */
export function escapeMysqlString(value: string): string {
  let result = '';
  let plainStart = 0;
  for (let index = 0; index < value.length; index++) {
    const escape = STRING_ESCAPES.get(value.charCodeAt(index));
    if (escape !== undefined) {
      result += value.slice(plainStart, index) + escape;
      plainStart = index + 1;
    }
  }
  return plainStart === 0 ? value : result + value.slice(plainStart);
}

/** Escapes and single-quotes a string as a MySQL string literal. */
export function quoteMysqlString(value: string): string {
  return `'${escapeMysqlString(value)}'`;
}

/** Byte-wise escape table, indexed by byte value; `null` means "emit the byte unchanged". */
const BYTE_ESCAPES: readonly (Buffer | null)[] = (() => {
  const table: (Buffer | null)[] = new Array<Buffer | null>(256).fill(null);
  for (const [codePoint, escape] of STRING_ESCAPES) {
    table[codePoint] = Buffer.from(escape, 'latin1');
  }
  return table;
})();

const SINGLE_QUOTE = Buffer.from("'", 'latin1');

/**
 * Escapes arbitrary bytes as a quoted MySQL string literal, returned as a
 * `Buffer` so the bytes survive.
 *
 * A binary value must never be routed through a JavaScript string on its way
 * to the dump: any byte sequence that is not valid UTF-8 would be replaced
 * with U+FFFD on decode, silently corrupting the data. This is the
 * `hexBlob: false` path; {@link renderHexLiteral} is the (default) path that
 * sidesteps the problem entirely.
 */
export function quoteMysqlBytes(value: Buffer | Uint8Array): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const parts: Buffer[] = [SINGLE_QUOTE];
  let plainStart = 0;
  for (let index = 0; index < bytes.length; index++) {
    const escape = BYTE_ESCAPES[bytes[index] as number];
    if (escape) {
      if (index > plainStart) {
        parts.push(bytes.subarray(plainStart, index));
      }
      parts.push(escape);
      plainStart = index + 1;
    }
  }
  if (plainStart < bytes.length) {
    parts.push(bytes.subarray(plainStart));
  }
  parts.push(SINGLE_QUOTE);
  return Buffer.concat(parts);
}

/**
 * Renders bytes as a MySQL hexadecimal literal (`0x48656C6C6F`), the form
 * `mysqldump --hex-blob` emits.
 *
 * Zero-length input renders as `''`, not `0x`: MySQL's hexadecimal literal
 * grammar requires at least one digit pair, so `0x` alone is a syntax error.
 * `mysqldump` has the same special case.
 *
 * Uppercase hex digits match `mysqldump`'s own output.
 */
export function renderHexLiteral(value: Buffer | Uint8Array): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length === 0) {
    return "''";
  }
  return `0x${bytes.toString('hex').toUpperCase()}`;
}

/**
 * A numeric literal shape MySQL parses exactly as written: an optional sign,
 * digits with an optional fractional part, and an optional exponent.
 * Anything else read from a numeric column is quoted defensively rather than
 * emitted bare, so unexpected text can never break statement syntax.
 */
export const SAFE_NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * True for text MySQL will parse back as the identical numeric value. Used to
 * decide whether a server-supplied numeric string can be emitted unquoted.
 */
export function isSafeNumericLiteral(value: string): boolean {
  return SAFE_NUMERIC_LITERAL.test(value);
}

/**
 * Renders a finite JavaScript number as a MySQL numeric literal.
 *
 * `String(value)` is used verbatim, exponent form included. That is the
 * shortest representation which round-trips back to the identical IEEE-754
 * double, and MySQL's numeric literal grammar accepts exponent notation — so
 * expanding it into plain digits would only add digits without adding
 * precision, and near the edges of the double range would produce a
 * 309-digit literal MySQL parses as `DECIMAL` (maximum precision 65) and
 * rejects.
 *
 * This is a *fallback* for connections that deliver driver-native numbers.
 * In the default `'raw'` value mode the server's own text reaches the dump
 * untouched and this is never reached for table data.
 */
export function formatNumberLiteral(value: number): string {
  if (Number.isNaN(value)) {
    // MySQL has no NaN literal; NULL is the only lossless representation and
    // a caller reaching this has already lost the original value.
    throw new Error('Cannot render NaN as a MySQL literal');
  }
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot render non-finite number as a MySQL literal: ${value}`);
  }
  return String(value);
}
