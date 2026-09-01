# The `mysql2` adapter

The core package never imports a driver. `mysql2` is an **optional peer
dependency** reachable only through a separate entry point:

```ts
import { fromMysql2Connection, fromMysql2Pool, connectMysql2 } from 'dbgate-mysql-dumper/mysql2';
```

`mysql2` is the bundled adapter because it is what DbGate's MySQL/MariaDB plugin
uses. Flavor is detected from the connected server, so no second MariaDB driver
dependency is needed. `tests/packageBoundaries.test.ts` fails if any core module
starts importing it.

```sh
npm install dbgate-mysql-dumper
npm install mysql2   # only if you use this adapter
```

## Three entry points

### `fromMysql2Connection(connection)`

Adapts an existing connection. Accepts either API — a promise-API connection
exposes its callback-API counterpart, and the adapter unwraps it rather than
maintaining two code paths.

```ts
import mysql from 'mysql2/promise';
import { fromMysql2Connection } from 'dbgate-mysql-dumper/mysql2';

const mysql2Connection = await mysql.createConnection({ host, user, password, database });
const connection = fromMysql2Connection(mysql2Connection);

await dumpMysql(connection, { mode: 'full' }, output);
await mysql2Connection.end(); // yours to close
```

**The caller keeps ownership.** This adapter never calls `end()` or `destroy()`
on a connection it did not create, except through an explicit `cancel()`.

### `fromMysql2Pool(pool)`

Adapts a pool as a `MysqlConnectionSource` — deliberately _not_ as a connection.

```ts
import mysql from 'mysql2/promise';
import { fromMysql2Pool } from 'dbgate-mysql-dumper/mysql2';

const pool = mysql.createPool({ host, user, password, database, connectionLimit: 10 });
const source = fromMysql2Pool(pool);

await dumpMysql(source, { mode: 'full' }, output); // checks out one connection
await restoreSqlDump({ connection: source, source: sql });
```

A pool is not a connection, and for a dump the difference is not cosmetic.
`START TRANSACTION WITH CONSISTENT SNAPSHOT`, the pinned
`time_zone`/`sql_mode`/charset, and (in `lock-all-tables` mode) the read lock are
all **session** state. A pool handing out an arbitrary connection per query would
read each table under different conditions.

So the source checks out **one** physical connection for the whole operation and
`release()`s it — never `destroy()`s it — at the end. The pool owns the socket's
lifetime, and you sized the pool expecting it back.

### `connectMysql2(config)`

Creates and owns a connection, for scripts and tests:

```ts
const { connection, close } = await connectMysql2({ host, user, password, database });
try {
  await dumpMysql(connection, { mode: 'full' }, output);
} finally {
  await close();
}
```

`mysql2` is imported **dynamically** here, so this module loads and type-checks
without the optional peer dependency installed, as long as this particular
function is not called.

## What the adapter guarantees

### Raw value reads

The adapter reports `supportsRawValueReads: true` and honours
`valueMode: 'raw'` by installing a per-query `typeCast` that returns
`field.buffer()` for every column — the exact bytes MySQL sent.

Without this, `mysql2`'s defaults would quietly destroy data a dump exists to
preserve:

| Column                  | `mysql2` default                                | Raw mode          |
| ----------------------- | ----------------------------------------------- | ----------------- |
| `BIGINT`                | JS `number` — rounds past 2^53                  | exact digits      |
| `DECIMAL`               | string, but trailing zeros can be lost          | exact text        |
| `DATETIME`, `TIMESTAMP` | `Date` in local time; `'0000-00-00'` impossible | exact text        |
| `TIME '-838:59:59'`     | outside `Date`'s range                          | exact text        |
| `JSON`                  | `JSON.parse` — key order and spacing lost       | exact text        |
| `DOUBLE`                | reformatted                                     | server's own text |

