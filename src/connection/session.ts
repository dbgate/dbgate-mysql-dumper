import { MysqlDumperError } from '../utils/errors.js';
import type { MysqlConnection, MysqlRow } from './types.js';

/**
 * How the dump obtains a consistent view of the source database.
 *
 * - `'single-transaction'` (default) issues
 *   `SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ` followed by
 *   `START TRANSACTION WITH CONSISTENT SNAPSHOT`, the same pair
 *   `mysqldump --single-transaction` uses. Every read afterwards observes
 *   one InnoDB snapshot taken at that instant, without blocking writers.
 *   **Only transactional engines participate.** A MyISAM/MEMORY/CSV/ARCHIVE
 *   table is read outside any snapshot, so concurrent writes to it *can*
 *   appear mid-dump; a `nontransactional-table-not-snapshot-consistent`
 *   warning is reported per such table rather than pretending otherwise.
 *   DDL is likewise not covered: MySQL does not include metadata changes in
 *   an InnoDB snapshot, so an `ALTER TABLE` running concurrently with the
 *   dump can still produce an inconsistent result (`ER_TABLE_DEF_CHANGED`
 *   in the best case).
 * - `'lock-all-tables'` issues `FLUSH TABLES WITH READ LOCK`, which blocks
 *   *all* writes server-wide for the whole dump but does cover
 *   nontransactional engines and DDL. Requires the `RELOAD` (or
 *   `FLUSH_TABLES`) privilege. Analogous to `mysqldump --lock-all-tables`.
 * - `'none'` performs no locking or transaction work at all and provides no
 *   consistency guarantee whatsoever.
 */
export type MysqlConsistencyMode = 'single-transaction' | 'lock-all-tables' | 'none';

export interface MysqlDumpSessionOptions {
  readonly consistency?: MysqlConsistencyMode;
  /**
   * Session time zone used while *reading* rows. `'+00:00'` (default)
   * matches `mysqldump --tz-utc`: `TIMESTAMP` columns are converted from
   * their stored UTC value using this zone, so reading and restoring under
   * the same explicit offset makes the value survive a move between servers
   * in different zones. Set to `null` to leave the session zone untouched,
   * the equivalent of `mysqldump --skip-tz-utc`.
   */
  readonly timeZone?: string | null;
  /**
   * Connection character set pinned while reading, via `SET NAMES`.
   *
   * `'utf8mb4'` (default) mirrors what `mysqldump` does on its own
   * connection, and is what makes `'raw'` value reads decodable: with
   * `character_set_results = utf8mb4` the server converts every non-binary
   * column to UTF-8 on the way out no matter what charset the column itself
   * uses, so one decode rule covers a `latin1` column and a `utf8mb4` one
   * alike. Binary columns are exempt from that conversion, which is exactly
   * the behaviour needed. Set to `null` to leave the session charset alone.
   */
  readonly characterSet?: string | null;
}

export interface MysqlDumpSession {
  readonly consistency: MysqlConsistencyMode;
  /** The session time zone in force while reading, or `null` when left untouched. */
  readonly timeZone: string | null;
  /** The connection charset in force while reading, or `null` when left untouched. */
  readonly characterSet: string | null;
  /** The `sql_mode` the session had before this package normalized it. */
  readonly originalSqlMode: string;
  /**
   * Ends the transaction/lock and restores every session variable this
   * package changed. Idempotent, and never throws: a failure here must not
   * replace the dump's own outcome, and the caller's connection is handed
   * back regardless.
   */
  finish(signal?: AbortSignal): Promise<void>;
}

