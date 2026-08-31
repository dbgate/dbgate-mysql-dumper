# Dump API

```ts
dumpMysql(connection, options, output, onProgress?, signal?): Promise<DumpResult>
```

Runs a complete dump — acquire a connection, pin the read session, introspect,
plan, render, stream rows — writing plain SQL in `mysqldump`'s layout to
`output`.

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
  const result = await dumpMysql(connection, { mode: 'full' }, createWriteStream('shop.sql'));
  console.log(`${result.rowsExported} rows in ${result.statementsWritten} statements`);
  for (const warning of result.warnings) {
    console.warn(`[${warning.severity}] ${warning.code}: ${warning.message}`);
  }
} finally {
  await close();
}
```

## `output`

Any `Writable`. Never ended or closed by this package — the caller owns its
lifecycle.

A dump is written incrementally, honouring backpressure, so a multi-gigabyte
database dumps in constant memory. `output` may receive `Buffer` chunks as well
as text: with `hexBlob: false` a `BLOB` value is written as `_binary '<raw
bytes>'`, which cannot be routed through a JavaScript string without corruption.

## `DumpMysqlOptions`

### Top level

| Option         | Default                | Meaning                                                                     |
| -------------- | ---------------------- | --------------------------------------------------------------------------- |
| `mode`         | `'full'`               | `'full'`, `'schema-only'`, `'data-only'`.                                   |
| `databaseName` | connection's current   | Which database to dump. Fails with an actionable error if none is selected. |
| `selection`    | everything             | Per-name object filters; see below.                                         |
| `objectKinds`  | all `true`             | Which kinds participate at all.                                             |
| `render`       | see below              | Output shape.                                                               |
| `dataExport`   | see below              | Row batching and streaming.                                                 |
| `consistency`  | `'single-transaction'` | How a consistent view is obtained.                                          |
| `timeZone`     | `'+00:00'`             | Read session zone, and the zone written into the dump's own guard.          |

### `selection`

Names are exact identifiers, never wildcards. Table and view names are matched
according to the server's own `lower_case_table_names`; routine, trigger and
event names are always case-insensitive, as MySQL treats them.

```ts
selection: {
  tables: ['orders', 'order_lines'],   // omit for all
  excludeTables: ['orders_archive'],   // applied after `tables`
  views: [...], excludeViews: [...],
  routines: [...], excludeRoutines: [...],
  triggers: [...], excludeTriggers: [...],
  events: [...], excludeEvents: [...],

  // Structure dumped, rows skipped — the `--ignore-table` case for a large
  // log or cache table you still want recreated.
  dataExcludedTables: ['request_log'],
}
```

A trigger whose table is not selected is dropped rather than orphaned, and the
reason is reported as a `trigger-table-not-selected` diagnostic.

### `objectKinds`

```ts
objectKinds: {
  includeTables: true,
  includeViews: true,
  includeTriggers: true,
  includeRoutines: true,   // mysqldump needs --routines for these
  includeEvents: true,     // mysqldump needs --events for these
}
```

