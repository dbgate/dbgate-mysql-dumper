/**
 * Optional adapter for the `mysql2` package.
 *
 * Wraps a caller-owned `mysql2` `Connection` — or a `Pool`, from which one
 * physical connection is checked out per operation — as a
 * {@link MysqlConnection}. This module is never imported by the core
 * package; `mysql2` is an optional peer dependency and is only resolved when
 * a consumer imports `dbgate-mysql-dumper/mysql2` themselves.
 *
 * `mysql2` is the driver DbGate's own MySQL plugin uses, which is why it is
 * the bundled adapter.
 *
 * Both the callback API (`mysql2`) and the promise API (`mysql2/promise`)
 * are accepted: a promise-API connection exposes the underlying callback
 * connection, and this adapter unwraps it rather than maintaining two code
 * paths. The callback API is used internally because it is the only one that
 * exposes the streaming and `fields` hooks this package needs.
 */
import type { Connection, Pool, PoolConnection, Query, QueryOptions } from 'mysql2';
import type {
  AcquiredMysqlConnection,
  MysqlConnection,
  MysqlConnectionSource,
  MysqlExecResult,
  MysqlParameterValue,
  MysqlQuery,
  MysqlQueryResult,
  MysqlResultColumn,
  MysqlRow,
  MysqlServerErrorInfo,
  MysqlStreamOptions,
  MysqlValueMode,
} from './connection/types.js';
import { MysqlDumperError, OperationCancelledError, throwIfAborted } from './utils/errors.js';

/** Rows buffered ahead of the consumer before `stream()` pauses the underlying result stream. */
const DEFAULT_STREAM_HIGH_WATER_MARK = 200;

/**
 * The subset of a `mysql2` field descriptor this adapter reads.
 *
 * `mysql2` does not export a type for the object passed to `typeCast`, and
 * the object it passes is a purpose-built wrapper rather than the raw field
 * — so the shape is declared locally and narrowed at runtime instead of
 * reaching into the package's internals.
 */
interface Mysql2TypeCastField {
  readonly type: string;
  readonly name: string;
  string(encoding?: string): string | null;
  buffer(): Buffer | null;
  geometry(): unknown;
}

/** The subset of a `mysql2` result-set field descriptor this adapter reads. */
interface Mysql2FieldPacket {
  readonly name: string;
  readonly columnType?: number;
  readonly flags?: number;
  readonly characterSet?: number;
  readonly type?: number;
}

interface Mysql2OkPacket {
  readonly affectedRows?: number;
  readonly insertId?: number | bigint;
  readonly warningStatus?: number;
  readonly warningCount?: number;
}

/** A promise-API connection/pool, which wraps and exposes its callback-API counterpart. */
interface PromiseWrapped<T> {
  readonly connection?: T;
  readonly pool?: T;
}

function unwrapConnection(input: Connection | PromiseWrapped<Connection>): Connection {
  const wrapped = (input as PromiseWrapped<Connection>).connection;
  return wrapped ?? (input as Connection);
}

function unwrapPool(input: Pool | PromiseWrapped<Pool>): Pool {
  const wrapped = (input as PromiseWrapped<Pool>).pool;
  return wrapped ?? (input as Pool);
}

/**
 * The `typeCast` hook for `'raw'` value mode: hand back the exact bytes
 * MySQL sent, for every column.
 *
 * `field.buffer()` is used unconditionally rather than `field.string()` for
 * text columns, because the wrapper `mysql2` passes here does not expose the
 * column's collation id — the only thing that distinguishes `TEXT` from
 * `BLOB`, or `VARCHAR` from `VARBINARY`, since each pair shares a protocol
 * type. Deciding text-vs-binary is left to the serializer, which has the
 * introspected column type; see {@link MysqlValueMode}.
 */
function rawTypeCast(field: Mysql2TypeCastField): Buffer | null {
  return field.buffer();
}

function toResultColumns(fields: readonly Mysql2FieldPacket[] | undefined): MysqlResultColumn[] {
  return (fields ?? []).map(field => ({
    name: field.name,
    ...(field.columnType === undefined ? {} : { columnType: field.columnType }),
    ...(field.flags === undefined ? {} : { flags: field.flags }),
    ...(field.characterSet === undefined ? {} : { characterSet: field.characterSet }),
  }));
}