/**
 * `sql_mode` flags that must not be in force while this package reads the
 * catalog.
 *
 * `ANSI_QUOTES` (and `ANSI`, which implies it) makes `SHOW CREATE TABLE`
 * render identifiers with double quotes instead of backticks; the dump would
 * then be rejected by any restore session without that flag, which includes
 * every session the generated header sets up. `NO_BACKSLASH_ESCAPES`
 * changes how the server interprets literals, and clearing it keeps the read
 * session's rules identical to the restore session the dump's own header
 * establishes.
 *
 * Everything else about the caller's `sql_mode` is preserved: only these are
 * subtracted, so a session with `STRICT_TRANS_TABLES` keeps it.
 */
const CONFLICTING_SQL_MODE_FLAGS: ReadonlySet<string> = new Set([
  'ANSI_QUOTES',
  'NO_BACKSLASH_ESCAPES',
  'ANSI',
]);

/**
 * `SET NAMES` takes a charset *token*, not an expression, so it cannot use a
 * bound parameter and the value has to reach the SQL text directly. Since a
 * caller can pass anything here (a config file, an HTTP body), the value is
 * validated against MySQL's own charset-name grammar first, so nothing but a
 * plain identifier can ever be interpolated.
 */
const SAFE_CHARACTER_SET_NAME = /^[A-Za-z0-9_]{1,64}$/;

interface SingleValueRow extends MysqlRow {
  readonly value: string | null;
}

function normalizeSqlMode(sqlMode: string): { normalized: string; changed: boolean } {
  const flags = sqlMode
    .split(',')
    .map(flag => flag.trim())
    .filter(flag => flag.length > 0);
  const kept = flags.filter(flag => !CONFLICTING_SQL_MODE_FLAGS.has(flag.toUpperCase()));
  return { normalized: kept.join(','), changed: kept.length !== flags.length };
}

async function readSessionVariable(
  connection: MysqlConnection,
  expression: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await connection.query<SingleValueRow>(
    { sql: `SELECT ${expression} AS value` },
    signal,
    'native',
  );
  const value = result.rows[0]?.value;
  return value === null || value === undefined ? null : String(value);
}

/**
 * Assigns a session system variable through a bound parameter. MySQL accepts
 * `?` on the right-hand side of a `SET SESSION <var> = ...` assignment, so
 * no caller-supplied string ever reaches the SQL text — unlike `SET NAMES`,
 * which has no such form and is handled separately.
 */
async function setSessionVariable(
  connection: MysqlConnection,
  variable: 'sql_mode' | 'time_zone',
  value: string,
  signal?: AbortSignal,
): Promise<void> {
  await connection.query(
    { sql: `SET SESSION ${variable} = ?`, parameters: [value] },
    signal,
    'native',
  );
}

async function setNames(
  connection: MysqlConnection,
  characterSet: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!SAFE_CHARACTER_SET_NAME.test(characterSet)) {
    throw new MysqlDumperError(
      'invalid-character-set',
      `Invalid character set name ${JSON.stringify(characterSet)}; expected a plain MySQL charset identifier such as "utf8mb4"`,
    );
  }
  await connection.query({ sql: `SET NAMES ${characterSet}` }, signal, 'native');
}

/**
 * Establishes the read session for one dump on a single physical
 * connection: consistency mode, session time zone, connection charset, and a
 * `sql_mode` normalized so catalog reads (`SHOW CREATE ...`) render the way
 * the generated dump expects.
 *
 * Introspection and data export belonging to the same dump **must** share
 * one {@link MysqlDumpSession} over one {@link MysqlConnection}: a
 * consistent snapshot exists only within the transaction that opened it, so
 * a second connection — or a pool handing out an arbitrary one — would read
 * different data.
 */