All five default to `true`. That is deliberately _not_ `mysqldump`'s split — see
[native-compatibility.md](native-compatibility.md#deliberate-deviations).

### `render` — output shape

Each option maps onto a `mysqldump` convention.

| Option                     | Default       | `mysqldump` equivalent                        |
| -------------------------- | ------------- | --------------------------------------------- |
| `addDropTable`             | `true`        | `--add-drop-table` (in `--opt`)               |
| `addLocks`                 | `true`        | `--add-locks` (in `--opt`)                    |
| `disableKeys`              | `true`        | `--disable-keys` (in `--opt`)                 |
| `extendedInsert`           | `true`        | `--extended-insert` (in `--opt`)              |
| `completeInsert`           | `false`       | `--complete-insert`                           |
| `hexBlob`                  | **`true`**    | `--hex-blob` (off natively)                   |
| `setCharset`               | `true`        | `--set-charset`                               |
| `characterSet`             | `'utf8mb4'`   | `--default-character-set` (UTF-8 family only) |
| `includeCreateDatabase`    | `false`       | `--databases`                                 |
| `includeUseDatabase`       | follows above | `--databases`                                 |
| `includeSessionGuards`     | `true`        | (no switch; always on natively)               |
| `includeHeaderComments`    | `true`        | part of `--compact`                           |
| `includeFooterComment`     | `true`        | part of `--compact`                           |
| `includeTimestamp`         | `true`        | `--dump-date`                                 |
| `timeZone`                 | `'+00:00'`    | `--tz-utc`                                    |
| `hostLabel`                | `'localhost'` | the `-h` value in the header                  |
| `definerPolicy`            | `'preserve'`  | (no equivalent)                               |
| `sqlModeCompatibility`     | `'portable'`  | (matches native behaviour)                    |
| `lineEnding`               | `'\n'`        | —                                             |
| `unsupportedFeaturePolicy` | `'error'`     | —                                             |

Notes on the ones that carry weight:

- **`characterSet` accepts only the UTF-8 family** (`utf8mb4`, `utf8mb3`,
  `utf8`). The writer emits UTF-8 bytes, so declaring anything else would
  produce a file whose `SET NAMES` contradicts its own contents — the server
  would then decode every multi-byte character as two single-byte ones. Any
  other value is refused up front with `unsupported-dump-charset`, before the
  connection is touched. The _read_ session is pinned to `utf8mb4`
  independently of this option, which is what makes raw value reads decode
  correctly regardless.

- **`hexBlob`** defaults to `true`, unlike `mysqldump`. See
  [native-compatibility.md](native-compatibility.md#1-hexblob-defaults-to-true).
- **`completeInsert`** is _forced_ whenever a table has generated or invisible
  columns, because a positional `VALUES` list would not line up. `mysqldump`
  behaves identically.
- **`includeSessionGuards: false`** produces a `session-guards-disabled`
  warning. The `SQL_MODE` guard is what clears `NO_BACKSLASH_ESCAPES` on the
  restoring session; without it, every backslash escape in the dump's string
  literals is reinterpreted. The `FOREIGN_KEY_CHECKS` guard is what allows any
  table order.
- **`includeTimestamp: false`** makes the output byte-reproducible across runs,
  which is what the round-trip tests rely on.

For `mysqldump --compact`:

```ts
render: {
  includeHeaderComments: false,
  includeFooterComment: false,
  addDropTable: false,
  setCharset: false,
  addLocks: false,
  disableKeys: false,
}
```

### `dataExport` — row batching

| Option                                        | Default       | Meaning                                                  |
| --------------------------------------------- | ------------- | -------------------------------------------------------- |
| `maxStatementBytes`                           | `1046528`     | `mysqldump`'s own `--net-buffer-length` default.         |
| `maxRowsPerStatement`                         | unlimited     | `mysqldump` has no row cap either; set it to add one.    |
| `streamBatchSize`                             | `200`         | Rows buffered ahead of the consumer (backpressure mark). |
| `orderByPrimaryKey`                           | `true`        | Read in primary-key order for reproducible output.       |
| `extendedInsert`, `completeInsert`, `hexBlob` | from `render` | Same knobs from the data layer's side.                   |

Statement size is **also** clamped against the server's `max_allowed_packet`
(to 90% of it), because a statement above that limit is rejected at restore time
regardless of what was configured. A statement is closed _before_ appending the
row that would exceed the cap, so the cap is a true upper bound; a single row
larger than the cap is still emitted, alone.

`orderByPrimaryKey` is a deliberate deviation from `mysqldump` — see
[native-compatibility.md](native-compatibility.md#3-rows-are-read-in-primary-key-order).
A table with no primary key reads unordered and reports `unordered-table-read`.

### `consistency`

```ts
consistency: 'single-transaction' | 'lock-all-tables' | 'none';
```

- **`'single-transaction'`** (default) — `SET SESSION TRANSACTION ISOLATION LEVEL
REPEATABLE READ` then `START TRANSACTION WITH CONSISTENT SNAPSHOT`, the same
  pair `mysqldump --single-transaction` uses. Non-blocking.

  **Only transactional engines participate.** A MyISAM/MEMORY/CSV/ARCHIVE table
  is read outside any snapshot, and a
  `nontransactional-table-not-snapshot-consistent` warning is reported _per such
  table_ rather than pretending otherwise. DDL is likewise not covered: MySQL
  does not include metadata changes in an InnoDB snapshot, so a concurrent
  `ALTER TABLE` can still produce an inconsistent result.

- **`'lock-all-tables'`** — `FLUSH TABLES WITH READ LOCK`. Blocks _all_ writes
  server-wide for the whole dump, but does cover nontransactional engines and
  DDL. Requires `RELOAD` (or `FLUSH_TABLES`).

- **`'none'`** — no locking or transaction work, no guarantee whatsoever.

## `DumpResult`

```ts
{
  bytesWritten: number;
  rowsExported: number;
  statementsWritten: number;
  renderedDumpIds: readonly string[];
  skippedDumpIds: readonly string[];
  warnings: readonly MysqlDiagnostic[];
  cancelled: boolean;
}
```

`cancelled` is `true` when the `AbortSignal` fired; the dump is truncated but
nothing throws, and the session is torn down cleanly.

## Progress

```ts
await dumpMysql(connection, options, output, event => {
  switch (event.phase) {
    case 'exporting-data':
      console.log(`${event.tableName}: ${event.rowsExported} rows, ${event.bytesWritten} bytes`);
      break;
    case 'rendering-schema':
      console.log(`${event.objectsProcessed}/${event.objectsTotal} ${event.objectName}`);
      break;
  }
});
```

Phases, in order: `connecting`, `starting-snapshot`, `introspecting`,
`detecting-version`, `planning-archive`, `rendering-schema`, `exporting-data`,
`finalizing`. Data events additionally carry `exportState`
(`started`/`progress`/`finished`/`failed`/`cancelled`), `tableName`,
`rowsExported` and `bytesWritten`. Row progress is emitted every 1000 rows to
keep a large table's callback overhead negligible.

## Cancellation

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

const result = await dumpMysql(connection, {}, output, undefined, controller.signal);
if (result.cancelled) console.warn('dump truncated');
```

Cancellation stops the row stream, releases any connection this package acquired,
and restores every session variable it changed. A partially accumulated `INSERT`
is deliberately **not** flushed: it would be a syntactically valid insert of an
arbitrary prefix of the table, which is worse than an obviously truncated dump.

## Composing the stages

Each layer is independently usable. `inspectDumpArchive` and `renderPlainSql` are
pure functions of the model and need no connection at all:

```ts
import {
  introspectMysql,
  inspectDumpArchive,
  renderPlainSql,
  BufferDumpWriter,
} from 'dbgate-mysql-dumper';

const { database, version } = await introspectMysql(connection);

// Inspect the plan without rendering anything.
const archive = inspectDumpArchive(database, { mode: 'schema-only' });
for (const entry of archive.entries) {
  console.log(entry.sequenceNumber, entry.section, entry.objectType, entry.name);
}

// Render schema only, into memory, with no database access.
const writer = new BufferDumpWriter();
await renderPlainSql({ database, archive, writer, sourceVersion: version });
console.log(writer.toString());
```

`exportTableDataAsInserts` streams one table's rows on its own:

```ts
import { exportTableDataAsInserts } from 'dbgate-mysql-dumper';

const result = await exportTableDataAsInserts({
  connection,
  databaseName: 'shop',
  table: database.tables.find(t => t.pureName === 'orders')!,
  indexes: database.indexes,
  writer,
  options: { maxStatementBytes: 512 * 1024 },
});
```