function isOkPacket(value: unknown): value is Mysql2OkPacket {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'affectedRows' in (value as Record<string, unknown>)
  );
}

/**
 * Extracts MySQL's own error fields from a driver error.
 *
 * `mysql2` decorates its errors with `errno`, `code` and `sqlState` straight
 * from the server. Surfacing them structurally lets a caller branch on
 * `errno === 1146` instead of matching on message text, which changes with
 * server version and locale.
 */
export function describeMysql2Error(error: unknown): MysqlServerErrorInfo | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    errno?: unknown;
    code?: unknown;
    sqlState?: unknown;
    sqlMessage?: unknown;
    message?: unknown;
  };
  const message =
    (typeof candidate.sqlMessage === 'string' && candidate.sqlMessage) ||
    (typeof candidate.message === 'string' && candidate.message) ||
    undefined;
  if (message === undefined) {
    return undefined;
  }
  return {
    ...(typeof candidate.errno === 'number' ? { errno: candidate.errno } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.sqlState === 'string' ? { sqlState: candidate.sqlState } : {}),
    message,
  };
}

function wrapMysql2Error(error: unknown): MysqlDumperError {
  const described = describeMysql2Error(error);
  const message = described?.message ?? String(error);
  const wrapped = new MysqlDumperError('mysql2-query-failed', message, { cause: error });
  return wrapped;
}

function toDriverParameters(
  parameters: readonly MysqlParameterValue[] | undefined,
): unknown[] | undefined {
  if (!parameters) {
    return undefined;
  }
  // `mysql2` formats `bigint` values correctly (it stringifies them without
  // going through `Number`), so they are passed through unchanged rather
  // than pre-converted, which would be the lossy step this avoids.
  return [...parameters];
}

/**
 * Adapts one `mysql2` connection as a {@link MysqlConnection}.
 *
 * The caller retains ownership: this adapter never calls `end()`/`destroy()`
 * on a connection it did not create. `cancel()` maps to `destroy()`, because
 * MySQL has no in-band statement cancellation — see the note on
 * {@link Mysql2ConnectionAdapter.cancel}.
 */
export class Mysql2ConnectionAdapter implements MysqlConnection {
  readonly supportsRawValueReads = true;

  private readonly connection: Connection;
  /** Description of the request currently occupying the connection, if any. */
  private inFlight: string | null = null;
  /** Set once {@link cancel} has destroyed the socket; see {@link assertUsable}. */
  private destroyed = false;

  constructor(connection: Connection | PromiseWrapped<Connection>) {
    this.connection = unwrapConnection(connection);
  }

