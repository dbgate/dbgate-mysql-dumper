/**
 * Session state MySQL records at creation time for every stored program and
 * view, and restores when the object runs.
 *
 * `mysqldump` writes these back around each object's `CREATE` — a routine
 * created under `ANSI_QUOTES` must be *re-created* under `ANSI_QUOTES` or its
 * body will not parse, and a view created with a `latin1` client charset
 * must be re-created the same way or its string literals change meaning.
 * Reproducing that save/set/restore dance is not cosmetic; it is what makes
 * a stored-program dump restorable at all.
 */
export interface MysqlCreationContext {
  /** `character_set_client` in force when the object was created. */
  readonly characterSetClient: string | null;
  /** `collation_connection` in force when the object was created. */
  readonly collationConnection: string | null;
  /** `sql_mode` in force when the object was created. */
  readonly sqlMode: string | null;
}

/** `SQL SECURITY` mode of a view or stored routine. */
export type MysqlSecurityType = 'DEFINER' | 'INVOKER';

export interface MysqlView {
  readonly databaseName: string;
  readonly pureName: string;
  /** `VIEWS.VIEW_DEFINITION`: the `SELECT` body only, without `CREATE VIEW`. */
  readonly definition: string;
  /**
   * Verbatim `SHOW CREATE VIEW` text, which — unlike `VIEW_DEFINITION` —
   * includes the `ALGORITHM`, `DEFINER` and `SQL SECURITY` clauses.
   */
  readonly createSql: string;
  readonly definer: string | null;
  readonly securityType: MysqlSecurityType;
  /** `NONE`, `LOCAL` or `CASCADED`. */
  readonly checkOption: string;
  readonly isUpdatable: boolean;
  /** `UNDEFINED`, `MERGE` or `TEMPTABLE`. */
  readonly algorithm: string;
  readonly creationContext: MysqlCreationContext;
  /**
   * Column names the view exposes, in order. Needed to emit the stub
   * (`SELECT 1 AS col, ...`) placeholder table `mysqldump` writes before the
   * real definition — see `docs/native-compatibility.md`.
   */
  readonly columnNames: readonly string[];
}

export type MysqlRoutineKind = 'PROCEDURE' | 'FUNCTION';

export interface MysqlRoutine {
  readonly databaseName: string;
  readonly pureName: string;
  readonly kind: MysqlRoutineKind;
  /**
   * Verbatim `SHOW CREATE PROCEDURE`/`SHOW CREATE FUNCTION` text, including
   * the `DEFINER` clause, parameter list, characteristics and body.
   */
  readonly createSql: string;
  readonly definer: string | null;
  readonly securityType: MysqlSecurityType;
  readonly isDeterministic: boolean;
  /** `CONTAINS SQL`, `NO SQL`, `READS SQL DATA` or `MODIFIES SQL DATA`. */
  readonly dataAccess: string;
  readonly comment: string;
  /** Formal parameter list source, for reporting; the DDL comes from {@link createSql}. */
  readonly parameterList: string | null;
  /** Declared return type, for a `FUNCTION`. */
  readonly returnType: string | null;
  readonly creationContext: MysqlCreationContext;
}

export type MysqlTriggerTiming = 'BEFORE' | 'AFTER';
export type MysqlTriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE';

export interface MysqlTrigger {
  readonly databaseName: string;
  readonly triggerName: string;
  /** Table the trigger is attached to. */
  readonly tableName: string;
  readonly timing: MysqlTriggerTiming;
  readonly event: MysqlTriggerEvent;
  /** Verbatim `SHOW CREATE TRIGGER` text. */
  readonly createSql: string;
  /** `TRIGGERS.ACTION_STATEMENT`: the body only. */
  readonly actionStatement: string;
  /** `ROW` — the only value MySQL supports. */
  readonly actionOrientation: string;
  /**
   * Ordering among several triggers with the same timing and event
   * (`FOLLOWS`/`PRECEDES`, MySQL 5.7+). `null` when unordered.
   */
  readonly actionOrder: number | null;
  readonly definer: string | null;
  readonly creationContext: MysqlCreationContext;
}

export interface MysqlEvent {
  readonly databaseName: string;
  readonly eventName: string;
  /** Verbatim `SHOW CREATE EVENT` text. */
  readonly createSql: string;
  readonly definer: string | null;
  /** `ONE TIME` or `RECURRING`. */
  readonly eventType: string;
  readonly intervalValue: string | null;
  readonly intervalField: string | null;
  readonly executeAt: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** `ENABLED`, `DISABLED` or `SLAVESIDE_DISABLED`. */
  readonly status: string;
  /** `PRESERVE` or `NOT PRESERVE`. */
  readonly onCompletion: string;
  readonly comment: string;
  /** Session time zone in force at creation; restored around the `CREATE EVENT`. */
  readonly timeZone: string | null;
  readonly creationContext: MysqlCreationContext;
}
