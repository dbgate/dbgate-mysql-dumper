import type { MysqlConnectionInput, MysqlServerErrorInfo } from '../connection/types.js';
import type { DefinerPolicy } from '../renderer/types.js';
import type { RestoreProgressCallback } from '../utils/progress.js';
import type { StatementSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';
import type { SqlStatementParserOptions } from './statementParser.js';

export interface RestoreOptions extends SqlStatementParserOptions {
  /** Stop at the first statement that fails. Defaults to `true`. */
  readonly stopOnError?: boolean;
  /**
   * `USE <database>` before restoring, so a dump without its own `USE` lands
   * in the intended database. When omitted, statements run against whatever
   * database the connection already has selected.
   */
  readonly databaseName?: string;
  /**
   * What to do with `DEFINER` clauses the dump carries.
   *
   * `'preserve'` (default) sends them unchanged. `'strip'` and
   * `'current-user'` rewrite them before execution, which makes a dump from
   * another server restorable without its accounts existing here.
   * `'best-effort'` sends the statement unchanged and, *only* if it fails
   * with a definer-related error, retries it once with the clause removed —
   * recording a `definer-rewritten` warning either way, so the substitution
   * is never silent.
   */
  readonly definerPolicy?: DefinerPolicy;
  /**
   * Restore inside one transaction, rolled back if anything fails.
   *
   * Defaults to `false`, and the reason matters: MySQL commits implicitly
   * before and after every DDL statement, so a dump containing
   * `CREATE TABLE` — which is nearly all of them — cannot be rolled back as
   * a unit no matter what this is set to. Turning it on is only meaningful
   * for a data-only restore, where it does exactly what it says.
   */
  readonly singleTransaction?: boolean;
  /**
   * Restore the session variables the dump changed even if the dump's own
   * footer is never reached — because a statement failed, or the operation
   * was cancelled. Defaults to `true`.
   *
   * A dump sets `FOREIGN_KEY_CHECKS=0`, `UNIQUE_CHECKS=0`, `SQL_MODE` and
   * `TIME_ZONE` in its header and restores them in its footer. A restore
   * that stops in between would otherwise hand the caller's connection back
   * with foreign-key checking still disabled.
   */
  readonly restoreSessionState?: boolean;
}

export interface SqlDumpRestoreRequest {
  readonly connection: MysqlConnectionInput;
  readonly source: SqlDumpSource;
  readonly options?: RestoreOptions;
  readonly signal?: AbortSignal;
  readonly progress?: RestoreProgressCallback;
}

/** One statement that parsed successfully but failed when executed. */
export interface RestoreStatementError {
  readonly statementIndex: number;
  readonly location: StatementSourceLocation;
  /** Truncated, credential-redacted preview of the failing statement. */
  readonly sqlPreview: string;
  /** The delimiter in force when the statement was parsed. */
  readonly delimiter: string;
  readonly message: string;
  /** MySQL's own `errno`/`code`/`sqlState`, when the adapter can report them. */
  readonly serverError?: MysqlServerErrorInfo;
}

export interface SqlDumpRestoreResult {
  readonly statementsExecuted: number;
  readonly statementsFailed: number;
  /**
   * Sum of `affectedRows` across every successfully executed statement.
   *
   * In practice this reflects rows inserted, since DDL reports 0 — but it is
   * a straightforward sum, not an insert-specific heuristic, so a script
   * containing its own `UPDATE`/`DELETE` statements contributes those rows
   * too.
   */
  readonly rowsRestored: number;
  /** UTF-8 bytes of the source consumed. */
  readonly bytesConsumed: number;
  readonly errors: readonly RestoreStatementError[];
  readonly warnings: readonly RestoreWarning[];
  readonly cancelled: boolean;
}

export interface RestoreWarning {
  readonly code: string;
  readonly message: string;
  readonly statementIndex?: number;
}
