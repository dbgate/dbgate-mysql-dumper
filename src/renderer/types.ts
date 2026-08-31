import type { ArchiveEntry, DumpArchiveInspection, DumpMode } from '../archive/types.js';
import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { SqlModeCompatibility } from './sqlMode.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import type { MysqlVersion } from '../version/types.js';
import type { DumpWriter } from '../writer/types.js';

export type LineEnding = '\n' | '\r\n';

/**
 * What to do about a `DEFINER` clause, which every view, routine, trigger
 * and event carries.
 *
 * A `DEFINER` names a MySQL account. Restoring an object whose definer does
 * not exist on the target requires `SET_USER_ID` (or `SUPER`) and, without
 * it, fails with `ER_NO_SUCH_USER` / `ER_SPECIFIC_ACCESS_DENIED_ERROR`. The
 * choice is genuinely a policy question, so it is made explicit rather than
 * silently rewritten:
 *
 * - `'preserve'` (default) keeps the definer exactly as the source has it,
 *   which is what `mysqldump` does and what makes a same-server restore an
 *   exact reproduction. A restore into a server missing that account fails
 *   loudly — the right outcome, since `SQL SECURITY DEFINER` objects run
 *   with the definer's privileges and quietly substituting a different
 *   account changes what they are allowed to do.
 * - `'strip'` removes the `DEFINER` clause, so the object is created with
 *   the restoring account as its definer. Portable, but note that a
 *   `SQL SECURITY DEFINER` object then runs with the restorer's privileges.
 * - `'current-user'` rewrites the clause to `CURRENT_USER`, which is the
 *   same outcome as `'strip'` stated explicitly in the SQL.
 * - `'best-effort'` keeps the definer but wraps each definer-carrying
 *   statement so that a definer failure is reported as a warning and the
 *   object is retried without the clause. Only meaningful during restore;
 *   during rendering it behaves as `'preserve'`.
 */
export type DefinerPolicy = 'preserve' | 'strip' | 'current-user' | 'best-effort';

