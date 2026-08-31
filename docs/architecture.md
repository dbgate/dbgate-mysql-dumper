# Architecture

The package is a stack of layers, each usable on its own. Nothing above the
`connection` layer knows what driver is in use; nothing below the `api` layer
knows about a dump as a whole.

```
                     ┌──────────────────────────────────────────┐
  api/               │ dumpMysql()  ·  restoreSqlDump()         │  orchestration
                     └──────────────────────────────────────────┘
                            │              │            │
  introspection/  ──────────┘              │            └────── restore/
    catalog queries → model                │                     lexer → statements
                                           │
  archive/  ─────── plan: what & in what order
  renderer/  ────── model + plan → plain SQL text        preflight/  compatibility/
  data/  ────────── rows → INSERT statements             selection/  security/
  writer/  ──────── text/bytes → Writable                version/    model/
                            │
                     ┌──────────────────────────────────────────┐
  connection/        │ MysqlConnection (driver-agnostic)        │
                     └──────────────────────────────────────────┘
                            │
  mysql2.ts  ─────── the only module that knows mysql2 exists
```

This mirrors `dbgate-pg-dumper` and `dbgate-mssql-dumper`; the MySQL-specific
differences are called out below.

## `connection/` — the driver boundary

`MysqlConnection` is the whole contract between this package and a driver:
`query()`, `stream()`, an optional `execute()`, an optional `describeError()`,
and `cancel()`. The core never imports a driver, and
`tests/packageBoundaries.test.ts` fails if it starts to.

### Why values arrive as raw bytes

`MysqlValueMode` has two modes, and the choice is the single most important
fidelity decision in the package.

`'raw'` delivers **the exact bytes MySQL sent**, as a `Buffer`. No parsing, no
`Number`, no `Date`. That is what makes these survive:

| Value                        | What a driver-native read does               |
| ---------------------------- | -------------------------------------------- |
| `BIGINT` 9223372036854775807 | rounds through IEEE-754                      |
| `DECIMAL(30,10)`             | loses digits, or loses trailing zeros        |
| `'0000-00-00'`               | cannot be represented as a `Date`            |
| `TIME '-838:59:59'`          | outside `Date`'s range entirely              |
| `DOUBLE`                     | reformatted, no longer the server's own text |
| `JSON`                       | reparsed: key order and spacing lost         |

Returning `Buffer` for _everything_ rather than `string` for text and `Buffer`
for binary is deliberate. The wire protocol reports the distinction only through
a column's collation id (`63` = `binary`), and `mysql2` does not expose that to
its per-value `typeCast` hook — `TEXT` and `BLOB` share a protocol type, as do
`VARCHAR` and `VARBINARY`. The serializer decides, because it has the
introspected column type and is the one place the answer is reliably known.

Text columns are still _encoded_, in whatever `character_set_results` the session
has — which the dump session pins to `utf8mb4`. So `buffer.toString('utf8')` is
correct for every non-binary column regardless of that column's own charset, and
binary columns are exempt from the server's conversion. One decode rule covers a
`latin1` column and a `utf8mb4` one alike.

`'native'` is used for catalog queries only, where the values are known safe.

### Why one physical session

A dump runs entirely on **one** connection, and that is not an implementation
detail. The consistent snapshot, the pinned `time_zone`/`sql_mode`/charset, and
(in `lock-all-tables` mode) the read lock are all _session_ state. A pool handing
out an arbitrary connection per query would read each table under different
conditions.

`fromMysql2Pool` therefore returns a `MysqlConnectionSource`, not a connection:
it checks out one physical connection for the whole operation and releases it —
never destroys it — at the end. A bare `MysqlConnection` is borrowed and never
closed.

`session.ts` owns that state and restores every variable it changed, including on
the cancellation path, where it deliberately runs _without_ the caller's
`AbortSignal` — reusing an already-aborted signal would make the cleanup throw
before restoring anything, leaking a rewritten `sql_mode` onto a connection the
caller may hand straight back to a pool.

## `introspection/` — catalog to model

One module per catalog area under `catalog/`, plus an assembler. Everything runs
in sequence on the one connection it is handed; the MySQL protocol cannot
interleave two commands anyway.