export async function beginMysqlDumpSession(
  connection: MysqlConnection,
  options: MysqlDumpSessionOptions = {},
  signal?: AbortSignal,
): Promise<MysqlDumpSession> {
  const consistency = options.consistency ?? 'single-transaction';
  const timeZone = options.timeZone === undefined ? '+00:00' : options.timeZone;
  const characterSet = options.characterSet === undefined ? 'utf8mb4' : options.characterSet;

  const originalSqlMode =
    (await readSessionVariable(connection, '@@SESSION.sql_mode', signal)) ?? '';
  const originalTimeZone =
    timeZone === null
      ? null
      : ((await readSessionVariable(connection, '@@SESSION.time_zone', signal)) ?? 'SYSTEM');
  const originalCharacterSet =
    characterSet === null
      ? null
      : ((await readSessionVariable(connection, '@@SESSION.character_set_client', signal)) ??
        'utf8mb4');

  const { normalized, changed: sqlModeChanged } = normalizeSqlMode(originalSqlMode);
  const rollback = (): Promise<void> =>
    restoreSessionVariables(connection, {
      sqlMode: sqlModeChanged ? originalSqlMode : null,
      timeZone: timeZone === null ? null : originalTimeZone,
      characterSet: characterSet === null ? null : originalCharacterSet,
    });

  try {
    if (sqlModeChanged) {
      await setSessionVariable(connection, 'sql_mode', normalized, signal);
    }
    if (timeZone !== null) {
      await setSessionVariable(connection, 'time_zone', timeZone, signal);
    }
    if (characterSet !== null) {
      await setNames(connection, characterSet, signal);
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  let started = false;
  try {
    if (consistency === 'single-transaction') {
      await connection.query(
        { sql: 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ' },
        signal,
        'native',
      );
      // `WITH CONSISTENT SNAPSHOT` is what makes the snapshot start *here*
      // rather than at the first read, so introspection and every table read
      // observe the same instant. InnoDB-only, and silently a no-op for other
      // engines — see MysqlConsistencyMode.
      await connection.query(
        { sql: 'START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */' },
        signal,
        'native',
      );
      started = true;
    } else if (consistency === 'lock-all-tables') {
      await connection.query({ sql: 'FLUSH TABLES WITH READ LOCK' }, signal, 'native');
      started = true;
    }
  } catch (error) {
    await rollback();
    throw new MysqlDumperError(
      'consistency-mode-failed',
      `Could not establish consistency mode "${consistency}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let finished = false;
  return {
    consistency,
    timeZone,
    characterSet,
    originalSqlMode,
    finish: async (finishSignal?: AbortSignal) => {
      if (finished) return;
      finished = true;
      if (started) {
        try {
          if (consistency === 'single-transaction') {
            // A read-only snapshot has nothing to commit, but the transaction
            // must still be closed, or the connection goes back to the caller's
            // pool holding a snapshot that only grows staler.
            await connection.query({ sql: 'COMMIT' }, finishSignal, 'native');
          } else {
            await connection.query({ sql: 'UNLOCK TABLES' }, finishSignal, 'native');
          }
        } catch {
          // Best-effort: the dump's own result must survive a teardown failure.
        }
      }
      await rollback();
    },
  };
}

/**
 * Puts back the session variables this package changed.
 *
 * Deliberately issued **without** the caller's `AbortSignal`: the usual
 * reason for being here is that the signal was just aborted, and reusing it
 * would make the cleanup throw before restoring anything — leaking a
 * rewritten `sql_mode`/`time_zone`/charset onto a connection the caller owns
 * and may hand straight back to a pool.
 */
async function restoreSessionVariables(
  connection: MysqlConnection,
  original: {
    readonly sqlMode: string | null;
    readonly timeZone: string | null;
    readonly characterSet: string | null;
  },
): Promise<void> {
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      // ignored: cleanup must never replace the real result or error
    }
  };

  if (original.sqlMode !== null) {
    await attempt(() => setSessionVariable(connection, 'sql_mode', original.sqlMode as string));
  }
  if (original.timeZone !== null) {
    await attempt(() => setSessionVariable(connection, 'time_zone', original.timeZone as string));
  }
  if (original.characterSet !== null && SAFE_CHARACTER_SET_NAME.test(original.characterSet)) {
    await attempt(() => setNames(connection, original.characterSet as string));
  }
}
