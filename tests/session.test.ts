import { describe, expect, it } from 'vitest';
import { beginMysqlDumpSession } from '../src/connection/session.js';
import { MysqlDumperError } from '../src/utils/errors.js';
import { MockMysqlConnection } from './mockConnection.js';

/** A connection that reports a plausible starting session state. */
function connection(sqlMode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'): MockMysqlConnection {
  return new MockMysqlConnection([
    { match: '@@SESSION.sql_mode', rows: [{ value: sqlMode }] },
    { match: '@@SESSION.time_zone', rows: [{ value: 'SYSTEM' }] },
    { match: '@@SESSION.character_set_client', rows: [{ value: 'latin1' }] },
  ]);
}

describe('beginMysqlDumpSession: consistency', () => {
  it('opens a consistent snapshot by default', async () => {
    const mock = connection();
    const session = await beginMysqlDumpSession(mock);
    expect(mock.executedSql).toContain('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(mock.executedSql).toContain('START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */');
    expect(session.consistency).toBe('single-transaction');
  });

  it('commits the read transaction on finish', async () => {
    // A read-only snapshot has nothing to commit, but it must still be closed
    // or the connection goes back to the pool holding a stale snapshot.
    const mock = connection();
    const session = await beginMysqlDumpSession(mock);
    await session.finish();
    expect(mock.executedSql).toContain('COMMIT');
  });

  it('takes a server-wide read lock in lock-all-tables mode', async () => {
    const mock = connection();
    const session = await beginMysqlDumpSession(mock, { consistency: 'lock-all-tables' });
    expect(mock.executedSql).toContain('FLUSH TABLES WITH READ LOCK');
    await session.finish();
    expect(mock.executedSql).toContain('UNLOCK TABLES');
  });

  it('does nothing at all in none mode', async () => {
    const mock = connection();
    const session = await beginMysqlDumpSession(mock, { consistency: 'none' });
    expect(mock.executedSql).not.toContain(
      'START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */',
    );
    expect(mock.executedSql).not.toContain('FLUSH TABLES WITH READ LOCK');
    await session.finish();
    expect(mock.executedSql).not.toContain('COMMIT');
  });

  it('reports an actionable error when the lock is refused', async () => {
    const mock = connection().respond({
      match: 'FLUSH TABLES WITH READ LOCK',
      error: new Error('Access denied; you need the RELOAD privilege'),
    });
    await expect(beginMysqlDumpSession(mock, { consistency: 'lock-all-tables' })).rejects.toThrow(
      MysqlDumperError,
    );
  });
});

describe('beginMysqlDumpSession: session variables', () => {
  it('pins the read time zone and the connection charset', async () => {
    const mock = connection();
    await beginMysqlDumpSession(mock);
    const timeZone = mock.executed.find(entry => entry.sql.includes('SET SESSION time_zone'));
    expect(timeZone?.parameters).toEqual(['+00:00']);
    expect(mock.executedSql).toContain('SET NAMES utf8mb4');
  });

  it('removes only the sql_mode flags that would break the dump', async () => {
    // ANSI_QUOTES makes SHOW CREATE TABLE emit double-quoted identifiers,
    // which no restore session in a generated dump would accept.
    const mock = connection('ANSI_QUOTES,STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES');
    await beginMysqlDumpSession(mock);
    const set = mock.executed.find(entry => entry.sql.includes('SET SESSION sql_mode'));
    expect(set?.parameters).toEqual(['STRICT_TRANS_TABLES']);
  });

  it('leaves an already-safe sql_mode untouched', async () => {
    const mock = connection('STRICT_TRANS_TABLES');
    await beginMysqlDumpSession(mock);
    expect(mock.executedSql.some(sql => sql.includes('SET SESSION sql_mode'))).toBe(false);
  });

  it('restores every changed variable on finish', async () => {
    const mock = connection('ANSI_QUOTES,STRICT_TRANS_TABLES');
    const session = await beginMysqlDumpSession(mock);
    await session.finish();
    const restores = mock.executed.filter(
      entry => entry.sql.includes('SET SESSION') || entry.sql.startsWith('SET NAMES'),
    );
    // The final three assignments put the original values back.
    expect(restores.at(-3)?.parameters).toEqual(['ANSI_QUOTES,STRICT_TRANS_TABLES']);
    expect(restores.at(-2)?.parameters).toEqual(['SYSTEM']);
    expect(restores.at(-1)?.sql).toBe('SET NAMES latin1');
  });

  it('is idempotent: finishing twice does not repeat the teardown', async () => {
    const mock = connection();
    const session = await beginMysqlDumpSession(mock);
    await session.finish();
    const afterFirst = mock.executedSql.length;
    await session.finish();
    expect(mock.executedSql).toHaveLength(afterFirst);
  });

  it('leaves the session alone when time zone and charset are null', async () => {
    const mock = connection();
    await beginMysqlDumpSession(mock, { timeZone: null, characterSet: null });
    expect(mock.executedSql.some(sql => sql.includes('SET SESSION time_zone'))).toBe(false);
    expect(mock.executedSql.some(sql => sql.startsWith('SET NAMES'))).toBe(false);
  });

  it('rejects a charset name that is not a plain identifier', async () => {
    // `SET NAMES` takes a token, not an expression, so this is the one value
    // that reaches SQL text — and it is validated before it does.
    await expect(
      beginMysqlDumpSession(connection(), { characterSet: 'utf8mb4; DROP DATABASE x' }),
    ).rejects.toThrow(MysqlDumperError);
  });

  it('binds the time zone as a parameter rather than interpolating it', async () => {
    const mock = connection();
    await beginMysqlDumpSession(mock, { timeZone: "+00:00'; DROP DATABASE x; --" });
    const set = mock.executed.find(entry => entry.sql.includes('SET SESSION time_zone'));
    expect(set?.sql).toBe('SET SESSION time_zone = ?');
    expect(set?.parameters).toEqual(["+00:00'; DROP DATABASE x; --"]);
  });
});
