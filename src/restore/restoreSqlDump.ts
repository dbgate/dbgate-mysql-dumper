import { acquireMysqlConnection, executeStatement } from '../connection/acquire.js';
import type { MysqlConnection, MysqlServerErrorInfo } from '../connection/types.js';
import { applyDefinerPolicy, hasDefinerClause } from '../renderer/definer.js';
import { quoteIdentifier } from '../security/identifiers.js';
import { isAbortError, throwIfAborted } from '../utils/errors.js';
import { RestoreExecutionError } from './errors.js';
import { redactSecrets, safeSqlPreview } from './preview.js';
import { RestoreSessionState } from './sessionState.js';
import { streamSqlStatements } from './statementParser.js';
import type { ParsedStatement } from './statementParser.js';
import type {
  RestoreStatementError,
  RestoreWarning,
  SqlDumpRestoreRequest,
  SqlDumpRestoreResult,
} from './types.js';

/**
 * MySQL error numbers that mean "the `DEFINER` account is a problem", used by
 * `definerPolicy: 'best-effort'` to decide whether a retry without the
 * clause is warranted.
 *
 * - `1227` `ER_SPECIFIC_ACCESS_DENIED_ERROR` — the restoring account lacks
 *   `SUPER`/`SET_USER_ID`, so it may not name a definer other than itself.
 * - `1449` `ER_NO_SUCH_USER` — the definer account does not exist here.
 * - `1470` `ER_WRONG_STRING_LENGTH` on a user name, which MySQL reports for
 *   a malformed definer.
 */
const DEFINER_ERROR_NUMBERS: ReadonlySet<number> = new Set([1227, 1449, 1470]);

/**
 * Restores a plain-SQL dump using only the {@link MysqlConnection}
 * abstraction — no `mysql` client, no external process.
 *
 * The input is split into statements by a real streaming lexer (see
 * `statementParser.ts`) that understands MySQL string, identifier and
 * comment syntax, treats executable comments as the SQL they are, and
 * consumes `DELIMITER` commands itself rather than sending them to a server
 * that would reject them. Statements execute sequentially on one connection.
 *
 * A structural problem with the input — an unterminated string, an invalid
 * `DELIMITER`, an unsupported client command — throws, because the statement
 * boundaries past that point cannot be trusted. A statement that parses but
 * fails on the server is recorded in `result.errors` instead, and unless
 * `stopOnError` (the default) is set, the restore continues.
 */
export async function restoreSqlDump(
  request: SqlDumpRestoreRequest,
): Promise<SqlDumpRestoreResult> {
  const options = request.options ?? {};
  const stopOnError = options.stopOnError ?? true;
  const definerPolicy = options.definerPolicy ?? 'preserve';
  const restoreSessionStateOnExit = options.restoreSessionState ?? true;

  request.progress?.({ phase: 'connecting' });
  const acquired = await acquireMysqlConnection(request.connection, request.signal);
  const connection = acquired.connection;

  let statementsExecuted = 0;
  let statementsFailed = 0;
  let rowsRestored = 0;
  let bytesConsumed = 0;
  const errors: RestoreStatementError[] = [];
  const warnings: RestoreWarning[] = [];
  const sessionState = new RestoreSessionState();

  let transactionOpen = false;

  const report = (
    phase: 'parsing' | 'executing' | 'finalizing',
    statement?: ParsedStatement,
    executionState?: 'started' | 'finished' | 'failed',
    error?: RestoreStatementError,
  ): void => {
    request.progress?.({
      phase,
      statementsProcessed: statementsExecuted + statementsFailed,
      rowsRestored,
      bytesConsumed,
      ...(statement === undefined
        ? {}
        : {
            statementIndex: statement.statementIndex,
            delimiter: statement.delimiter,
            ...(statement.currentObject === undefined
              ? {}
              : { currentObject: statement.currentObject }),
          }),
      ...(executionState === undefined ? {} : { executionState }),
      ...(error === undefined
        ? {}
        : {
            error: {
              statementIndex: error.statementIndex,
              location: error.location,
              sqlPreview: error.sqlPreview,
              message: error.message,
            },
          }),
    });
  };

  const finalize = async (): Promise<void> => {
    if (transactionOpen) {
      // Reached only on an error/cancel path; the success path commits first.
      await executeStatement(connection, 'ROLLBACK').catch(() => {});
      transactionOpen = false;
    }
    if (restoreSessionStateOnExit) {
      const restored = await sessionState.restore(connection);
      if (restored.length > 0) {
        warnings.push({
          code: 'session-state-restored',
          message: `The dump changed ${restored.join(', ')} in its header but the restore did not reach the matching footer statements, so they were reset before the connection was released.`,
        });
      }
    }
    await acquired.release();
  };

  try {
    if (options.databaseName) {
      await executeStatement(
        connection,
        `USE ${quoteIdentifier(options.databaseName)}`,
        request.signal,
      );
    }
    if (options.singleTransaction) {
      await executeStatement(connection, 'START TRANSACTION', request.signal);
      transactionOpen = true;
      warnings.push({
        code: 'single-transaction-limited',
        message:
          'singleTransaction is enabled, but MySQL commits implicitly before and after every DDL statement. Any CREATE/ALTER/DROP in this dump ends the transaction, so only a purely data-only restore is actually atomic.',
      });
    }

    for await (const statement of streamSqlStatements(request.source, options, request.signal)) {
      throwIfAborted(request.signal);
      bytesConsumed = statement.bytesConsumed;
      report('parsing', statement);

      const sql = applyDefinerPolicy(statement.sql, definerPolicy);
      if (sql !== statement.sql) {
        warnings.push({
          code: 'definer-rewritten',
          message: `The DEFINER clause of statement ${statement.statementIndex} was rewritten by definerPolicy "${definerPolicy}". A SQL SECURITY DEFINER object now runs with the restoring account's privileges instead of the original definer's.`,
          statementIndex: statement.statementIndex,
        });
      }

      report('executing', statement, 'started');
      try {
        const result = await executeStatement(connection, sql, request.signal);
        rowsRestored += result.affectedRows;
        statementsExecuted++;
        sessionState.observe(sql);
        report('executing', statement, 'finished');
        continue;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        const retried = await maybeRetryWithoutDefiner(
          connection,
          sql,
          definerPolicy,
          error,
          request.signal,
        );
        if (retried) {
          rowsRestored += retried.affectedRows;
          statementsExecuted++;
          sessionState.observe(retried.sql);
          warnings.push({
            code: 'definer-rewritten',
            message: `Statement ${statement.statementIndex} failed with a DEFINER-related error and was retried without its DEFINER clause (definerPolicy "best-effort"). The object now belongs to the restoring account.`,
            statementIndex: statement.statementIndex,
          });
          report('executing', statement, 'finished');
          continue;
        }

        statementsFailed++;
        const statementError = toStatementError(connection, statement, error);
        errors.push(statementError);
        report('executing', statement, 'failed', statementError);

        if (stopOnError) {
          await finalize();
          return {
            statementsExecuted,
            statementsFailed,
            rowsRestored,
            bytesConsumed,
            errors,
            warnings,
            cancelled: false,
          };
        }
      }
    }

    if (transactionOpen) {
      await executeStatement(connection, 'COMMIT', request.signal);
      transactionOpen = false;
    }

    report('finalizing');
    await finalize();
    return {
      statementsExecuted,
      statementsFailed,
      rowsRestored,
      bytesConsumed,
      errors,
      warnings,
      cancelled: false,
    };
  } catch (error) {
    await finalize();
    if (isAbortError(error)) {
      return {
        statementsExecuted,
        statementsFailed,
        rowsRestored,
        bytesConsumed,
        errors,
        warnings,
        cancelled: true,
      };
    }
    throw error;
  }
}