export interface PlainSqlRenderOptions {
  /**
   * Emit `DROP TABLE IF EXISTS` before each `CREATE TABLE` (and the
   * matching `DROP` for views, routines and events). `mysqldump --opt`
   * default; defaults to `true` here too.
   */
  readonly addDropTable?: boolean;
  /**
   * Wrap each table's data in `LOCK TABLES ... WRITE` / `UNLOCK TABLES`.
   * `mysqldump --opt` default; defaults to `true`.
   *
   * On restore this makes each table's insert batch one uninterrupted
   * writer, which is faster and keeps other sessions from observing a
   * half-loaded table.
   */
  readonly addLocks?: boolean;
  /**
   * Wrap each table's data in
   * `/*!40000 ALTER TABLE t DISABLE KEYS &#42;/` … `ENABLE KEYS`.
   * `mysqldump --opt` default; defaults to `true`.
   *
   * This is a MyISAM optimization — InnoDB ignores it — but it is emitted
   * unconditionally, exactly as `mysqldump` does, because the dump does not
   * get to choose the engine of the table it is restored into.
   */
  readonly disableKeys?: boolean;
  /**
   * Emit multi-row `INSERT INTO t VALUES (...),(...)` statements rather than
   * one statement per row. `mysqldump --opt` default; defaults to `true`.
   */
  readonly extendedInsert?: boolean;
  /**
   * Always name the columns in `INSERT` statements
   * (`INSERT INTO t (a, b) VALUES ...`). Defaults to `false`, matching
   * `mysqldump`.
   *
   * Note that the column list is emitted *regardless* of this option
   * whenever a table has generated or invisible columns, because those
   * cannot appear in the insert and a positional `VALUES` list would then
   * not line up — `mysqldump` behaves identically.
   */
  readonly completeInsert?: boolean;
  /**
   * Render `BLOB`/`BINARY`/`VARBINARY`/`BIT` values as hexadecimal literals
   * (`0xDEADBEEF`) instead of `_binary '...'` with raw bytes.
   *
   * **Defaults to `true`, unlike `mysqldump --hex-blob` which is off.** This
   * is the one deliberate default deviation in this package, and it makes
   * the dump strictly safer: with raw bytes the dump file is not valid text
   * in any encoding, so any tool in the path that touches encoding — an
   * editor, a transfer that translates line endings, a pipe through a
   * non-binary-safe shell, or simply a `SET NAMES utf8mb4` connection being
   * handed bytes that are not valid UTF-8 — can corrupt it silently. MySQL's
   * own documentation recommends `--hex-blob` for exactly this reason. Set
   * to `false` for byte-identical `mysqldump` default output; both forms
   * restore identically, and both are covered by the round-trip tests.
   */
  readonly hexBlob?: boolean;
  /**
   * Emit the character-set session guards (`SET NAMES`, the
   * `@OLD_CHARACTER_SET_*` save/restore pair). `mysqldump` default;
   * defaults to `true`.
   */
  readonly setCharset?: boolean;
  /** Character set named in `SET NAMES`. Defaults to `'utf8mb4'`. */
  readonly characterSet?: string;
  /**
   * Emit the whole session-guard preamble and footer — `SQL_MODE`,
   * `FOREIGN_KEY_CHECKS`, `UNIQUE_CHECKS`, `TIME_ZONE`, `SQL_NOTES`.
   * Defaults to `true`, and turning it off produces a
   * `session-guards-disabled` warning.
   *
   * These are not decoration. `SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` is what
   * clears `NO_BACKSLASH_ESCAPES` on the restoring session, without which
   * every backslash escape in the dump's string literals is reinterpreted
   * and the data silently corrupts; `FOREIGN_KEY_CHECKS=0` is what allows
   * tables to be restored in any order, circular foreign keys included.
   */
  readonly includeSessionGuards?: boolean;
  /** Emit `CREATE DATABASE IF NOT EXISTS`. Defaults to `false` (`mysqldump --databases` behaviour). */
  readonly includeCreateDatabase?: boolean;
  /** Emit `USE <database>`. Defaults to the value of {@link includeCreateDatabase}. */
  readonly includeUseDatabase?: boolean;
  /** Emit the leading `-- MySQL dump ...` comment block. Defaults to `true`. */
  readonly includeHeaderComments?: boolean;
  /** Emit the trailing `-- Dump completed on ...` line. Defaults to `true`. */
  readonly includeFooterComment?: boolean;
  /**
   * Emit a wall-clock timestamp in the footer (and in the header, when
   * present). Defaults to `true`; set to `false` for byte-reproducible
   * output across runs.
   */
  readonly includeTimestamp?: boolean;
  /** Value for the header's `-- Host:` field. Purely informational; defaults to `'localhost'`. */
  readonly hostLabel?: string;
  /**
   * Session time zone the dump sets before loading data. `'+00:00'`
   * (default) matches `mysqldump --tz-utc` and must agree with the session
   * the rows were *read* under — see `MysqlDumpSessionOptions.timeZone`.
   * `null` omits the `TIME_ZONE` guard entirely.
   */
  readonly timeZone?: string | null;
  readonly definerPolicy?: DefinerPolicy;
  /**
   * How a stored program's recorded `sql_mode` is written into the dump.
   * `'portable'` (default) drops modes MySQL 8.0 removed, matching
   * `mysqldump`, so a dump taken from 5.7 still restores on 8.0+. See
   * `sqlMode.ts`.
   */
  readonly sqlModeCompatibility?: SqlModeCompatibility;
  readonly lineEnding?: LineEnding;
  /**
   * How to react to a model feature that cannot be rendered. `'error'`
   * (default) fails the render; `'warn-omit'` skips the entry and records a
   * warning diagnostic.
   */
  readonly unsupportedFeaturePolicy?: 'error' | 'warn-omit';
}