### Why the DDL comes from `SHOW CREATE`

The model carries a `createSql` field holding verbatim `SHOW CREATE ...` text,
and the renderer emits that rather than reconstructing DDL from the column model.

MySQL's `CREATE TABLE` grammar carries partitioning clauses, functional and
prefixed key parts, spatial `SRID`, per-column charsets and collations,
expression defaults, `COMPRESSION`/`ENCRYPTION`, tablespace placement, and
engine-specific options. Reproducing all of that faithfully is a losing race
against a server that already renders it exactly right.

The normalized model still exists and is not decoration — it drives archive
planning, data export column selection, compatibility checks and diagnostics.
It just is not the source of the DDL text. That separation is why
`renderPlainSql` remains a pure function of the model with no connection.

`includeCreateSql: false` skips the one-round-trip-per-object cost for callers
that only want the model.

## `archive/` — the plan

`inspectDumpArchive` turns a model into an ordered set of `ArchiveEntry` objects.
It is pure: no SQL text, no streams, no connection.

The order is **`mysqldump`'s**, not a topological sort — see
[native-compatibility.md](native-compatibility.md) for the exact sequence.
Dependencies are still recorded, and then _verified_ against that fixed order, so
a model or planning bug surfaces as `valid: false` rather than as an
unrestorable dump. Reordering would be the wrong repair: the emission order is
dictated by native compatibility, and silently changing it would hide the cause.

Two dependency strengths matter:

- **`hard`** — the restore fails or is wrong if violated. A `trigger` depends on
  its table's `tableData` this way, because a trigger created before the data
  load fires once per inserted row and fabricates side effects the source never
  had.
- **`preference`** — meaningful but harmless to violate, because the dump's own
  session guards cover it. Every foreign key is one of these: `FOREIGN_KEY_CHECKS=0`
  makes any table order restorable, which is exactly what makes **circular
  foreign keys** work. Recording them as hard edges would report a false cycle
  for the schemas that restore perfectly well.

## `renderer/` — model to text

Pure function of model + plan → text, with row data arriving through an
`onTableData` hook so the renderer never needs a connection.

Split into:

- `versionGates.ts` — every executable-comment version, named and explained.
- `sessionGuards.ts` — the header/footer pair.
- `objectRenderers.ts` — one function per `mysqldump` block.
- `definer.ts` / `sqlMode.ts` — the two policy decisions.
- `plainSql.ts` — the orchestrator over archive entries.

`sectionComment(title, trailingBlank)` reproduces a real inconsistency in
`mysqldump`'s own output rather than smoothing it over: per-object banners are
followed by a blank line, the two per-database group banners are not.
Normalizing it would make a structural diff against native output report noise on
every dump.

## `data/` — rows to `INSERT`

`exportTableDataAsInserts` streams one table in constant memory: rows come from a
backpressured `connection.stream()`, and a statement is flushed as soon as it
reaches its size cap.

`SqlChunkBuilder` exists because a dump is not necessarily valid UTF-8. With
`hexBlob: false`, a `BLOB` becomes `_binary '<raw bytes>'`, and joining that
through a JavaScript string would replace every invalid sequence with U+FFFD.
The builder keeps `(string | Buffer)[]` parts and only falls back to
`Buffer.concat` once it has actually been handed bytes — so the all-text case,
which the default `hexBlob: true` always produces, stays on the string fast path.

The byte cap closes a statement _before_ appending the row that would exceed it,
so it is a true upper bound rather than a limit each statement may overshoot by
one row. It is additionally clamped against the server's `max_allowed_packet`,
because a statement above that is rejected at restore time no matter how it was
produced. A single row larger than the cap is still emitted, alone — splitting
one row is not possible.

## `restore/` — text to statements

The most important part of the package, and the one where a shortcut would
corrupt data.

### The lexer

`SqlStatementParser` is an incremental lexer over **bytes**, not characters. Two
reasons:

1. A dump is not necessarily valid UTF-8, and decoding up front would replace
   raw `BLOB` bytes with U+FFFD before the parser ever saw them.
