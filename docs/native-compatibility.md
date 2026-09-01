# Native compatibility

This package produces and consumes **ordinary plain-SQL MySQL and MariaDB dumps**. There is
no custom format, no archive wrapper, and no metadata sidecar: a `.sql` file it
writes is the same kind of file `mysqldump` writes, and restores the same way.

```sh
mysql mydatabase < dump.sql
```

## The two-way promise

| Direction                                      | Status | Proven by                                         |
| ---------------------------------------------- | ------ | ------------------------------------------------- |
| `dumpMysql` → native `mysql` client restore    | ✅     | `integration/interop.integration.test.ts`, test A |
| native `mysqldump` → `restoreSqlDump`          | ✅     | `integration/interop.integration.test.ts`, test B |
| `dumpMysql` → `restoreSqlDump`                 | ✅     | `integration/interop.integration.test.ts`, test C |
| native `mysqldump` → native `mysql` (baseline) | ✅     | `integration/interop.integration.test.ts`, test D |

Every path is run against **MySQL 5.7, 8.0, 8.4 and MariaDB 10.6, 10.11, 11.4**
over the same fixture, and
every path ends by introspecting the restored database and deep-comparing both
its schema model and every table's rows — byte for byte, hex-encoded — against
the source. A path that "restored without error" but lost a value fails.

`mysqldump` and the `mysql` client are used **only by those tests**, inside the
server's own Docker container. Nothing under `src/` ever spawns a process;
`tests/packageBoundaries.test.ts` fails if that stops being true.

On MariaDB the native tools in this table are `mariadb-dump` and `mariadb`.
MariaDB executable `/*M! ... */` comments are restored as SQL; its leading
client-only sandbox directive is consumed by the streaming lexer. Same-flavor
round trips are guaranteed. Cross-flavor restores are best effort because DDL,
collations and feature syntax diverge.

## How close is the output?

