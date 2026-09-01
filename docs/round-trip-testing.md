# Round-trip testing

Two suites, split so that `npm test` stays fast and dependency-free while the
interoperability claims are still proven against real servers.

| Suite          | Docker | Tests | Command                    |
| -------------- | :----: | ----: | -------------------------- |
| `tests/`       |   no   |   360 | `npm test`                 |
| `integration/` |  yes   |   141 | `npm run test:integration` |

```sh
npm test                          # unit: fast, no Docker, no network

npm run docker:up                 # MySQL 5.7/8.0/8.4 + MariaDB 10.6/10.11/11.4
npm run test:integration
npm run docker:down               # stop and remove volumes

npm run test:all                  # both
npm run test:integration:docker   # docker:up, then integration
```

## The interoperability matrix

`integration/interop.integration.test.ts` runs four paths per server version,
using the native MySQL or MariaDB tools appropriate to that target:

| Test | Dump produced by   | Restored by    | Proves                               |
| ---- | ------------------ | -------------- | ------------------------------------ |
| A    | this package       | native `mysql` | our dumps are native-restorable      |
| B    | native `mysqldump` | this package   | we can restore native dumps          |
| C    | this package       | this package   | our own round trip is lossless       |
| D    | native `mysqldump` | native `mysql` | baseline: the fixture itself is sane |

Plus two variants: **A with `hexBlob: false`** (raw `_binary` bytes, which also
proves the writer never routes a dump through a string) and **C with
`extendedInsert: false, completeInsert: true`**.

Six paths × six versions = 36 interop tests, and every one of them ends the
same way:

```
restore → introspectMysql(target)
        → normalizeDatabase(...)  deep-equal against the source model
        → compareTableData(...)   every table, every row, hex-encoded
```

A path that "restored without error" but lost a value fails. Comparing hex rather
than decoded text is deliberate: it catches a single flipped byte in a `BLOB`, a
lost trailing space in a `CHAR`, and a `DECIMAL` that came back with a different
number of trailing zeros — all of which a text comparison through a lossy decode
would hide.

## The fixture

[`integration/fixture/`](../integration/fixture/) builds one database containing,
by design rather than by accident:

- Seven InnoDB tables plus one **MyISAM** table (to exercise the
  nontransactional-snapshot warning).
- **Circular foreign keys** — `authors` ⇄ `books` — plus a composite FK.
- Unique, composite, prefixed and (on 8.0+) **descending** indexes.
- **Generated columns**, both `STORED` and `VIRTUAL`.
- `AUTO_INCREMENT` with a **gap**, an **empty table** with a non-default counter
  (`4242`), and one **past 2^53** (`9007199254740995`).
- Mixed charsets: `latin1` and `ascii` columns inside a `utf8mb4` table.
- utf8mb4 text including **emoji** and astral characters, empty strings, `NULL`s,
  and every escape-worthy control character.
- `BIGINT` at **both** bounds, `BIGINT UNSIGNED` at its maximum,
  `DECIMAL(30,10)` at full precision, `DOUBLE` at the IEEE-754 maximum.
- **BLOB data containing NUL and `0xFF`**, plus a `BINARY(4)` of all zeros.
- `JSON` with nested structures, escaped quotes and backslashes.
- `ENUM`, `SET` (including the empty set), `BIT(11)`.
- `DATE`/`DATETIME(6)`/`TIMESTAMP`/`TIME(3)`/`YEAR` at their bounds, including
  `±838:59:59` and `9999-12-31 23:59:59.999999`.
- A view, and a **dependent view that sorts alphabetically before its
  dependency** (`a_dependent_view` reads from `v_books`) — so the stub-view
  mechanism is what makes the restore work, not alphabetical luck.
- Two **triggers with multi-statement bodies**, one containing an `IF`.
- A **stored procedure whose body contains semicolons**, inside a string, and a
  `--` sequence inside a string literal.
- A stored function, and a **scheduled event** with a multi-statement body.
- A table with **no primary key** (unordered-read path).

