# Restore API

```ts
restoreSqlDump({ connection, source, options?, progress?, signal? }): Promise<SqlDumpRestoreResult>
```

Restores a plain-SQL MySQL dump using only the `MysqlConnection` abstraction —
no `mysql` client, no external process. Works on dumps produced by this package
**and** on dumps produced by native `mysqldump`.

```ts
import { createReadStream } from 'node:fs';
import { restoreSqlDump } from 'dbgate-mysql-dumper';

const result = await restoreSqlDump({
  connection,
  source: createReadStream('shop.sql'),
  options: { databaseName: 'shop_copy' },
  progress: event => {
    if (event.phase === 'executing' && event.executionState === 'finished') {
      console.log(`${event.statementsProcessed} statements, ${event.rowsRestored} rows`);
    }
  },
});

for (const error of result.errors) {
  console.error(
    `statement ${error.statementIndex} (line ${error.location.startLine}): ${error.message}`,
  );
  console.error(`  ${error.sqlPreview}`); // truncated, credential-redacted
  console.error(`  errno=${error.serverError?.errno} sqlState=${error.serverError?.sqlState}`);
}
```

## `source`

```ts
type SqlDumpSource =
  string | Buffer | Uint8Array | Readable | AsyncIterable<string | Buffer | Uint8Array>;
```

Parsed incrementally: only the current statement's text plus a few carried
characters are held at a time, so a multi-gigabyte dump never lands in memory.

`Buffer` is accepted alongside `string` for a reason that matters. A dump written
without `--hex-blob` contains raw `BLOB` bytes and is **not valid UTF-8**;
forcing a caller to `.toString()` it would replace every invalid sequence with
U+FFFD and silently corrupt the data. Pass the bytes.

## Why a real lexer

Splitting a MySQL script on `;` is wrong, and not in an edge-case way — it breaks
on the _first_ stored program in any dump:

```sql
DELIMITER ;;

CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_recount`(IN `p_entity` VARCHAR(50))
BEGIN
  DECLARE `v_tmp` INT DEFAULT 0;
  SELECT COUNT(*) INTO `v_tmp` FROM `audit_log` WHERE `entity` = `p_entity`;
  INSERT INTO `audit_log` VALUES (`p_entity`, 'recounted; done -- not a comment');
END ;;

DELIMITER ;
```

A `split(';')` produces five fragments, none of them valid SQL. This package
ships an incremental lexer instead, which understands:

| Construct                      | Behaviour                                                              |
| ------------------------------ | ---------------------------------------------------------------------- |
| `'…'`, `"…"`                   | Backslash escapes and doubled quotes; a delimiter inside never splits. |
| `` `…` ``                      | Doubled backticks only — MySQL has **no** backslash escape here.       |
| `-- comment`                   | Only when followed by whitespace, so `5--3` stays arithmetic.          |
| `# comment`                    | Always a comment to end of line.                                       |
| `/* comment */`                | **Not** nested, matching MySQL (unlike SQL Server).                    |
| `/*!40000 … */`                | **Executable SQL**, scanned as statement text — see below.             |
| `/*+ hint */`                  | Optimizer hint, likewise statement text.                               |
| `DELIMITER x`                  | A _client_ command: consumed, never sent to the server.                |
| statements split across chunks | Identical output at every possible byte boundary.                      |

`tests/statementParser.test.ts` verifies boundary-invariance at **every** chunk
size and **every** single split point, and `tests/nativeFixtures.test.ts` does
the same over eight real `mysqldump` files.

### Executable comments are not comments

`/*!40000 ALTER TABLE t DISABLE KEYS */` carries real, version-gated SQL. MySQL
evaluates the version condition itself, so the whole comment is sent to the
server. Stripping it would drop the session setup, the key handling, and the
view and stored-program definitions from the restore.

One consequence is worth knowing: because the contents are ordinary statement
text, a delimiter _inside_ an executable comment really does end the statement —
exactly as in the `mysql` client. That is precisely why `mysqldump` wraps stored
programs in a `DELIMITER ;;` region, and the parser reproduces the behaviour
rather than special-casing around it.

### `DELIMITER`

Consumed by the parser, never sent to a server that would reject it. Any
delimiter string works:

```sql
DELIMITER $$        -- covered
DELIMITER ||        -- covered
DELIMITER GO        -- covered
DELIMITER ';;'      -- quoted form, covered
DELIMITER \         -- rejected: mysql refuses a backslash too
```

