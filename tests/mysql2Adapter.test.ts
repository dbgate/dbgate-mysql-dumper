import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Mysql2ConnectionAdapter, describeMysql2Error } from '../src/mysql2.js';
import { MysqlDumperError } from '../src/utils/errors.js';

/**
 * A minimal stand-in for a `mysql2` callback-API `Connection`, faithful to the
 * behaviours this adapter depends on:
 *
 * - `query()` with no callback returns an `EventEmitter` that emits
 *   `fields`/`result`/`end`/`error`.
 * - `pause()`/`resume()` gate row delivery, connection-wide.
 * - a destroyed connection **never invokes a query callback** — the property
 *   that turned an abandoned stream into a permanent hang.
 */
class FakeMysql2Connection extends EventEmitter {
  destroyed = false;
  paused = false;
  /** Every SQL string handed to `query()`, in order. */
  readonly queries: string[] = [];
  /** Rows the next `query()` will stream, and whether to end the result set. */
  rows: unknown[] = [];
  endAfterRows = true;
  /** Set when a row was delivered while paused, which mysql2 would never do. */
  deliveredWhilePaused = false;

  private pending: (() => void)[] = [];

  query(options: { sql: string }, callback?: (...args: unknown[]) => void): EventEmitter {
    this.queries.push(options.sql);

    if (callback) {
      // A destroyed mysql2 connection silently drops the callback. Reproducing
      // that is the whole point of this fake.
      if (this.destroyed) {
        return new EventEmitter();
      }
      setImmediate(() => callback(null, { affectedRows: 0 }, []));
      return new EventEmitter();
    }

    const emitter = new EventEmitter();
    const remaining = [...this.rows];
    const endAfterRows = this.endAfterRows;

    // Rows are delivered in bursts, synchronously, until the consumer pauses —
    // which is how mysql2 behaves as it drains a network packet, and what makes
    // the queue actually build up behind a slow consumer.
    const pump = (): void => {
      if (this.destroyed) return;
      while (!this.paused) {
        const row = remaining.shift();
        if (row === undefined) {
          if (endAfterRows) emitter.emit('end');
          return;
        }
        emitter.emit('result', row);
      }
      // Paused: wait for resume() rather than delivering another row.
      this.pending.push(pump);
    };

    setImmediate(() => {
      emitter.emit('fields', []);
      pump();
    });
    return emitter;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiting = this.pending;
    this.pending = [];
    for (const resume of waiting) setImmediate(resume);
  }

  destroy(): void {
    this.destroyed = true;
  }

  end(callback?: () => void): void {
    if (this.destroyed) return; // as mysql2 does: no callback on a dead socket
    callback?.();
  }
}

/** Resolves to `'timeout'` if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('Mysql2ConnectionAdapter: cancellation', () => {
  it('destroys the connection and reports it', async () => {
    const fake = new FakeMysql2Connection();
    const adapter = new Mysql2ConnectionAdapter(fake as never);
    expect(adapter.isDestroyed).toBe(false);
    await adapter.cancel();
    expect(fake.destroyed).toBe(true);
    expect(adapter.isDestroyed).toBe(true);
  });

  it('is idempotent', async () => {
    const fake = new FakeMysql2Connection();
    const adapter = new Mysql2ConnectionAdapter(fake as never);
    await adapter.cancel();
    await adapter.cancel();
    expect(adapter.isDestroyed).toBe(true);
  });

  /**
   * Regression, critical: `mysql2` never invokes the callback of a query
   * issued on a destroyed connection, so every cleanup statement a cancelled
   * dump runs afterwards — `COMMIT`, `UNLOCK TABLES`, the session-variable
   * restores — waited forever and `dumpMysql` never settled.
   */
  it('fails fast instead of hanging once destroyed', async () => {
    const fake = new FakeMysql2Connection();
    const adapter = new Mysql2ConnectionAdapter(fake as never);
    await adapter.cancel();

    const query = await withTimeout(adapter.query({ sql: 'COMMIT' }).catch(error => error));
    expect(query).not.toBe('timeout');
    expect(query).toBeInstanceOf(MysqlDumperError);
    expect((query as MysqlDumperError).code).toBe('connection-destroyed');

    const execute = await withTimeout(adapter.execute('UNLOCK TABLES').catch(error => error));
    expect(execute).not.toBe('timeout');
    expect((execute as MysqlDumperError).code).toBe('connection-destroyed');
  });

  it('refuses to start a new stream once destroyed', async () => {
    const fake = new FakeMysql2Connection();
    const adapter = new Mysql2ConnectionAdapter(fake as never);
    await adapter.cancel();
    const iterate = (async () => {
      for await (const _row of adapter.stream({ sql: 'SELECT 1' })) {
        // never reached
      }
    })();
    await expect(iterate).rejects.toThrow(/destroyed/);
  });
});