  /**
   * Guards against overlapping commands on one connection.
   *
   * The MySQL client/server protocol is strictly one command at a time per
   * connection; `mysql2` queues overlapping queries internally, which turns
   * a caller bug into a silent stall whenever the queued operation is itself
   * what the in-flight one is waiting for (a `query()` issued while a
   * `stream()` from the same connection is still being consumed). Detecting
   * it here names both operations instead.
   */
  private beginRequest(description: string): () => void {
    if (this.inFlight !== null) {
      throw new MysqlDumperError(
        'connection-busy',
        `Cannot start "${description}" while "${this.inFlight}" is still in flight on the same connection. ` +
          'A single MySQL session executes one command at a time: await each call (and finish consuming any stream()) before starting the next, or use a separate connection.',
      );
    }
    this.inFlight = description;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.inFlight = null;
    };
  }

  private buildOptions(query: MysqlQuery, valueMode: MysqlValueMode): QueryOptions {
    const options: Record<string, unknown> = { sql: query.sql };
    const parameters = toDriverParameters(query.parameters);
    if (parameters) {
      options.values = parameters;
    }
    if (query.timeoutMs !== undefined) {
      options.timeout = query.timeoutMs;
    }
    if (valueMode === 'raw') {
      options.typeCast = rawTypeCast;
    }
    // `typeCast` is typed narrowly by `mysql2` and does not accept this
    // adapter's locally-declared field shape, so the object is assembled
    // untyped and asserted once here rather than fighting the declaration
    // at each property.
    return options as unknown as QueryOptions;
  }

  async query<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    signal?: AbortSignal,
    valueMode: MysqlValueMode = 'native',
  ): Promise<MysqlQueryResult<Row>> {
    throwIfAborted(signal);
    this.assertUsable(`query(${describeSql(query.sql)})`);
    const endRequest = this.beginRequest(`query(${describeSql(query.sql)})`);

    return new Promise<MysqlQueryResult<Row>>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new OperationCancelledError());
        void this.cancel();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const settle = (action: () => void): void => {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        action();
      };

      try {
        this.connection.query(
          this.buildOptions(query, valueMode),
          (error: unknown, result: unknown, fields: unknown) => {
            if (error) {
              settle(() => reject(wrapMysql2Error(error)));
              return;
            }
            const columns = toResultColumns(fields as Mysql2FieldPacket[] | undefined);
            if (isOkPacket(result)) {
              settle(() =>
                resolve({
                  rows: [],
                  columns,
                  affectedRows: result.affectedRows ?? 0,
                  ...(result.insertId === undefined ? {} : { insertId: result.insertId }),
                  ...(result.warningStatus === undefined
                    ? {}
                    : { warningCount: result.warningStatus }),
                }),
              );
              return;
            }
            settle(() =>
              resolve({
                rows: (Array.isArray(result) ? result : []) as Row[],
                columns,
                affectedRows: 0,
              }),
            );
          },
        );
      } catch (error) {
        // `mysql2` can throw synchronously when the connection is already
        // closed. Without this the callback never runs, `endRequest()` never
        // fires, and every later call fails with `connection-busy`.
        settle(() => reject(wrapMysql2Error(error)));
      }
    });
  }

  /**
   * Sends `sql` verbatim, with no parameter binding and no client-side
   * rewriting — `mysql2`'s `query()` only substitutes `?` when a `values`
   * array is supplied, so omitting it is what guarantees a dump statement
   * reaches the server byte for byte.
   *
   * This matters more than it looks: a restored `INSERT` may legitimately
   * contain a `?` inside a string literal, and every MySQL executable
   * comment (`/*!40000 ALTER TABLE ... DISABLE KEYS &#42;/`) is real SQL the
   * server must see and evaluate, not a comment to strip.
   */
  async execute(sql: string, signal?: AbortSignal): Promise<MysqlExecResult> {
    const result = await this.query({ sql }, signal, 'native');
    return {
      affectedRows: result.affectedRows,
      ...(result.warningCount === undefined ? {} : { warningCount: result.warningCount }),
    };
  }

  describeError(error: unknown): MysqlServerErrorInfo | undefined {
    return describeMysql2Error(error);
  }

  /**
   * Streams rows with real backpressure: `mysql2`'s `Query` object is
   * paused once `batchSize` rows are buffered ahead of the consumer and
   * resumed when the buffer drains, so an unconsumed ten-million-row result
   * never accumulates in memory regardless of how slowly the caller
   * iterates.
   */
  stream<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    options?: MysqlStreamOptions,
  ): AsyncIterable<Row> {
    const connection = this.connection;
    const signal = options?.signal;
    const valueMode = options?.valueMode ?? 'raw';
    const highWaterMark = Math.max(1, options?.batchSize ?? DEFAULT_STREAM_HIGH_WATER_MARK);
    const lowWaterMark = Math.max(1, Math.floor(highWaterMark / 2));
    const queryOptions = this.buildOptions(query, valueMode);
    const beginRequest = (): (() => void) => this.beginRequest(`stream(${describeSql(query.sql)})`);
    const assertUsable = (): void => this.assertUsable(`stream(${describeSql(query.sql)})`);
    const cancel = (): Promise<void> => this.cancel();

    const generator = async function* (): AsyncGenerator<Row> {
      throwIfAborted(signal);
      assertUsable();
      const endRequest = beginRequest();
      const queue: Row[] = [];
      /**
       * Whether the *result set* has genuinely ended, as reported by `mysql2`.
       *
       * Deliberately distinct from "we were told to stop": conflating the two
       * deadlocks the connection. An abort would mark the stream finished,
       * which skipped the cancellation below, while the `result` listener
       * stayed attached — so rows kept arriving, the queue passed the
       * high-water mark, and the listener paused the connection with nobody
       * left to resume it. Every later statement on that connection then
       * waited forever.
       */
      let queryEnded = false;
      let failure: unknown = null;
      let paused = false;
      let notify: (() => void) | null = null;

      const wake = (): void => {
        notify?.();
        notify = null;
      };

      const emitter = connection.query(queryOptions) as Query;

      const onFields = (fields: unknown): void => {
        options?.onColumns?.(toResultColumns(fields as Mysql2FieldPacket[] | undefined));
      };
      const onResult = (row: unknown): void => {
        queue.push(row as Row);
        if (queue.length >= highWaterMark && !paused) {
          paused = true;
          connection.pause();
        }
        wake();
      };
      const onError = (error: unknown): void => {
        if (failure === null) {
          failure = wrapMysql2Error(error);
        }
        queryEnded = true;
        wake();
      };
      const onEnd = (): void => {
        queryEnded = true;
        wake();
      };

      emitter.on('fields', onFields);
      emitter.on('result', onResult);
      emitter.on('error', onError);
      emitter.on('end', onEnd);

      const onAbort = (): void => {
        failure = new OperationCancelledError();
        wake();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        for (;;) {
          if (queue.length > 0) {
            const row = queue.shift() as Row;
            if (paused && queue.length <= lowWaterMark) {
              paused = false;
              connection.resume();
            }
            yield row;
            continue;
          }
          if (failure) {
            throw failure;
          }
          if (queryEnded) {
            return;
          }
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      } finally {
        endRequest();
        signal?.removeEventListener('abort', onAbort);
        // Detached first, and unconditionally: a late `result` event would
        // otherwise re-pause the connection after the only code that could
        // resume it has gone away.
        emitter.removeListener('fields', onFields);
        emitter.removeListener('result', onResult);
        emitter.removeListener('error', onError);
        emitter.removeListener('end', onEnd);

        if (paused) {
          // Never hand a paused connection back: `mysql2`'s pause is
          // connection-wide, so leaving it set would stall every later query.
          paused = false;
          connection.resume();
        }
        if (!queryEnded) {
          // Rows are still arriving and nothing is reading them. MySQL offers
          // no way to abandon a result set on its own connection, so the
          // socket has to go — see `cancel()`. Gated on the *result set*
          // rather than on how the consumer left, so a `break` after a small,
          // already-complete result keeps the connection usable.
          await cancel();
        }
      }
    };

    return generator();
  }

  /**
   * Stops the in-flight statement by destroying the connection.
   *
   * MySQL has no in-band cancellation: the documented way to stop a running
   * statement is `KILL QUERY <id>` **from a second connection**, which this
   * adapter deliberately does not do — opening an unrequested connection
   * (with credentials it would have to re-derive) is not something a library
   * should do behind a caller's back, and on a pool it would consume a slot
   * the caller sized for their own workload. Destroying the socket is the
   * one option available from inside the session; the server notices the
   * disconnect and rolls back its side.
   *
   * A caller who needs the gentler behaviour can issue `KILL QUERY` from
   * their own second connection, which they are already holding.
   *
   * The adapter remembers that it did this. `mysql2` does **not** invoke the
   * completion callback of a query issued on a destroyed connection, so
   * without that flag every cleanup statement a cancelled operation runs
   * afterwards — `COMMIT`, `UNLOCK TABLES`, the session-variable restores —
   * would wait forever and `dumpMysql`/`restoreSqlDump` would never settle.
   * See {@link assertUsable}.
   */
  async cancel(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.connection.destroy();
  }

  /** Whether this adapter destroyed its connection through {@link cancel}. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Fails fast once the connection has been destroyed.
   *
   * Every cleanup path in this package is written to swallow errors, so
   * rejecting immediately lets them finish instantly instead of hanging on a
   * callback `mysql2` will never fire.
   */
  private assertUsable(operation: string): void {
    if (this.destroyed) {
      throw new MysqlDumperError(
        'connection-destroyed',
        `Cannot run ${operation}: this connection was destroyed to cancel an in-flight statement. MySQL has no in-band cancellation, so stopping a running query closes the socket; open a new connection to continue.`,
      );
    }
  }
}