It is recognized only at the start of a line with nothing but whitespace
accumulated — the same rule the `mysql` client applies — so
`SELECT delimiter FROM t` and `SELECT 'delimiter ;;'` are left alone.

`ParsedStatement.delimiter` reports the delimiter in force for each statement,
and it appears on restore errors and progress events, which makes a mis-split
script diagnosable.

## `RestoreOptions`

| Option                | Default      | Meaning                                                                                   |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `databaseName`        | —            | `USE` this database first, so a dump without its own `USE` lands where intended.          |
| `stopOnError`         | `true`       | Stop at the first failing statement.                                                      |
| `definerPolicy`       | `'preserve'` | See below.                                                                                |
| `singleTransaction`   | `false`      | See below — MySQL limits what this can mean.                                              |
| `restoreSessionState` | `true`       | Release table locks and put back guards the dump changed, if the footer is never reached. |
| `maxStatementBytes`   | 256 MiB      | Bound on one statement's buffered text.                                                   |
| `initialDelimiter`    | `';'`        | Delimiter before the script's first `DELIMITER`.                                          |
| `backslashEscapes`    | `'auto'`     | `'auto'` \| `'enabled'` \| `'disabled'`.                                                  |

### `definerPolicy`

Every view, routine, trigger and event carries a `DEFINER` naming a MySQL
account. Restoring one whose definer does not exist on the target needs
`SET_USER_ID` (or `SUPER`) and otherwise fails with `ER_NO_SUCH_USER`. This is a
genuine policy question, so it is explicit rather than silently rewritten.

| Value            | Behaviour                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'preserve'`     | Send unchanged (default, and what `mysqldump` produces). Fails loudly if the account is missing — the right outcome, since a `SQL SECURITY DEFINER` object runs with the definer's privileges. |
| `'strip'`        | Remove the clause; the object belongs to the restoring account.                                                                                                                                |
| `'current-user'` | Rewrite to `DEFINER=CURRENT_USER` — the same outcome, stated in the SQL.                                                                                                                       |
| `'best-effort'`  | Send unchanged; **only** if it fails with a definer-specific error (`1227`, `1449`, `1470`), retry once without the clause.                                                                    |

`'best-effort'` deliberately does not retry an unrelated failure: a
`CREATE PROCEDURE` that failed on a syntax error would be retried to no purpose.
Any rewrite — by policy or by retry — produces a `definer-rewritten` warning, so
the substitution is never silent.

### `singleTransaction`

Defaults to `false`, and the reason matters: **MySQL commits implicitly before and
after every DDL statement.** A dump containing `CREATE TABLE` — which is nearly
all of them — cannot be rolled back as a unit no matter what this is set to.

Turning it on is only meaningful for a data-only restore, where it does exactly
what it says. It always emits a `single-transaction-limited` warning stating the
above, so nobody is left believing they have atomicity they do not have.

### `restoreSessionState`

A dump sets `FOREIGN_KEY_CHECKS=0`, `UNIQUE_CHECKS=0`, `SQL_MODE` and `TIME_ZONE`
in its header and restores them in its footer. A restore that stops at a failing
statement (the `stopOnError` default) or is cancelled **never reaches the
footer** — and the caller's connection then goes back to their pool with
referential integrity silently disabled. Their next unrelated write no longer
enforces it, and nothing in the API would let them detect or fix that.

So this defaults to `true`: the guards a dump changed are put back before the
connection is released, and a `session-state-restored` warning names which.

**Table locks are cleaned up the same way, and matter more.** Every dump wraps a
table's data in `LOCK TABLES t WRITE; … UNLOCK TABLES;`. A lock survives until
`UNLOCK TABLES` or the end of the session — a `ROLLBACK` does not release it —
so a restore that stopped in between used to hand the connection back still
holding a write lock. Every other session touching that table then blocked
indefinitely, and the holder itself could no longer touch any _other_ table
(`ER_TABLE_NOT_LOCKED`). An outstanding lock is now released before the
connection is released, and reported in the same warning.

## `SqlDumpRestoreResult`

```ts
{
  statementsExecuted: number;
  statementsFailed: number;
  rowsRestored: number;      // sum of affectedRows
  bytesConsumed: number;
  errors: readonly RestoreStatementError[];
  warnings: readonly RestoreWarning[];
  cancelled: boolean;
}
```

## Errors

Two kinds, treated differently on purpose.

### Parse errors — always fatal, thrown

The statement boundaries themselves cannot be trusted past the failure point, so
nothing after it can safely execute.

| Error                           | Cause                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MalformedSqlDumpError`         | Input ends inside a string, identifier or block comment.                                            |
| `InvalidDelimiterError`         | `DELIMITER` with an empty argument, or one containing a backslash.                                  |
| `StatementTooLargeError`        | One statement exceeded `maxStatementBytes` — usually a truncated dump or an unbalanced `DELIMITER`. |
| `UnsupportedClientCommandError` | A `mysql` client directive this package does not implement.                                         |
| `BinaryLiteralError`            | Non-UTF-8 bytes outside any string literal.                                                         |