/**
 * For `definerPolicy: 'best-effort'`, retries a failed statement once with
 * its `DEFINER` clause removed — but only when the failure was actually
 * about the definer.
 *
 * Retrying indiscriminately would be wrong: a `CREATE PROCEDURE` that failed
 * on a syntax error would be retried to no purpose, and a statement that
 * partially succeeded would be re-executed. Gating on MySQL's own error
 * numbers keeps the retry to the case the policy is named for.
 */
async function maybeRetryWithoutDefiner(
  connection: MysqlConnection,
  sql: string,
  definerPolicy: string,
  error: unknown,
  signal?: AbortSignal,
): Promise<{ affectedRows: number; sql: string } | null> {
  if (definerPolicy !== 'best-effort' || !hasDefinerClause(sql)) {
    return null;
  }
  const serverError = connection.describeError?.(error);
  if (serverError?.errno === undefined || !DEFINER_ERROR_NUMBERS.has(serverError.errno)) {
    return null;
  }

  const withoutDefiner = applyDefinerPolicy(sql, 'strip');
  if (withoutDefiner === sql) {
    return null;
  }
  try {
    const result = await executeStatement(connection, withoutDefiner, signal);
    return { affectedRows: result.affectedRows, sql: withoutDefiner };
  } catch (retryError) {
    if (isAbortError(retryError)) {
      throw retryError;
    }
    // The retry failed too; report the *original* failure, which is the one
    // that describes what the dump actually asked for.
    return null;
  }
}

function toStatementError(
  connection: MysqlConnection,
  statement: ParsedStatement,
  error: unknown,
): RestoreStatementError {
  const serverError = connection.describeError?.(error);
  const message = redactSecrets(
    serverError?.message ?? (error instanceof Error ? error.message : String(error)),
  );
  const executionError = new RestoreExecutionError(
    statement.statementIndex,
    statement.location,
    safeSqlPreview(statement.sql),
    statement.delimiter,
    message,
    serverError ? redactServerError(serverError) : undefined,
    { cause: error },
  );
  return {
    statementIndex: executionError.statementIndex,
    location: executionError.location,
    sqlPreview: executionError.sqlPreview,
    delimiter: executionError.delimiter,
    message: executionError.message,
    ...(executionError.serverError === undefined
      ? {}
      : { serverError: executionError.serverError }),
  };
}

function redactServerError(serverError: MysqlServerErrorInfo): MysqlServerErrorInfo {
  return { ...serverError, message: redactSecrets(serverError.message) };
}