Buffers for _everything_ rather than strings for text is deliberate: the protocol
distinguishes `TEXT` from `BLOB` only by collation id, and `mysql2` does not
expose that to `typeCast`. The serializer decides, using the introspected column
type. See [architecture.md](architecture.md#why-values-arrive-as-raw-bytes).

Text columns are still encoded — in `character_set_results`, which the dump
session pins to `utf8mb4` — so one decode rule covers a `latin1` column and a
`utf8mb4` one alike.

### Verbatim statement execution

`execute(sql)` sends `sql` with no parameter binding and no client-side
rewriting: `mysql2`'s `query()` only substitutes `?` when a `values` array is
supplied, so omitting it is what guarantees a dump statement reaches the server
byte for byte.

This matters more than it looks. A restored `INSERT` may contain a literal `?`
inside a string, and every executable comment is real SQL the server must
evaluate rather than a comment to strip.

### Real streaming backpressure

`stream()` uses `mysql2`'s `Query` event API and pauses the connection once
`batchSize` rows are buffered ahead of the consumer, resuming when the buffer
drains. An unconsumed ten-million-row result never accumulates in memory,
however slowly the caller iterates.

The generator's `finally` block always resumes a paused connection — `mysql2`'s
pause is connection-wide, so leaving it set would stall every later query — and
cancels when the consumer stopped early.

### Structured errors

`describeError()` extracts `errno`, `code` and `sqlState` from a `mysql2` error,
so a caller can branch on `errno === 1146` rather than matching message text
that changes with server version and locale. These reach
`RestoreStatementError.serverError`.

### Overlapping-command detection

The MySQL protocol is strictly one command at a time per connection. `mysql2`
queues overlapping queries internally, which turns a caller bug into a silent
stall whenever the queued operation is what the in-flight one is waiting for — a
`query()` issued while a `stream()` from the same connection is still being
consumed.

The adapter detects that and throws `connection-busy`, naming **both**
operations:

```
Cannot start "query(SELECT ...)" while "stream(SELECT ...)" is still in flight on
the same connection. A single MySQL session executes one command at a time: await
each call (and finish consuming any stream()) before starting the next, or use a
separate connection.
```

## `cancel()` destroys the connection

MySQL has no in-band statement cancellation. The documented way to stop a running
statement is `KILL QUERY <id>` **from a second connection**, which this adapter
deliberately does not do: opening an unrequested connection (with credentials it
would have to re-derive) is not something a library should do behind a caller's
back, and on a pool it would consume a slot the caller sized for their own
workload.

Destroying the socket is the one option available from inside the session; the
server notices the disconnect and rolls back its side. A caller who needs the
gentler behaviour can issue `KILL QUERY` from their own second connection, which
they are already holding.

This is why a cancelled dump ends with the connection unusable — expected, and
why `connectMysql2`'s `close()` is safe to call afterwards.

Two consequences are handled explicitly, because both used to hang:

- **A destroyed connection fails fast.** `mysql2` never invokes the callback of
  a query issued on a destroyed connection, so the cleanup a cancelled
  operation runs afterwards — `COMMIT`, `UNLOCK TABLES`, the session-variable
  restores — would wait forever. The adapter remembers that it destroyed the
  socket and rejects immediately with `connection-destroyed`; every cleanup
  path already swallows errors, so they finish instantly instead.
- **An abandoned stream destroys the connection.** If a consumer stops
  iterating while the result set is _still arriving_, there is no way to
  abandon it — so the socket is closed. Crucially this is decided by whether
  the **result set** ended, not by how the consumer left: a `break` after a
  small, already-complete result keeps the connection perfectly usable. The
  row listener is also detached on the way out, so a late row can never
  re-pause a connection nobody is left to resume.

## Configuration notes

Nothing needs to be configured for correctness: the adapter installs its own
`typeCast` per query, so `dateStrings`, `supportBigNumbers`, `decimalNumbers` and
`typeCast` in your `mysql2` config do not affect dump fidelity either way.

Two settings are worth considering for large dumps:

```ts
mysql.createPool({
  // A restore is a long sequence of large statements; the default 10s connect
  // timeout is fine, but a slow first statement can exceed a short one.
  connectTimeout: 30_000,
  // Never needed: this package sends exactly one statement per round trip.
  multipleStatements: false,
});
```

Leave `multipleStatements` off. This package never relies on it, and it widens
the blast radius of any SQL that reaches the server unexpectedly.

## Writing another adapter

Implement `MysqlConnection`. The required surface is small:

```ts
interface MysqlConnection {
  supportsRawValueReads?: boolean;
  query<Row>(
    query: MysqlQuery,
    signal?: AbortSignal,
    valueMode?: MysqlValueMode,
  ): Promise<MysqlQueryResult<Row>>;
  stream<Row>(query: MysqlQuery, options?: MysqlStreamOptions): AsyncIterable<Row>;
  execute?(sql: string, signal?: AbortSignal): Promise<MysqlExecResult>;
  describeError?(error: unknown): MysqlServerErrorInfo | undefined;
  cancel(): Promise<void>;
}
```

Only `query`, `stream` and `cancel` are mandatory. An adapter that cannot deliver
`'raw'` values should report `supportsRawValueReads: false`; data export still
works and reports a `lossy-value-mode` warning naming exactly what may not
survive, rather than degrading silently.

`tests/mockConnection.ts` is a complete in-memory implementation, useful as a
reference.