All carry `line`, and all extend `SqlParseError` → `RestoreError` →
`MysqlDumperError` (which has a stable `code`).

### Execution errors — scoped to one statement

Recorded in `result.errors`; with `stopOnError: false` the restore continues.

```ts
{
  statementIndex: number;
  location: { startLine: number; endLine: number };
  sqlPreview: string;       // ≤200 chars, whitespace-collapsed, credentials redacted
  delimiter: string;        // in force when parsed — diagnoses a mis-split script
  message: string;
  serverError?: { errno?: number; code?: string; sqlState?: string; message: string };
}
```

`serverError` is MySQL's own structured error, so a caller can branch on
`errno === 1146` instead of matching on message text that changes with version
and locale.

`location.startLine` points at the first real SQL character, not at the leading
comment block, so it is directly usable against the source file.

**No error, preview, or diagnostic ever contains a credential.** `redactSecrets`
covers MySQL's own credential syntax — `IDENTIFIED BY`, `IDENTIFIED WITH … BY`,
`IDENTIFIED … AS 0x…`, `MASTER_PASSWORD`/`SOURCE_PASSWORD`, `PASSWORD(…)` — and
is applied to driver error _messages_ too, since some drivers echo the failing
statement back.

## Unsupported client commands

`mysql` preprocesses a handful of directives before anything reaches the server.
`DELIMITER` is implemented because a stored-program dump is unreadable without
it. The rest are **refused with a precise diagnostic** rather than ignored — a
`source` directive that silently never runs leaves the referenced file's objects
missing, which is a corrupted restore that looks like a successful one:

`source` / `\.`, `system`, `tee`, `notee`, `charset`, `pager`, `nopager`,
`prompt`, `connect`.

## Progress

```ts
progress: event => {
  // 'connecting' | 'preflight' | 'parsing' | 'executing' | 'finalizing'
  console.log(event.phase, event.currentObject, event.delimiter, event.bytesConsumed);
};
```

`currentObject` is read from the dump's own section banners
(`-- Dumping data for table \`books\``), so a long restore can say where it is
without the caller parsing anything.

## Preflight

```ts
import { preflightRestore } from 'dbgate-mysql-dumper';

const report = await preflightRestore({ connection: target, database: sourceModel });

if (report.diagnostics.some(d => d.severity === 'error')) {
  // e.g. "Restore target does not support CHECK constraints (MySQL 8.0.16+),
  //       which this dump uses: constraint "ck_books_price" on table "books""
  throw new Error('target cannot accept this dump');
}
```

Turns a failure thousands of statements in — with a syntax error naming a line
number rather than a reason — into an up-front, actionable report. Passing
`database` makes it "what does this dump need that this target cannot do"
rather than just "what can this target do". Also reports the target's
`max_allowed_packet` and `sql_mode`.

## Using the parser on its own

```ts
import { parseSqlStatements, streamSqlStatements, isMysqlDump } from 'dbgate-mysql-dumper';

if (!isMysqlDump(head)) throw new Error('not a MySQL dump');

for (const statement of parseSqlStatements(sql)) {
  console.log(statement.statementIndex, statement.delimiter, statement.location.startLine);
}

for await (const statement of streamSqlStatements(createReadStream('big.sql'))) {
  // constant memory
}
```

`isMysqlDump` recognizes both native `mysqldump` output and this package's own,
plus a headerless dump by its characteristic session guards. It reads at most the
first 8 KB, so a caller can pass just the head of a large file.