2. `latin1` is a bijection between bytes and code points, so nothing is lost and
   `Buffer.from(text, 'latin1')` reconstructs the exact bytes when a statement is
   emitted.

Scanning bytes is safe for multi-byte text: every character the lexer reacts to
is ASCII, and no UTF-8 continuation byte (≥ 0x80) can be mistaken for one. It
also removes the need for a `StringDecoder` — a `latin1` decode can never split a
character across chunks — and makes `maxStatementBytes` exact rather than an
estimate.

It understands single- and double-quoted strings (with backslash escapes and
doubled quotes), backtick identifiers (doubled backticks only — MySQL has **no**
backslash escape inside a quoted identifier), `--` line comments (only when
followed by whitespace, so `5--3` stays arithmetic), `#` comments, `/* */` block
comments (**not** nested, unlike SQL Server), executable comments, optimizer
hints, and `DELIMITER`.

Correctness across chunk boundaries is not assumed. A trailing run of characters
whose meaning depends on what comes next — a partial delimiter, a lone `-` that
might begin `--`, a `/` that might begin `/*` — is carried to the next chunk
rather than appended. `tests/statementParser.test.ts` verifies the output is
identical at **every** chunk size and **every** single split point, and
`tests/nativeFixtures.test.ts` does the same over real `mysqldump` files.

### Why `sql_mode` is tracked

`backslashEscapes: 'auto'` (the default) starts with escapes enabled — MySQL's
own default, and what every `mysqldump` output relies on — then watches completed
statements for a `SET ... sql_mode` that adds or removes `NO_BACKSLASH_ESCAPES`,
following the script the way the server would. A dump's own header is such a
statement and _clears_ the flag, so the common case needs no thought from the
caller.

### Session cleanup

A dump changes integrity checks, SQL mode, time zone, SQL notes and the three
charset variables affected by `SET NAMES` in its header, then restores them in
its footer. A restore that stops at a failing statement, or is cancelled, never
reaches that footer. `RestoreSessionState` tracks only top-level `SET`
statements (not matching text inside rows or routine bodies), puts unfinished
guards back, and reports a `session-state-restored` warning so the intervention
is never invisible.

## `writer/` — text and bytes out

`DumpWriter.write` accepts `string | Buffer` for the reason above. `StreamDumpWriter`
honours backpressure by gating on `write()`'s return value with the `drain`
listener attached in the same tick — subscribing after awaiting the completion
callback would wait for an event that has already fired — and never calls `end()`
on a caller-owned stream.

## `security/` — quoting and escaping

`quoteIdentifier` always uses backticks, with no "quote only when needed" mode.
MySQL's reserved-word list changes between releases: a name safe unquoted on 5.7
can become reserved on 8.0 (`RANK`, `ROW`, `GROUPS`), and a dump that omitted the
quotes would then fail to restore on a newer server. Two bytes removes the whole
class of problem.

`escapeMysqlString` reproduces `mysql_real_escape_string_quote` exactly — the
same seven code points, and notably **not** tab, which `mysqldump` also leaves
alone. See the module doc for why that set and no other.

## `mysql2.ts` — the adapter

The only module that knows `mysql2` exists, reachable only through the separate
`dbgate-mysql-dumper/mysql2` entry point. The value import is dynamic, so the
module loads and type-checks without the optional peer dependency installed.

See [mysql2-adapter.md](mysql2-adapter.md).

## Testing strategy

| Suite                     | Needs Docker | What it proves                                              |
| ------------------------- | ------------ | ----------------------------------------------------------- |
| `tests/` (320 tests)      | no           | Every pure layer, plus real `mysqldump` fixtures.           |
| `integration/` (69 tests) | yes          | The four-way interop matrix on 5.7/8.0/8.4, plus behaviour. |

`npm test` must stay fast and dependency-free, so the Docker-backed suite is a
separate Vitest project. Integration suites skip themselves with a clear message
when no server is reachable; `MYSQL_TEST_REQUIRED=1` turns that into a hard
error so they can never silently no-op in CI.

The fixture databases are built with `execStatements`, which sends one
already-delimited statement per array element and **never touches this package's
own parser** — otherwise a statement-splitting bug could corrupt the fixture and
mask itself.