/** Truncates SQL for an adapter-level error message; never a whole statement. */
function describeSql(sql: string): string {
  const normalized = sql.trim().replace(/\s+/g, ' ');
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 60)}…`;
}

/**
 * Adapts an existing `mysql2` connection (callback or promise API).
 *
 * The caller keeps ownership: the returned connection is never ended or
 * destroyed by this package except through an explicit `cancel()`, which a
 * cancelled dump triggers to stop an in-flight result set.
 */
export function fromMysql2Connection(
  connection: Connection | PromiseWrapped<Connection>,
): MysqlConnection {
  return new Mysql2ConnectionAdapter(connection);
}

/**
 * Adapts a `mysql2` pool (callback or promise API) as a
 * {@link MysqlConnectionSource}.
 *
 * A pool is *not* a connection: a dump needs one physical session for its
 * whole run, because `START TRANSACTION WITH CONSISTENT SNAPSHOT`, the
 * pinned `time_zone`/`sql_mode`/charset, and `LOCK TABLES` are all session
 * state that a pool would scatter across arbitrary connections. So this
 * returns a source that checks out one connection per operation and releases
 * it back to the pool — never destroying it — when the operation ends.
 */
export function fromMysql2Pool(pool: Pool | PromiseWrapped<Pool>): MysqlConnectionSource {
  const callbackPool = unwrapPool(pool);
  return {
    acquire: (signal?: AbortSignal): Promise<AcquiredMysqlConnection> => {
      throwIfAborted(signal);
      return new Promise<AcquiredMysqlConnection>((resolve, reject) => {
        callbackPool.getConnection((error: unknown, poolConnection: PoolConnection) => {
          if (error) {
            reject(wrapMysql2Error(error));
            return;
          }
          let released = false;
          resolve({
            connection: new Mysql2ConnectionAdapter(poolConnection),
            dedicated: true,
            release: async () => {
              if (released) return;
              released = true;
              // `release()`, never `destroy()`: the pool owns this socket's
              // lifetime and the caller sized the pool expecting it back.
              poolConnection.release();
            },
          });
        });
      });
    },
  };
}

export interface ConnectMysql2Result {
  readonly connection: MysqlConnection;
  /** Closes the underlying `mysql2` connection this call created. */
  close(): Promise<void>;
}

/**
 * Convenience creator: establishes a new `mysql2` connection from `config`
 * and adapts it. Unlike {@link fromMysql2Connection}, the connection is
 * owned by the caller of *this* function — call `close()` when done.
 *
 * `mysql2` is imported dynamically so that this module can be loaded (and
 * type-checked, and tree-shaken) without the optional peer dependency being
 * installed, as long as this particular function is not called.
 */
export async function connectMysql2(config: Record<string, unknown>): Promise<ConnectMysql2Result> {
  const mysql2 = (await import('mysql2')) as unknown as {
    createConnection(config: Record<string, unknown>): Connection;
  };
  const created = mysql2.createConnection({
    ...config,
    // A dump is a long-lived sequence of large reads; the driver's default
    // 10s connect timeout is fine, but its default `dateStrings: false` and
    // `supportBigNumbers: false` are irrelevant here because every data read
    // goes through this adapter's own `typeCast`. Nothing is overridden that
    // the caller might reasonably want to control.
  });

  await new Promise<void>((resolve, reject) => {
    created.connect((error: unknown) => (error ? reject(wrapMysql2Error(error)) : resolve()));
  });

  const adapter = new Mysql2ConnectionAdapter(created);
  return {
    connection: adapter,
    close: async () => {
      // `end()` on a destroyed connection never invokes its callback, so a
      // `close()` after a cancelled operation would hang. The socket is
      // already gone in that case, which is what `close()` was going to
      // achieve anyway.
      if (adapter.isDestroyed) {
        return;
      }
      await new Promise<void>(resolve => {
        created.end(() => resolve());
      });
    },
  };
}