export interface ResolvedPlainSqlRenderOptions {
  readonly addDropTable: boolean;
  readonly addLocks: boolean;
  readonly disableKeys: boolean;
  readonly extendedInsert: boolean;
  readonly completeInsert: boolean;
  readonly hexBlob: boolean;
  readonly setCharset: boolean;
  readonly characterSet: string;
  readonly includeSessionGuards: boolean;
  readonly includeCreateDatabase: boolean;
  readonly includeUseDatabase: boolean;
  readonly includeHeaderComments: boolean;
  readonly includeFooterComment: boolean;
  readonly includeTimestamp: boolean;
  readonly hostLabel: string;
  readonly timeZone: string | null;
  readonly definerPolicy: DefinerPolicy;
  readonly sqlModeCompatibility: SqlModeCompatibility;
  readonly lineEnding: LineEnding;
  readonly unsupportedFeaturePolicy: 'error' | 'warn-omit';
}

export function resolvePlainSqlRenderOptions(
  options?: PlainSqlRenderOptions,
): ResolvedPlainSqlRenderOptions {
  const includeCreateDatabase = options?.includeCreateDatabase ?? false;
  return {
    addDropTable: options?.addDropTable ?? true,
    addLocks: options?.addLocks ?? true,
    disableKeys: options?.disableKeys ?? true,
    extendedInsert: options?.extendedInsert ?? true,
    completeInsert: options?.completeInsert ?? false,
    hexBlob: options?.hexBlob ?? true,
    setCharset: options?.setCharset ?? true,
    characterSet: options?.characterSet ?? 'utf8mb4',
    includeSessionGuards: options?.includeSessionGuards ?? true,
    includeCreateDatabase,
    includeUseDatabase: options?.includeUseDatabase ?? includeCreateDatabase,
    includeHeaderComments: options?.includeHeaderComments ?? true,
    includeFooterComment: options?.includeFooterComment ?? true,
    includeTimestamp: options?.includeTimestamp ?? true,
    hostLabel: options?.hostLabel ?? 'localhost',
    timeZone: options?.timeZone === undefined ? '+00:00' : options.timeZone,
    definerPolicy: options?.definerPolicy ?? 'preserve',
    sqlModeCompatibility: options?.sqlModeCompatibility ?? 'portable',
    lineEnding: options?.lineEnding ?? '\n',
    unsupportedFeaturePolicy: options?.unsupportedFeaturePolicy ?? 'error',
  };
}

export interface PlainSqlRenderRequest {
  readonly database: MysqlDatabase;
  readonly archive: DumpArchiveInspection;
  readonly writer: DumpWriter;
  readonly options?: PlainSqlRenderOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: DumpProgressCallback;
  /** Source server version; used only to enrich the dump header. */
  readonly sourceVersion?: MysqlVersion;
  /** Which dump mode produced `archive`; used only to enrich the dump header. */
  readonly mode?: DumpMode;
  /**
   * Which object *kinds* the dump was asked for, independent of whether any
   * such object exists.
   *
   * `mysqldump` emits the `-- Dumping events for database` and
   * `-- Dumping routines for database` banners whenever `--events`/`--routines`
   * were given — **even when the database has none** — and omits them entirely
   * otherwise. Reproducing that needs the caller's intent, which cannot be
   * recovered from the archive: a database with no events produces no event
   * entries either way. Defaults to `true` for both, matching this package's
   * own defaults.
   */
  readonly includedKinds?: {
    readonly events?: boolean;
    readonly routines?: boolean;
  };
  /**
   * Called for each `tableData` entry instead of the default "not rendered"
   * warning, for callers that can actually stream the rows (see `dumpMysql`,
   * which supplies this backed by a live connection).
   *
   * The hook is responsible for the `INSERT` statements only; the
   * surrounding `LOCK TABLES` / `DISABLE KEYS` / `UNLOCK TABLES` frame is
   * written by the renderer either way, so an empty table still produces the
   * same block `mysqldump` writes for one. Resolve `true` once the rows have
   * been written to `writer`; resolve `false` to fall back to the default
   * warning for that entry.
   */
  readonly onTableData?: (entry: ArchiveEntry) => Promise<boolean>;
}

export interface PlainSqlRenderResult {
  readonly bytesWritten: number;
  readonly renderedDumpIds: readonly string[];
  readonly skippedDumpIds: readonly string[];
  readonly warnings: readonly MysqlDiagnostic[];
  readonly cancelled: boolean;
}
