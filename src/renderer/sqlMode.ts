/**
 * `sql_mode` flags MySQL 8.0 **removed**.
 *
 * MySQL records the `sql_mode` in force when a view, routine, trigger or
 * event was created, and a dump re-establishes it around the `CREATE` so the
 * object is recreated under the same rules. That is essential for fidelity —
 * a body written under `ANSI_QUOTES` does not parse without it — but it has
 * a portability edge: a mode name that no longer exists on the *target*
 * makes `SET sql_mode = '...'` fail outright with
 * `ER_WRONG_VALUE_FOR_VAR`, taking the whole object with it.
 *
 * A MySQL 5.7 server's default `sql_mode` includes `NO_AUTO_CREATE_USER`,
 * which 8.0 removed. Left in, every stored program in a 5.7 dump would fail
 * to restore on 8.0 — which is why `mysqldump` 5.7 strips it, as verified
 * against the reference dumps in `test-output/`. This list generalizes that
 * to every mode 8.0 removed, so a dump from an older server restores on a
 * newer one.
 *
 * Dropping a mode is not free: it changes the rules the object is recreated
 * under. Every mode here is one 8.0 removed *because* it no longer did
 * anything meaningful — the `NO_*_OPTIONS` trio only affected `SHOW CREATE`
 * output, and the compatibility dialects were superseded — so none of them
 * changes how a body parses or behaves. Callers who need the exact original
 * value can set `sqlModeCompatibility: 'preserve'`.
 */
const REMOVED_IN_MYSQL_8: ReadonlySet<string> = new Set([
  'NO_AUTO_CREATE_USER',
  'NO_FIELD_OPTIONS',
  'NO_KEY_OPTIONS',
  'NO_TABLE_OPTIONS',
  'DB2',
  'MAXDB',
  'MSSQL',
  'MYSQL323',
  'MYSQL40',
  'ORACLE',
  'POSTGRESQL',
]);

/**
 * How a stored program's recorded `sql_mode` is written into the dump.
 *
 * - `'portable'` (default) removes modes MySQL 8.0 no longer accepts, so a
 *   dump taken from 5.7 restores on 8.0 and later. This is what `mysqldump`
 *   does.
 * - `'preserve'` writes the value exactly as the source recorded it. Use it
 *   when the target is known to be the same major version, and exact
 *   reproduction matters more than portability.
 */
export type SqlModeCompatibility = 'portable' | 'preserve';

export interface SqlModeRewriteResult {
  readonly sqlMode: string;
  /** Modes removed for portability; empty when nothing was dropped. */
  readonly removed: readonly string[];
}

export function toPortableSqlMode(
  sqlMode: string | null,
  compatibility: SqlModeCompatibility,
): SqlModeRewriteResult {
  const value = sqlMode ?? '';
  if (compatibility === 'preserve' || value === '') {
    return { sqlMode: value, removed: [] };
  }

  const flags = value
    .split(',')
    .map(flag => flag.trim())
    .filter(flag => flag.length > 0);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const flag of flags) {
    if (REMOVED_IN_MYSQL_8.has(flag.toUpperCase())) {
      removed.push(flag);
    } else {
      kept.push(flag);
    }
  }
  return { sqlMode: kept.join(','), removed };
}
