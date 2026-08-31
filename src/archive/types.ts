import type { MysqlDiagnostic } from '../model/diagnostics.js';

/**
 * Every kind of entry the archive planner can produce.
 *
 * These map one-to-one onto the blocks `mysqldump` writes, including the two
 * that exist purely to make restore order work:
 *
 * - `viewStub` — the *"Temporary view structure"* placeholder. Before any
 *   real view exists, `mysqldump` creates each view as a dummy
 *   `CREATE VIEW v AS SELECT 1 AS col, ...` with the right column names.
 *   Later, when the real definitions are emitted, every view a definition
 *   references already exists with the correct shape — so views can be
 *   created in plain alphabetical order even when one depends on another,
 *   and even when the dependency sorts *after* its dependent. Reproducing
 *   this is what lets this package skip a topological sort of views without
 *   ever producing an unrestorable dump.
 * - `view` — the real *"Final view structure"* definition, which drops the
 *   stub and creates the view for real.
 *
 * Columns, indexes and constraints are deliberately absent: a MySQL
 * `CREATE TABLE` carries all of them inline, so there is no restore-ordering
 * question for them to answer.
 */
export type ArchiveObjectType =
  | 'database'
  | 'table'
  | 'tableData'
  | 'trigger'
  | 'viewStub'
  | 'event'
  | 'function'
  | 'procedure'
  | 'view';

/**
 * Emission sections, in output order. These mirror `mysqldump`'s own
 * top-level structure rather than the `pre-data`/`data`/`post-data` split
 * `pg_dump` uses:
 *
 * 1. `database` — optional `CREATE DATABASE` / `USE`.
 * 2. `main` — tables (structure, then data, then that table's triggers) and
 *    view stubs, **interleaved in one name-ordered pass**. `mysqldump`
 *    iterates `SHOW TABLES`, which lists tables and views together in name
 *    order, and this reproduces that exactly: a view named `aview` really
 *    does get its stub emitted before a table named `mt`.
 * 3. `events` — `CREATE EVENT`.
 * 4. `routines` — functions, then procedures.
 * 5. `views` — the real view definitions.
 */
export type DumpSection = 'database' | 'main' | 'events' | 'routines' | 'views';

/**
 * `hard`: the restore fails, or produces a wrong result, if the order is
 * violated. `preference`: the order is meaningful but the dump's own session
 * guards make a violation harmless — a foreign key between two tables is the
 * canonical case, since `FOREIGN_KEY_CHECKS=0` in the header makes any table
 * order restorable, which is exactly what allows circular foreign keys.
 */
export type ArchiveDependencyStrength = 'hard' | 'preference';

/** One directed edge from an entry to another entry it depends on. */
export interface ArchiveDependency {
  readonly targetDumpId: string;
  readonly strength: ArchiveDependencyStrength;
}

/**
 * One immutable, restore-orderable unit of the archive. Entries carry no SQL
 * text; rendering derives text from the model object identified by
 * `name`/`parentName` at render time.
 */
export interface ArchiveEntry {
  readonly dumpId: string;
  readonly identity: string;
  readonly objectType: ArchiveObjectType;
  readonly section: DumpSection;
  readonly databaseName: string;
  readonly name: string;
  /** Owning table name, for `tableData` and `trigger` entries. */
  readonly parentName?: string;
  readonly dependsOn: readonly ArchiveDependency[];
  /**
   * This entry's 0-based position in {@link DumpArchiveInspection.entries}.
   * Redundant with the array index when read from there directly, but
   * carried on the entry itself so a caller holding one `ArchiveEntry` out
   * of context (a diagnostic, a test assertion, a log line) can still see
   * where it landed. Omitted when `valid` is `false`, since no such order
   * exists.
   */
  readonly sequenceNumber?: number;
}

/** A set of entries mutually blocking each other via *hard* dependencies only; no valid order exists. */
export interface ArchiveCycle {
  readonly memberDumpIds: readonly string[];
}

/**
 * A hard dependency the planned order does not satisfy. Always empty for a
 * plan this package produced — it is reported rather than silently
 * reordered, because the emission order is fixed by native-compatibility
 * requirements, so a violation here means a *model* or planning bug rather
 * than something an ordering pass should paper over.
 */
export interface UnsatisfiedDependency {
  readonly fromDumpId: string;
  readonly toDumpId: string;
}

export interface DumpArchiveInspection {
  readonly valid: boolean;
  /**
   * In emission order, with `sequenceNumber` set, when `valid` is `true`.
   * When `valid` is `false` the same entries are present in the same
   * deterministic order, but without `sequenceNumber`, since that order is
   * not a claim of a correct restore order.
   */
  readonly entries: readonly ArchiveEntry[];
  readonly diagnostics: readonly MysqlDiagnostic[];
  /** Unresolved hard-dependency cycles. Always present; empty when `valid` is `true`. */
  readonly cycles: readonly ArchiveCycle[];
  /** Hard dependencies the emission order violates. Always present; empty when `valid` is `true`. */
  readonly unsatisfiedDependencies: readonly UnsatisfiedDependency[];
}

export type DumpMode = 'full' | 'schema-only' | 'data-only';
