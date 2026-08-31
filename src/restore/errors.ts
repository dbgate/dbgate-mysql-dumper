import type { MysqlServerErrorInfo } from '../connection/types.js';
import { MysqlDumperError } from '../utils/errors.js';
import type { StatementSourceLocation } from './location.js';

/** Common base for every error {@link restoreSqlDump} (or its parser) throws intentionally. */
export class RestoreError extends MysqlDumperError {}

/**
 * The input could not be split into statements correctly.
 *
 * Always fatal: unlike a statement that fails when executed, a parse failure
 * means the statement boundaries themselves are not trustworthy, so nothing
 * after the failure point can be safely executed either.
 */
export class SqlParseError extends RestoreError {
  readonly line: number;

  constructor(code: string, message: string, line: number, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = 'SqlParseError';
    this.line = line;
  }
}

/**
 * The input ended while a lexical construct — a string, a backtick-quoted
 * identifier, a block comment — was still open. The script is structurally
 * incomplete and cannot be split into valid statements.
 */
export class MalformedSqlDumpError extends SqlParseError {
  readonly openConstruct: string;

  constructor(openConstruct: string, line: number) {
    super(
      'malformed-sql-dump',
      `Unterminated ${openConstruct} starting at line ${line}: the input ends before it is closed`,
      line,
    );
    this.name = 'MalformedSqlDumpError';
    this.openConstruct = openConstruct;
  }
}

/**
 * A `DELIMITER` command was found but its argument is unusable — empty, or
 * containing a backslash, which MySQL's own client rejects because a
 * backslash would collide with the escape character it uses inside string
 * literals.
 */
export class InvalidDelimiterError extends SqlParseError {
  readonly rawArgument: string;

  constructor(rawArgument: string, line: number, reason: string) {
    super(
      'invalid-delimiter',
      `Invalid DELIMITER on line ${line}: ${reason} (found ${JSON.stringify(rawArgument)})`,
      line,
    );
    this.name = 'InvalidDelimiterError';
    this.rawArgument = rawArgument;
  }
}

/**
 * One statement's accumulated text exceeded
 * {@link SqlStatementParserOptions.maxStatementBytes} before its delimiter
 * was found.
 *
 * A statement must be sent to the server whole, so this bounds how much of a
 * pathological input — a truncated dump, or a file whose delimiter was never
 * restored after a `DELIMITER ;;` region — the parser will buffer before
 * giving up, instead of growing without limit.
 */
export class StatementTooLargeError extends SqlParseError {
  readonly maxStatementBytes: number;

  constructor(maxStatementBytes: number, line: number) {
    super(
      'statement-too-large',
      `Statement starting near line ${line} exceeds the configured limit of ${maxStatementBytes} bytes without reaching its delimiter; increase options.maxStatementBytes if this statement is genuinely intended to be this large, or check for an unbalanced DELIMITER command`,
      line,
    );
    this.name = 'StatementTooLargeError';
    this.maxStatementBytes = maxStatementBytes;
  }
}

/**
 * A `mysql` client command this package does not implement was found where
 * it would change the meaning of the script.
 *
 * `mysql` preprocesses a handful of backslash commands (`source`/`\.`,
 * `\u`/`use`, `\C`/`charset`, `system`) before anything reaches the server.
 * `DELIMITER` is implemented because a stored-program dump is unreadable
 * without it; the rest are refused with a precise diagnostic rather than
 * being silently ignored, which would corrupt the restore — a `source`
 * directive that never runs leaves the referenced file's objects missing.
 */
export class UnsupportedClientCommandError extends SqlParseError {
  readonly command: string;

  constructor(command: string, line: number) {
    super(
      'unsupported-client-command',
      `Unsupported mysql client command "${command}" on line ${line}: dbgate-mysql-dumper executes plain SQL statements and implements only the DELIMITER command. Run this script through the mysql client, or remove the directive.`,
      line,
    );
    this.name = 'UnsupportedClientCommandError';
    this.command = command;
  }
}

/**
 * A statement parsed successfully but failed when executed.
 *
 * Unlike a parse error this is scoped to one statement: with
 * `stopOnError: false`, restoration continues with the next one, and this
 * error's data — never the raw driver error, which can echo back parts of
 * the failing statement — is what is recorded in
 * {@link SqlDumpRestoreResult.errors}.
 */
export class RestoreExecutionError extends RestoreError {
  readonly statementIndex: number;
  readonly location: StatementSourceLocation;
  readonly sqlPreview: string;
  /** The delimiter in force when this statement was parsed, for diagnosing a mis-split script. */
  readonly delimiter: string;
  readonly serverError?: MysqlServerErrorInfo;

  constructor(
    statementIndex: number,
    location: StatementSourceLocation,
    sqlPreview: string,
    delimiter: string,
    message: string,
    serverError?: MysqlServerErrorInfo,
    options?: { cause?: unknown },
  ) {
    super('restore-execution-failed', message, options);
    this.name = 'RestoreExecutionError';
    this.statementIndex = statementIndex;
    this.location = location;
    this.sqlPreview = sqlPreview;
    this.delimiter = delimiter;
    if (serverError) {
      this.serverError = serverError;
    }
  }
}

/**
 * A statement holds bytes that are not valid UTF-8 outside any string
 * literal, so it cannot be sent to the server as text without corrupting
 * them.
 *
 * Raw binary *inside* a literal is handled transparently — see
 * `binaryLiterals.ts`, which rewrites a raw `_binary` literal into the
 * equivalent hexadecimal form — so reaching this means the input is not a
 * mysqldump-shaped file at all, or was truncated mid-literal. It is reported
 * rather than papered over, because the alternative is silently replacing
 * every offending byte with U+FFFD.
 */
export class BinaryLiteralError extends SqlParseError {
  constructor(message: string, line: number) {
    super('binary-literal-not-representable', `${message} (near line ${line})`, line);
    this.name = 'BinaryLiteralError';
  }
}