Very. On MySQL 8.0 and 8.4, `dumpMysql` output is **byte-identical** to
`mysqldump --routines --events --triggers --hex-blob` except for three lines
that cannot be identical (on 5.7, add the four
[deliberate divergences](#deliberate-divergences-on-mysql-57) below):

```diff
--- mysqldump 8.0.44
+++ dbgate-mysql-dumper
-- MySQL dump 10.13  Distrib 8.0.44, for Linux (x86_64)
+-- MySQL dump 10.13  Distrib dbgate-mysql-dumper, for Node.js (linux)
 --
--- Host: 127.0.0.1    Database: refdb
+-- Host: localhost    Database: refdb
 -- ------------------------------------------------------
--- Dump completed on 2026-08-28 11:06:06
+-- Dump completed on 2026-08-28 13:47:02
```

- The `Distrib` field names the producer. This package says so honestly rather
  than impersonating a `mysqldump` version it is not.
- `Host` is cosmetic; the core is connection-agnostic and never sees a host
  name, so `render.hostLabel` supplies it (default `localhost`).
- The timestamp differs per run. Set `render.includeTimestamp: false` for
  byte-reproducible output.

### Deliberate divergences on MySQL 5.7

5.7's `mysqldump` hardcodes four spellings that its 8.0 successor corrected.
This package emits the corrected form on every version, so a dump taken from
5.7 differs from 5.7's own `mysqldump` in exactly these four lines — and in no
others:

| 5.7 `mysqldump`                                           | This package                                      | Why ours                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/*!40101 SET NAMES utf8mb4 */;`                          | `/*!50503 SET NAMES utf8mb4 */;`                  | `utf8mb4` appeared in 5.5.3. Gated at 4.1.1, the statement is a syntax error on a 5.0 server that dutifully runs it.                                                                                                         |
| `/*!40101 SET character_set_client = utf8 */;`            | `/*!50503 SET character_set_client = utf8mb4 */;` | 5.7 writes the literal `utf8` even in a utf8mb4 dump — its own stored-program blocks say `utf8mb4` in the same file. Any 4-byte character in a column `DEFAULT`, `ENUM` value or `COMMENT` is then parsed as mb3 on restore. |
| `SET character_set_client = utf8;` (view stub, unguarded) | `/*!50503 SET character_set_client = utf8mb4 */;` | Same charset defect, plus the unguarded form fails on a pre-4.1 server instead of being skipped.                                                                                                                             |
| `-- Temporary table structure for view`                   | `-- Temporary view structure for view`            | Reworded in 8.0; a comment either way.                                                                                                                                                                                       |

All four are accepted by every server 5.7's version is, so this only ever
widens what the dump restores onto. The parity test whitelists these four exact
lines and nothing else, so any further divergence fails it.

This is not a claim verified once by hand: `integration/hardening.integration.test.ts`
dumps a database covering tables, indexes, a view, a procedure, a function, a
trigger, JSON/ENUM/SET/BLOB/DECIMAL columns and quoted comments, then compares
the result against native `mysqldump` line for line, allowing only those three
lines to differ.

`-- MySQL dump 10.13` **is** emitted: `10.13` is the _dump format_ revision, not
a product version, and this package produces that format. It is also what
tooling — including this package's own `isMysqlDump()` — sniffs for.

## What is reproduced, and why

### Section ordering

`mysqldump` iterates `SHOW TABLES`, which lists tables **and views together in
name order**, and this package reproduces that interleaving exactly:

```
-- Temporary view structure for view `aview`     <- a view can come first
-- Table structure for table `mt`
-- Dumping data for table `mt`
   (this table's triggers, immediately after its data)
-- Temporary view structure for view `nview`
-- Table structure for table `zt`
-- Dumping data for table `zt`
-- Dumping events for database '...'
-- Dumping routines for database '...'           <- functions, then procedures
-- Final view structure for view `aview`
-- Final view structure for view `nview`
```

Verified against a live server (a view named `aview` really does get its stub
emitted before a table named `mt`) and asserted in `tests/archive.test.ts`.

### Stub views

Before any real view definition exists, `mysqldump` creates each view as a dummy
`CREATE VIEW v AS SELECT 1 AS col, ...` with the correct column names. By the
time the real definitions run, every referenced view already exists with the
right shape — so views can be created in plain name order **even when one
depends on another that sorts after it**.

This package emits the same stubs, for the same reason. It is what makes a
correct dump possible without a topological sort of views, and the fixture
deliberately contains `a_dependent_view` (which reads from `v_books`) to prove
the mechanism rather than rely on alphabetical luck.

### Executable comments

`/*!40101 SET ... */` is **not** a comment. MySQL executes the enclosed SQL when
the server version is at least the five-digit number, and skips it otherwise.
Both halves of this package treat them as SQL:

- The renderer emits them with the same gates `mysqldump` uses, each named and
  explained in [`src/renderer/versionGates.ts`](../src/renderer/versionGates.ts).
  The gate is the version that introduced the guarded feature — **not** the
  version of the server being dumped. A dump from 8.4 still writes
  `/*!40101 SET @OLD_SQL_MODE=...` because the claim is "any server from 4.1.1
  onwards can run this".
- The restore lexer scans their contents as ordinary statement text, exactly as
  the `mysql` client does. Consequently a delimiter _inside_ one really does end
  the statement — which is precisely why `mysqldump` wraps stored programs in a
  `DELIMITER ;;` region.

### Empty section banners

`mysqldump` prints

```
--
-- Dumping events for database 'x'
--
```

whenever `--events` was given — **even when the database has none** — and the
same for `--routines`. Without the switch, neither banner appears at all. So
the banner follows the caller's intent, not the presence of objects, and this
package reproduces that: the banners are emitted because
`objectKinds.includeEvents`/`includeRoutines` are on (both default to `true`),
independent of whether anything is in them. The events section's time-zone
save/restore pair is still tied to an event actually existing, exactly as in
native output.

This is enforced by a test that dumps a database with **no** events or routines
and compares the whole file against native `mysqldump` line for line.

### `CREATE DATABASE` attribute values

`information_schema` and the DDL grammar do not always agree on how a value is
spelled, and the dump has to emit what the _grammar_ accepts.
`SCHEMATA.DEFAULT_ENCRYPTION` reports `'YES'`/`'NO'`, while
`CREATE DATABASE ... DEFAULT ENCRYPTION` accepts only `'Y'`/`'N'` — passing the
catalog value through makes MySQL reject the statement with
`ER_WRONG_VALUE_FOR_VAR` (1525). `mysqldump` emits `'N'`, and so does this
package; an unrecognized value drops the clause rather than emitting an invalid
one, since a database that inherits the server default is recoverable and an
unrestorable dump is not.

### Session guards

The header/footer pair is reproduced in `mysqldump`'s order, and two of them are
load-bearing rather than decorative:

- `SQL_MODE='NO_AUTO_VALUE_ON_ZERO'` **replaces** the restoring session's
  `sql_mode`, which clears `NO_BACKSLASH_ESCAPES` if it was set. Without it,
  every `\'`, `\\`, `\n` and `\Z` in the dump's string literals would be
  reinterpreted and the data would silently corrupt. It also makes an explicit
  `0` in an `AUTO_INCREMENT` column stay `0`.
- `FOREIGN_KEY_CHECKS=0` is what makes any table order restorable, circular
  foreign keys included.

`render.includeSessionGuards: false` is available but produces a
`session-guards-disabled` warning naming both consequences.

### `DELIMITER`

`DELIMITER` is a **client** command, not SQL. The restore parser consumes it,
updates its own state, and never sends it to a server that would reject it. Any
delimiter string works, not just `;;` — `$$`, `||`, and even a bare word like
`GO` are covered by tests.

### Per-object session context

MySQL records the `character_set_client`, `collation_connection` and `sql_mode`
in force when a view, routine, trigger or event was created, and re-establishes
them when it runs. Recreating an object under different settings changes its
behaviour, or stops its body parsing at all if it was written under
`ANSI_QUOTES`. The full save/set/restore dance around every stored program is
reproduced.

## Deliberate deviations

Three, all documented and all defensible.

### 1. `hexBlob` defaults to `true`

`mysqldump --hex-blob` is off by default, which means a binary value is written
as `_binary '<raw bytes>'` and the dump file is **not valid text in any
encoding**. Anything in the path that touches encoding can corrupt it silently.
MySQL's own documentation recommends `--hex-blob` for exactly this reason, so it
is on here.

`hexBlob: false` produces byte-identical `mysqldump`-default output, and is
covered by its own round-trip test — including the writer path that keeps raw
bytes out of any JavaScript string.

### 2. Routines and events are included by default

`mysqldump` includes triggers by default but _omits_ routines and events unless
`--routines`/`--events` are given. A dump that silently drops a database's stored
procedures is a trap, and the sibling PostgreSQL and SQL Server dumpers include
every object kind by default. Set
`objectKinds: { includeRoutines: false, includeEvents: false }` for
`mysqldump`'s exact set.

### 3. Rows are read in primary-key order

`mysqldump --order-by-primary` is off by default. Without an `ORDER BY`, MySQL
may return rows in any order, so two dumps of the same unchanged database can
differ — which makes byte-comparing or hashing a dump meaningless. On InnoDB the
cost is nil: the table _is_ its primary-key index. Turn it off with
`dataExport: { orderByPrimaryKey: false }`.

## Two MySQL behaviours that are not our doing

Both were verified to occur identically for native `mysqldump` → native `mysql`,
and the round-trip comparison normalizes them:

1. **Column charset re-rendering.** A column that inherited its charset from the
   table default comes back with an explicit `CHARACTER SET` once the table has
   been recreated from DDL naming its collation. So a dump → restore → dump cycle
   is _not_ byte-idempotent, for `mysqldump` either.
2. **`NO_AUTO_CREATE_USER` is dropped.** MySQL 5.7's default `sql_mode` contains
   it and MySQL 8.0 removed it, so leaving it in a stored program's recorded mode
   would break every 5.7 → 8.0 restore. `mysqldump` 5.7 strips it; this package
   generalizes that to every mode 8.0 removed. See
   `render.sqlModeCompatibility`, and [`src/renderer/sqlMode.ts`](../src/renderer/sqlMode.ts).

## Restoring a `mysqldump` default (raw binary) dump

A dump taken without `--hex-blob` contains raw `BLOB` bytes, and no JavaScript
driver can send a query as opaque bytes — every one encodes the statement string
using the connection charset. Decoding those bytes as UTF-8 first would replace
each invalid sequence with U+FFFD.

Rather than refusing such dumps, the parser rewrites each offending literal into
the hexadecimal form MySQL treats as identical:

```
INSERT INTO t VALUES (_binary '<raw bytes>')   ->   INSERT INTO t VALUES (0x...)
```

That is the same substitution `--hex-blob` performs at dump time, so the restored
value is byte-identical. Only literals that are _not_ valid UTF-8 are touched,
and `ParsedStatement.binaryLiteralsRewritten` reports how many were. Bytes that
are invalid UTF-8 _outside_ any string literal — which no `mysqldump` output
produces — raise `BinaryLiteralError` rather than being corrupted. See
[`src/restore/binaryLiterals.ts`](../src/restore/binaryLiterals.ts).

## Unsupported `mysqldump` options

Not implemented, and detected rather than ignored where it matters:

| `mysqldump` option                       | Status                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--all-databases`, `--databases <many>`  | Not supported. One database per dump; call `dumpMysql` per database.                                                  |
| `--tab` (`SELECT ... INTO OUTFILE`)      | Not supported. Writes files on the _server_, which a client-side library cannot do.                                   |
| `--source-data` / `--master-data`        | Not supported. See [known-limitations.md](known-limitations.md).                                                      |
| `--set-gtid-purged`                      | Not supported. A dump carrying stale GTID state is dangerous to restore.                                              |
| `--flush-logs`, `--flush-privileges`     | Not supported; both are server-administration side effects, not dump content.                                         |
| `--where`, `--ignore-table`              | Partly: `selection.excludeTables`/`dataExcludedTables` cover `--ignore-table`. Row filtering is not implemented.      |
| `--compact`                              | Compose it: `includeHeaderComments`, `includeFooterComment`, `addDropTable`, `setCharset`, `addLocks`, `disableKeys`. |
| `--lock-tables` (per-database read lock) | Use `consistency: 'lock-all-tables'` (`--lock-all-tables`) or the default snapshot.                                   |
| `--single-transaction`                   | Supported, as `consistency: 'single-transaction'` (the default).                                                      |
| `--no-tablespaces`                       | Effectively always on: tablespaces are never created. See [known-limitations.md](known-limitations.md).               |
| `--xml`                                  | Not supported; this package produces SQL.                                                                             |

A `mysqldump` **script** construct this package cannot execute raises a typed
error rather than being skipped: `source`/`\.`, `system`, `charset`, `connect`
and the other `mysql` client commands all produce
`UnsupportedClientCommandError` naming the directive and its line.

## Regenerating the reference dumps

The files in `tests/fixtures/native/` are genuine `mysqldump` output over
[`scripts/reference-fixture.sql`](../scripts/reference-fixture.sql), with only
the producer, host and timestamp lines edited. They make the parser's behaviour
against real native output part of every `npm test`, with no Docker required.

```sh
npm run docker:up
docker exec dbgate-mysql-dumper-80 sh -c \
  'mysql --default-character-set=utf8mb4 -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" \
   -e "DROP DATABASE IF EXISTS refdb; CREATE DATABASE refdb DEFAULT CHARACTER SET utf8mb4"'
docker exec -i dbgate-mysql-dumper-80 sh -c \
  'mysql --default-character-set=utf8mb4 -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" refdb' \
  < scripts/reference-fixture.sql
docker exec dbgate-mysql-dumper-80 sh -c \
  'mysqldump --default-character-set=utf8mb4 -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" \
   --routines --events --triggers --hex-blob refdb' > /tmp/native.sql
```

Then sanitize the three variable lines before checking the file in.