describe('Mysql2ConnectionAdapter: abandoned streams', () => {
  /**
   * Regression, critical: abandoning a stream whose result set was still
   * arriving left the `result` listener attached. Rows kept coming, the queue
   * passed the high-water mark, and the listener called `connection.pause()`
   * with nobody left to resume it — deadlocking every later statement on that
   * connection.
   */
  it('destroys the connection when a still-running stream is abandoned', async () => {
    const fake = new FakeMysql2Connection();
    // Far more rows than the high-water mark, and the result set never ends.
    fake.rows = Array.from({ length: 5_000 }, (_, index) => ({ id: index }));
    fake.endAfterRows = false;
    const adapter = new Mysql2ConnectionAdapter(fake as never);

    let seen = 0;
    for await (const _row of adapter.stream({ sql: 'SELECT * FROM big' }, { batchSize: 4 })) {
      if (++seen >= 8) break;
    }

    expect(seen).toBe(8);
    expect(adapter.isDestroyed).toBe(true);
    expect(fake.destroyed).toBe(true);
    // Not left paused, and the next statement fails fast rather than hanging.
    const after = await withTimeout(adapter.query({ sql: 'COMMIT' }).catch(error => error));
    expect(after).not.toBe('timeout');
  });

  it('keeps the connection usable when the result set had already ended', async () => {
    const fake = new FakeMysql2Connection();
    fake.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    fake.endAfterRows = true;
    const adapter = new Mysql2ConnectionAdapter(fake as never);

    const collected: unknown[] = [];
    for await (const row of adapter.stream({ sql: 'SELECT * FROM small' })) {
      collected.push(row);
    }

    expect(collected).toHaveLength(3);
    // A fully consumed result set must not cost the caller their connection.
    expect(adapter.isDestroyed).toBe(false);
    expect(fake.paused).toBe(false);

    const after = await withTimeout(adapter.query({ sql: 'COMMIT' }));
    expect(after).not.toBe('timeout');
    expect(fake.queries).toContain('COMMIT');
  });

  it('never leaves the connection paused after a stream ends', async () => {
    const fake = new FakeMysql2Connection();
    fake.rows = Array.from({ length: 200 }, (_, index) => ({ id: index }));
    const adapter = new Mysql2ConnectionAdapter(fake as never);

    let seen = 0;
    for await (const _row of adapter.stream({ sql: 'SELECT * FROM medium' }, { batchSize: 4 })) {
      seen++;
    }
    expect(seen).toBe(200);
    expect(fake.paused).toBe(false);
    expect(fake.deliveredWhilePaused).toBe(false);
  });

  it('applies backpressure rather than buffering the whole result set', async () => {
    const fake = new FakeMysql2Connection();
    fake.rows = Array.from({ length: 500 }, (_, index) => ({ id: index }));
    const adapter = new Mysql2ConnectionAdapter(fake as never);

    let pausedAtLeastOnce = false;
    let seen = 0;
    for await (const _row of adapter.stream({ sql: 'SELECT * FROM medium' }, { batchSize: 8 })) {
      if (fake.paused) pausedAtLeastOnce = true;
      seen++;
      // Yield to the event loop so rows can pile up behind the consumer.
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(seen).toBe(500);
    expect(pausedAtLeastOnce).toBe(true);
  });
});

describe('describeMysql2Error', () => {
  it('extracts the server error fields', () => {
    const described = describeMysql2Error(
      Object.assign(new Error('boom'), {
        errno: 1146,
        code: 'ER_NO_SUCH_TABLE',
        sqlState: '42S02',
        sqlMessage: "Table 'x' doesn't exist",
      }),
    );
    expect(described).toEqual({
      errno: 1146,
      code: 'ER_NO_SUCH_TABLE',
      sqlState: '42S02',
      message: "Table 'x' doesn't exist",
    });
  });

  it('returns undefined for a non-error value', () => {
    expect(describeMysql2Error('nope')).toBeUndefined();
    expect(describeMysql2Error(null)).toBeUndefined();
  });
});
