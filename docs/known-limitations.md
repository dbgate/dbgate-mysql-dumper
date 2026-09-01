# Known limitations

Everything here is a deliberate boundary, not an oversight. Each entry says what
is missing, why, and what to reach for instead.

Server-wide items are also reported programmatically by
`unsupportedFeatureDiagnostics()`, so a UI can list them without hardcoding this
page.

## Not dumped: server-wide objects

### Users, roles and grants

Accounts live in the server-wide `mysql` system database, not in the dumped
database, and recreating them needs privileges a dump user should not require.

**This interacts with `DEFINER`.** Every view, routine, trigger and event names
an account, and restoring one whose account does not exist on the target fails
with `ER_NO_SUCH_USER`. Use `definerPolicy: 'strip'` or `'current-user'` for a
portable dump — see [restore-api.md](restore-api.md#definerpolicy).

Reach for `mysqldump --all-databases` (or `mysqlpump --users`) if you need the
accounts themselves.

### Replication coordinates and GTID state

`mysqldump --source-data`/`--master-data` records the binary log file and
position, and `--set-gtid-purged` records GTID state, so a dump can seed a
replica.

Neither is emitted. Both require `RELOAD`/`REPLICATION CLIENT` and a locking
strategy chosen for replication rather than for a consistent read — and a dump
carrying a stale `SET @@GLOBAL.gtid_purged` is _actively dangerous_ to restore
onto a server with its own history. If you are seeding a replica, use
`mysqldump` for that step.

### Tablespaces

`CREATE TABLESPACE` is server-wide and its data files are host paths, so the
definition is not portable between servers. A table naming one restores only
where that tablespace already exists; the `TABLESPACE` clause is preserved in the
table DDL, but the tablespace itself is not created.

### NDB Cluster objects

Logfile groups, undo files and cluster-specific attributes are not introspected.
Dumping an NDB table produces its ordinary `CREATE TABLE`, which restores as the
target's default engine unless the target is also NDB.

### Plugins and native UDFs

Server plugins and `CREATE FUNCTION ... SONAME` UDFs are registered server-wide
and depend on shared libraries present on the host. A stored function written in
SQL **is** dumped; a UDF backed by a shared library is not.

### Object privileges

`GRANT SELECT ON db.t TO user` lives in the `mysql` system database alongside the
account it names. Restored objects are owned by, and accessible to, whoever
restores them.

## Consistency

### `singleTransaction` does not cover nontransactional engines

`consistency: 'single-transaction'` gives one InnoDB snapshot for the whole dump.
A MyISAM/MEMORY/CSV/ARCHIVE table is read **outside** it, so concurrent writes to
such a table can appear mid-dump.

This is not glossed over: a
`nontransactional-table-not-snapshot-consistent` warning is reported **per
affected table**, naming the engine. Use `consistency: 'lock-all-tables'`
(`FLUSH TABLES WITH READ LOCK`, requires `RELOAD`) if such a table must be
consistent with the rest — at the cost of blocking all writes server-wide for the
duration.

### DDL breaks snapshot consistency

MySQL does **not** include metadata changes in an InnoDB snapshot. An
`ALTER TABLE` running concurrently with the dump can still produce an
inconsistent result — `ER_TABLE_DEF_CHANGED` in the best case, a table dumped
with a shape that no longer matches its data in the worst. No client-side
strategy can prevent this; `'lock-all-tables'` is the only mode that does.

### `singleTransaction` on **restore** cannot be atomic

MySQL commits implicitly before and after every DDL statement. A dump containing
`CREATE TABLE` — nearly all of them — cannot be rolled back as a unit no matter
what `restoreSqlDump`'s `singleTransaction` is set to. It is meaningful only for
a data-only restore, and always emits a `single-transaction-limited` warning
saying so.

## Not implemented from `mysqldump`

| Option                                          | Why not / what instead                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--all-databases`, multi-database `--databases` | One database per dump. Call `dumpMysql` per database.                                               |
| `--tab` (`INTO OUTFILE`)                        | Writes files on the **server**, which a client-side library cannot do.                              |
| `--where`                                       | Row filtering is not implemented. `dataExcludedTables` covers whole-table exclusion.                |
| `--xml`                                         | This package produces SQL.                                                                          |
| `--flush-logs`, `--flush-privileges`            | Server-administration side effects, not dump content.                                               |
| `--compact`                                     | Compose it from the individual `render` flags; see [dump-api.md](dump-api.md#render--output-shape). |
| `--lock-tables` (per-database)                  | Use `consistency: 'lock-all-tables'` or the default snapshot.                                       |

The full table, including the options that _are_ supported and under what name,
is in [native-compatibility.md](native-compatibility.md#unsupported-mysqldump-options).

## Dump output encoding

The dump is written as UTF-8 bytes, so `render.characterSet` accepts only the
UTF-8 family (`utf8mb4`, `utf8mb3`, `utf8`). Any other value is refused with
`unsupported-dump-charset` rather than producing a file whose `SET NAMES`
contradicts its own contents.

Emitting a genuinely `latin1`-encoded file would mean transcoding the whole
output stream — a real feature rather than a flag — and is not implemented.
Reading is unaffected: the read session is pinned to `utf8mb4` regardless, and
a `latin1` _column_ in the source round-trips exactly, because the server
converts it on the way out.

Restoring a `latin1`-encoded file produced by
`mysqldump --default-character-set=latin1` **is** supported, and covered by an
integration test.

## Restore

### `mysql` client directives

Only `DELIMITER` is implemented — a stored-program dump is unreadable without it.
`source`/`\.`, `system`, `tee`, `notee`, `charset`, `pager`, `nopager`, `prompt`
and `connect` raise `UnsupportedClientCommandError` naming the directive and its
line.

They are **refused rather than ignored** on purpose: a `source` directive that
silently never runs leaves the referenced file's objects missing, which is a
corrupted restore that looks like a successful one.

### Non-UTF-8 bytes outside a string literal

A raw `_binary '…'` literal is handled transparently by rewriting it to
hexadecimal. Bytes that are invalid UTF-8 **outside** any string literal — which
no `mysqldump` output produces — raise `BinaryLiteralError` rather than being
silently replaced with U+FFFD.

### Statement size

One statement is buffered whole, because it must be sent whole. `maxStatementBytes`
(default 256 MiB) bounds that; exceeding it raises `StatementTooLargeError`, whose
message points at the usual causes — a truncated dump, or a `DELIMITER` that was
never restored.

## Cancellation costs the connection

MySQL has no in-band statement cancellation. Stopping a running query means
closing the socket, so a cancelled `dumpMysql` leaves its connection unusable
and every subsequent call on it fails fast with `connection-destroyed`. Open a
new connection to continue; a pooled connection is discarded by the pool as
normal.

A result set that had _already_ finished arriving is exempt: stopping iteration
there keeps the connection usable.

The gentler alternative — `KILL QUERY <id>` from a second connection — is
deliberately not done on the caller's behalf: it would mean opening an
unrequested connection with re-derived credentials, and on a pool it would
consume a slot the caller sized for their own workload. A caller who wants it
can issue it from a connection they already hold.

## Version and flavour

### Tested versions

MySQL **5.7, 8.0 and 8.4** and MariaDB **10.6, 10.11 and 11.4**, all four
interop paths, on every run of `npm run test:integration`.

Capability gating is by `major*10000 + minor*100 + patch`, so a feature
introduced in a _patch_ release is gated there — `CHECK` constraints at 8.0.16,
`INVISIBLE` columns at 8.0.23 — rather than at `8.0`. Adding a newer version
means adding it to `integration/docker-compose.yml` and, if it introduces
features, to `src/version/capabilities.ts`. The renderer does not need to change:
it emits the server's own `SHOW CREATE` text.

### MariaDB support boundaries

MariaDB is detected (`version.flavor === 'mariadb'`) and uses a separate
capability line. JSON remains MariaDB's `LONGTEXT` alias, CHECK constraints do
not query MySQL's `TABLE_CONSTRAINTS.ENFORCED` column, and descending indexes
are gated at MariaDB 10.8. Versions outside 10.6 through 11.x receive an
`untested-server-version` warning.

MariaDB sequences are discovered but not emitted. A
`mariadb-sequence-not-dumped` warning names each sequence; recreate it separately
from `SHOW CREATE SEQUENCE`. Cross-flavor MySQL/MariaDB restores are best effort,
not part of the compatibility guarantee.

MariaDB system-versioned tables are not dumped because exporting only current
rows would silently lose historical versions. Each affected table produces a
`mariadb-system-version-history-not-dumped` warning.

Percona Server is detected but is not in the test matrix, so it receives the
`unverified-server-flavor` warning.

## Behaviours that look like bugs but are MySQL's

Both verified to occur identically for native `mysqldump` → native `mysql`:

1. **A dump → restore → dump cycle is not byte-idempotent.** A column that
   inherited its charset from the table default comes back with an explicit
   `CHARACTER SET` once the table has been recreated from DDL naming its
   collation. Semantically identical; textually different.

2. **`NO_AUTO_CREATE_USER` disappears from a 5.7 stored program's recorded
   `sql_mode`.** MySQL 8.0 removed the mode, so keeping it would break every
   5.7 → 8.0 restore. `mysqldump` 5.7 strips it; this package generalizes that to
   every mode 8.0 removed. Set `render.sqlModeCompatibility: 'preserve'` to keep
   the exact original value when the target is the same major version.

## Not yet implemented

Open, and architected for rather than blocked:

- **Row-level filtering** (`--where`).
- **Multi-database dumps** in one file.
- **Parallel table export.** The single-session requirement makes this a real
  design question (a second connection cannot see the first's snapshot), not a
  small change.
- **`LOAD DATA` output** as a faster alternative to `INSERT`, which needs
  server-side file access or `LOCAL INFILE`.
- **Progress by estimated total.** `TABLES.TABLE_ROWS` is an InnoDB estimate and
  can be off by a wide margin, so no percentage is reported rather than a
  misleading one.