The stored programs are what force `DELIMITER` parsing: their bodies contain
`;`-terminated statements, so a dump of this fixture cannot be restored by
anything that splits on semicolons.

Version-dependent features are gated on **introspected capabilities**, not on a
version number, so the same fixture builds on 5.7, 8.0 and 8.4 while still
exercising everything each server actually supports.

### Why the fixture bypasses this package's parser

`execStatements` sends one already-delimited statement per array element and
never touches `SqlStatementParser`. If the fixture were built with the code under
test, a statement-splitting bug could corrupt the fixture and then mask itself.

Data is loaded **before** the triggers exist, for the same reason `mysqldump`
emits triggers after a table's data: a trigger firing during the load would
fabricate audit rows the assertions do not expect.

## Behaviour suite

`integration/behaviour.integration.test.ts` covers what needs a live server but
is not part of the matrix — 17 tests per version:

- **Dump modes**: `schema-only` (no rows, no data frame), `data-only` (no
  definitions), selection filters, `dataExcludedTables`.
- **`AUTO_INCREMENT`**: the next generated id after restore, a counter past 2^53,
  an empty table's counter.
- **Session hygiene**: the dump connection's `sql_mode`, `time_zone` and charset
  are unchanged afterwards; `FOREIGN_KEY_CHECKS` is back on after a restore that
  fails midway.
- **Diagnostics**: the MyISAM snapshot warning names the right table; the
  no-primary-key, generated-column and definer diagnostics all appear.
- **Preflight**: version, `max_allowed_packet` and `sql_mode` reported.
- **Progress and cancellation**: every phase observed; a mid-dump abort leaves the
  connection usable.
- **Why a real lexer is required**: demonstrates that a naive `split(';')` tears
  the fixture's procedure body apart, then restores the same dump through the
  native `mysql` client to prove the real parser is not the only thing that
  handles it correctly.

## Hardening suite

`integration/hardening.integration.test.ts` holds the cases a production
review turned up — each one either found broken and fixed, or an assumption the
rest of the suite happened not to exercise. 16 tests per version:

- **`CREATE DATABASE`** dumps accepted by native `mysql` with no target
  database selected, including the `DEFAULT ENCRYPTION` value mapping.
- **Session cleanup**: a held `LOCK TABLES` released after a restore fails or
  is cancelled; session variables unchanged after a failed restore.
- **Hostile stored programs**: nested `BEGIN`/`END`, `LOOP`, `WHILE`,
  `REPEAT`, `CASE`, labels, plus strings _and_ comments containing `;;`, `$$`
  and `//`. Run both directions, and the restored bodies are actually
  **executed** to prove they work.
- **Native option variants**: `--compact`, `--skip-comments`, `--skip-opt`,
  `--skip-extended-insert`, `--complete-insert` dumps all restored by us.
- **Legacy `latin1` dumps** from `mysqldump --default-character-set=latin1`,
  compared byte-exactly.
- **Poisoned source session**: dumping from a connection carrying
  `ANSI_QUOTES,NO_BACKSLASH_ESCAPES`, and confirming the caller's `sql_mode` is
  handed back untouched.
- **View dependency chains** where alphabetical order is the worst possible
  one, comparing view column _types_ as well as data.
- **Hostile identifiers**: names containing a backtick, a space, a reserved
  word and non-ASCII text.
- **Schema edge cases**: `ON UPDATE CURRENT_TIMESTAMP`, `WITH CASCADED CHECK
OPTION`, `CHAR` padding and trailing spaces.

## Streaming and memory

`integration/streaming.integration.test.ts` builds a 65,536-row table of wide
rows (~14 MB of dump) and asserts, per version:

- The dump streams: no single chunk exceeds the configured statement cap, many
  statements are produced rather than one, and heap growth stays well below the
  dump size.
- Every generated `INSERT` is within the cap, checked by re-parsing the dump.
- The restore streams: `bytesConsumed` matches, row counts match, and heap
  growth stays bounded while the dump is fed in 64 KB pieces.
- **Cancellation interrupts promptly** — under a second in practice — and the
  source data is intact afterwards.

