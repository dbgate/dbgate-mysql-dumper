import type { MysqlColumnValue } from '../../connection/types.js';

/**
 * Reads one catalog cell as text.
 *
 * Introspection queries run in `'raw'` value mode, so every cell arrives as a
 * `string`, a `Buffer` or `null`. `Buffer` is not hypothetical: several
 * `information_schema` columns are declared `varbinary`/`longblob` (MySQL
 * 8.0 stores `COLUMNS.COLUMN_DEFAULT` and `VIEWS.VIEW_DEFINITION` that way),
 * and a driver returning driver-native values may hand back a number or a
 * `Date` instead. All four shapes are normalized here rather than at each of
 * the ~90 call sites.
 */
export function readText(value: MysqlColumnValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value instanceof Date) {
    // `Date` only reaches here from a driver-native read of a catalog
    // datetime (`EVENTS.STARTS`). ISO-8601 with the `T`/`Z` stripped is the
    // MySQL literal form for the same instant.
    return value
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
      .replace('Z', '');
  }
  return String(value);
}

/** Reads one catalog cell as text, substituting `fallback` for SQL `NULL`. */
export function readTextOr(value: MysqlColumnValue, fallback: string): string {
  return readText(value) ?? fallback;
}

/**
 * Reads one catalog cell as a finite number, or `null`.
 *
 * Returns `null` rather than `NaN` for unparseable text: every caller treats
 * the value as "not reported by this server version", and a silent `NaN`
 * would propagate into rendered output.
 */
export function readNumber(value: MysqlColumnValue): number | null {
  const text = readText(value);
  if (text === null || text.trim() === '') {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads an `information_schema` `'YES'`/`'NO'` column as a boolean. */
export function readYesNo(value: MysqlColumnValue): boolean {
  return readText(value)?.toUpperCase() === 'YES';
}
