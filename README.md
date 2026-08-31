# dbgate-mysql-dumper

Standalone, client-agnostic MySQL dump and restore library for Node.js.

Produces an ordinary plain-SQL MySQL dump and restores it back — entirely over a
MySQL connection. **No `mysqldump`, no `mysql` client, no MySQL Shell, no
external process is ever invoked.** Framework-independent: it does not depend on
DbGate internals and works outside DbGate.

- Node.js >= 20, ESM and CJS builds, full TypeScript types
- `mysql2` is an **optional** peer dependency, reachable only through the
  separate `dbgate-mysql-dumper/mysql2` entry point — the core never imports a
  driver
- Streaming both ways: a multi-gigabyte database dumps, and a multi-gigabyte
  `.sql` file restores, in constant memory

## Two-way native compatibility

Both directions are **proven by automated tests against real MySQL 5.7, 8.0 and
8.4**, not assumed:

- **Dumps produced by this library restore with the native `mysql` client.**
  ```sh
  mysql mydatabase < dump.sql
  ```
- **SQL dumps produced by native `mysqldump` restore with this library.**
  ```ts
  await restoreSqlDump({ connection, source: createReadStream('mysqldump-output.sql') });
  ```

There is no custom format, no archive wrapper, and no metadata sidecar. A `.sql`
file this package writes is the same kind of file `mysqldump` writes — on MySQL
8.0 and 8.4 it is **byte-identical** to
`mysqldump --routines --events --triggers --hex-blob`, apart from three lines that
cannot be identical (the producer name, the host label, and the timestamp). On
5.7 there are four further lines, where this package emits 8.0's corrected
charset spellings rather than 5.7's; they are
[enumerated and explained](docs/native-compatibility.md#deliberate-divergences-on-mysql-57),
and a test fails if a fifth ever appears.

Every path in the matrix ends by introspecting the restored database and
deep-comparing both its schema model _and_ every table's rows, hex-encoded,
against the source. See [docs/native-compatibility.md](docs/native-compatibility.md)
and [docs/round-trip-testing.md](docs/round-trip-testing.md).

| Path                                           | Tested           |
| ---------------------------------------------- | ---------------- |
| this library → native `mysql` restore          | ✅ 5.7, 8.0, 8.4 |
| native `mysqldump` → this library's restore    | ✅ 5.7, 8.0, 8.4 |
| this library → this library                    | ✅ 5.7, 8.0, 8.4 |
| native `mysqldump` → native `mysql` (baseline) | ✅ 5.7, 8.0, 8.4 |

## Install

```sh
npm install dbgate-mysql-dumper
# optional, for the bundled mysql2 adapter:
npm install mysql2
```

## Quick start

### Dump

```ts
import { createWriteStream } from 'node:fs';
import { dumpMysql } from 'dbgate-mysql-dumper';
import { connectMysql2 } from 'dbgate-mysql-dumper/mysql2';

const { connection, close } = await connectMysql2({
  host: 'localhost',
  user: 'root',
  password: '…',
  database: 'shop',
});

try {
  const result = await dumpMysql(
    connection,
    { mode: 'full' },
    createWriteStream('shop.sql'),
    event => console.log(event.phase, event.objectName ?? '', event.bytesWritten ?? ''),
  );

  console.log(`${result.rowsExported} rows in ${result.statementsWritten} statements`);
  for (const warning of result.warnings) {
    console.warn(`[${warning.severity}] ${warning.code}: ${warning.message}`);
  }
} finally {
  await close();
}
```

The result is restorable by `mysql shop_copy < shop.sql`.

### Restore

```ts
import { createReadStream } from 'node:fs';
import { restoreSqlDump } from 'dbgate-mysql-dumper';

const result = await restoreSqlDump({
  connection,
  source: createReadStream('shop.sql'),
  options: { databaseName: 'shop_copy' },
  progress: event => console.log(event.phase, event.currentObject, event.rowsRestored),
});

console.log(`${result.statementsExecuted} statements, ${result.rowsRestored} rows`);
for (const error of result.errors) {
  console.error(
    `statement ${error.statementIndex} (line ${error.location.startLine}): ${error.message}`,
  );
  console.error(`  ${error.sqlPreview}`); // truncated, credential-redacted
  console.error(`  errno=${error.serverError?.errno}`);
}
```

`source` accepts a `string`, a `Buffer`, a `Readable`, or any `AsyncIterable` of
text or `Buffer` chunks. Input is parsed incrementally, so restoring a
multi-gigabyte dump does not read it into memory.

### Using an existing connection or pool

```ts
import mysql from 'mysql2/promise';
import { fromMysql2Connection, fromMysql2Pool } from 'dbgate-mysql-dumper/mysql2';

const connection = fromMysql2Connection(await mysql.createConnection(config));
const source = fromMysql2Pool(mysql.createPool(config)); // checks out one connection per operation
```

A connection you supply is **borrowed and never closed**. A pool has one
connection checked out for the whole operation and released — never destroyed —
afterwards, because the consistent snapshot and the pinned session variables are
session state. See [docs/mysql2-adapter.md](docs/mysql2-adapter.md).

## Public API

| Function                                                               | Purpose                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `dumpMysql(connection, options, output, onProgress?, signal?)`         | Full pipeline: session → introspect → plan → render → stream rows |
| `restoreSqlDump({ connection, source, options?, progress?, signal? })` | Streaming lexer → statements → server                             |
| `introspectMysql(connection, options?, signal?)`                       | Normalized `MysqlDatabase` + version/capabilities/diagnostics     |
| `inspectDumpArchive(database, options?)`                               | Pure planning → ordered, verified `ArchiveEntry[]`                |
| `renderPlainSql(request)`                                              | Pure model → plain SQL text (never touches the network)           |
| `exportTableDataAsInserts(request)`                                    | Stream one table's rows as batched `INSERT` statements            |
| `preflightRestore(request)`                                            | Target version, limits, and what this dump needs that it lacks    |
| `isMysqlDump(sample)`                                                  | Recognizes native _and_ this package's dumps                      |
| `parseSqlStatements(sql)` / `streamSqlStatements(source)`              | The MySQL statement lexer, usable on its own                      |
| `beginMysqlDumpSession(connection, options?)`                          | Consistency mode + session pinning, on its own                    |
| `checkTargetCompatibility(database, target)`                           | Which features a target cannot accept                             |
| `fromMysql2Connection(connection)`                                     | Adapter (from `dbgate-mysql-dumper/mysql2`)                       |
| `fromMysql2Pool(pool)`                                                 | Adapter (from `dbgate-mysql-dumper/mysql2`)                       |
| `connectMysql2(config)`                                                | Convenience creator (from `dbgate-mysql-dumper/mysql2`)           |

Each stage is independently usable: `inspectDumpArchive` and `renderPlainSql` are
pure functions of the model and need no connection at all.

## Why a real lexer, not `split(';')`

Splitting a MySQL script on semicolons breaks on the _first_ stored program in
any dump:

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

This package ships an incremental lexer that understands quoted strings and
backtick identifiers (with MySQL's _actual_ escaping rules — no backslash escapes
inside identifiers), all three comment forms, `DELIMITER` with any delimiter
string, and statements split across arbitrary stream chunks.

Two MySQL specifics it gets right:

- **Executable comments are SQL, not comments.**
  `/*!40000 ALTER TABLE t DISABLE KEYS */` carries real, version-gated SQL and is
  sent to the server, which evaluates the condition itself. Stripping it would
  drop the session setup and every view and stored-program definition.
- **`DELIMITER` is a client command.** It is consumed by the parser and never
  sent to a server that would reject it.

Boundary correctness is not assumed: the parser's output is asserted identical at
**every** chunk size and **every** single split point, over both synthetic scripts
and eight real `mysqldump` files.

## Documentation

| Document                                                     | Contents                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [docs/native-compatibility.md](docs/native-compatibility.md) | The two-way promise, what is reproduced and why, deliberate deviations |
| [docs/dump-api.md](docs/dump-api.md)                         | `dumpMysql` options, modes, consistency, progress, batching            |
| [docs/restore-api.md](docs/restore-api.md)                   | `restoreSqlDump`, the lexer, `DELIMITER`, typed errors, preflight      |
| [docs/mysql2-adapter.md](docs/mysql2-adapter.md)             | Connection ownership, raw values, backpressure, pools                  |
| [docs/supported-objects.md](docs/supported-objects.md)       | Object matrix: dumped / restored / round-trip tested                   |
| [docs/supported-data-types.md](docs/supported-data-types.md) | Per-type fidelity, escaping, `NO_BACKSLASH_ESCAPES`                    |
| [docs/known-limitations.md](docs/known-limitations.md)       | What this package does not do, and why                                 |
| [docs/round-trip-testing.md](docs/round-trip-testing.md)     | Running the Docker-backed matrix; the fixture                          |
| [docs/architecture.md](docs/architecture.md)                 | Layer-by-layer design and the reasoning behind it                      |

## Fidelity highlights

- **`BIGINT` and `DECIMAL` are exact.** Values arrive as the bytes MySQL sent, so
  `9223372036854775807`, `18446744073709551615` and `DECIMAL(30,10)` at full
  precision never pass through a JavaScript number.
- **Zero dates and out-of-range `TIME` survive.** `'0000-00-00'` and
  `'-838:59:59'` cannot be represented as a `Date`; because the value never
  becomes one, they pass through verbatim.
- **`JSON` keeps its key order and spacing**, because it is never reparsed.
- **`AUTO_INCREMENT` is preserved exactly**, including values past 2^53 and on
  empty tables.
- **Binary data is safe.** `hexBlob` defaults to `true` (a documented deviation
  from `mysqldump`, recommended by MySQL's own docs); with it off, raw bytes are
  written as `Buffer`s and never routed through a JavaScript string.
- **Circular foreign keys work**, because the dump's `FOREIGN_KEY_CHECKS=0` guard
  makes any table order restorable.
- **Sessions are not leaked.** Every variable the dump changes is restored, and a
  restore that stops early still puts back the guards the dump turned off — so a
  pooled connection never goes back with foreign-key checking silently disabled.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test                          # 350 unit tests, no Docker or network needed

npm run docker:up                 # MySQL 5.7 + 8.0 + 8.4
npm run test:integration          # 129 tests: interop matrix, behaviour, hardening, streaming
npm run docker:down

npm run test:package              # builds, then smoke-tests dist/ as ESM and CJS
```

Integration tests skip themselves with a clear message when no server is
reachable; set `MYSQL_TEST_REQUIRED=1` (as CI does) to make that a hard error.
`MYSQL_TEST_TARGETS=mysql80` runs one version while iterating.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