That last one is a regression test for a real deadlock: abandoning a stream
whose result set was still arriving left `mysql2`'s row listener attached, which
re-paused the connection with nobody to resume it, and every later statement
waited forever.

## Docker-free native regression tests

`tests/nativeFixtures.test.ts` runs against eight **genuine `mysqldump` files**
checked into `tests/fixtures/native/` — produced by the real binaries in the
MySQL 8.0 and 8.4 images over
[`scripts/reference-fixture.sql`](../scripts/reference-fixture.sql), with only the
producer, host and timestamp lines edited.

That makes the parser's behaviour against real native output part of every
`npm test`, with no Docker, no network and no MySQL installed. It asserts:

- Every fixture is recognized by `isMysqlDump` and parses without error.
- No `DELIMITER` ever surfaces as something to execute.
- **Every fixture parses identically at chunk sizes 1, 7, 64, 997 and 65536.**
- Session guards survive as executable comments rather than being stripped.
- A multi-statement trigger, procedure and event body each stay in one statement.
- A stub view is emitted before its final definition.
- An extended `INSERT` stays whole, semicolons in values included.
- Each option variant has the expected shape (`--databases`, `--no-data`,
  `--no-create-info`, `--skip-extended-insert`, and a minimal dump).
- The 8.0 and 8.4 dumps have the **same statement sequence**, which is the dump
  format this package reproduces.

Regenerating them is documented in
[native-compatibility.md](native-compatibility.md#regenerating-the-reference-dumps).

## Parser boundary tests

`tests/statementParser.test.ts` verifies statement boundaries are found
identically at **every** chunk size _and_ **every** single split point over a
script containing strings with embedded delimiters, backslash escapes,
doubled quotes, backtick identifiers, comments of all three kinds, executable
comments, a `DELIMITER ;;` region and multi-byte text.

There is a separate test that a chunk boundary falling **inside a multi-byte
character** still decodes correctly — the reason the lexer works on bytes rather
than characters.

## Architectural boundary tests

`tests/packageBoundaries.test.ts` enforces, as tests rather than as review
comments, the promises the README makes:

- No `child_process` import, `spawn` or `execFile` anywhere in `src/`.
- No attempt to run `mysqldump` or `mysql`.
- No `mysql2` import in any core module; the adapter reaches it dynamically.
- No `.split(';')` anywhere in `src/`.
- No raw NUL byte in any source file. _(This one already caught a real defect.)_
- Every relative import carries a `.js` extension, as NodeNext requires.
- Every documented public export is actually exported.

## Configuration

| Variable              | Default                | Meaning                                         |
| --------------------- | ---------------------- | ----------------------------------------------- |
| `MYSQL_TEST_HOST`     | `127.0.0.1`            |                                                 |
| `MYSQL_TEST_USER`     | `root`                 |                                                 |
| `MYSQL_TEST_PASSWORD` | `Str0ng!Passw0rd#2024` | Matches `docker-compose.yml`.                   |
| `MYSQL_TEST_TARGETS`  | all three              | Comma-separated ids: `mysql57,mysql80,mysql84`. |
| `MYSQL_TEST_REQUIRED` | unset                  | `1` turns "unreachable" into a hard error.      |
| `MYSQL_TEST_WAIT_MS`  | `60000`                | How long to retry the initial connection.       |

Ports are `33057`, `33080` and `33084` — deliberately non-default so they never
collide with a local MySQL or another project's container on `3306`.

Suites **skip themselves with a clear message** when no server is reachable, so
`npm run test:integration` is runnable on a machine without Docker. Set
`MYSQL_TEST_REQUIRED=1` in CI so they can never silently no-op where they were
meant to run.

Run one version while iterating:

```sh
MYSQL_TEST_TARGETS=mysql80 npm run test:integration
```

## Artifacts

Dumps produced during the run are written to `test-output/interop/` — the
`dbgate` dump, the native dump, and the raw-binary variant, per version. They are
gitignored, and are the first thing to look at when a matrix test fails.
