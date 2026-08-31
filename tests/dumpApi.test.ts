import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dumpMysql } from '../src/api/dump.js';
import { MysqlDumperError } from '../src/utils/errors.js';
import { MockMysqlConnection } from './mockConnection.js';

/** Discards everything written to it. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('dumpMysql: output character set', () => {
  /**
   * Regression: `render.characterSet` was passed straight into the read
   * session's `SET NAMES`, which sets `character_set_results`. Row values are
   * read as raw bytes and decoded as UTF-8, so a non-UTF-8 session charset
   * turned every non-ASCII character into U+FFFD — silent, permanent data
   * corruption. The dump also declared a charset its own bytes did not use.
   *
   * The read session is now always pinned to utf8mb4, and a charset the
   * writer cannot honestly declare is refused before any work is done.
   */
  it('refuses a character set the writer cannot emit', async () => {
    const connection = new MockMysqlConnection();
    await expect(
      dumpMysql(connection, { render: { characterSet: 'latin1' } }, sink()),
    ).rejects.toThrow(MysqlDumperError);
    await expect(
      dumpMysql(connection, { render: { characterSet: 'latin1' } }, sink()),
    ).rejects.toThrow(/written as UTF-8 bytes/);
  });

  it('refuses before touching the connection at all', async () => {
    const connection = new MockMysqlConnection();
    await expect(
      dumpMysql(connection, { render: { characterSet: 'cp1250' } }, sink()),
    ).rejects.toThrow(MysqlDumperError);
    // Nothing ran: the guard is a precondition, not a mid-dump failure that
    // would leave a half-written file.
    expect(connection.executedSql).toEqual([]);
  });

  it('accepts the UTF-8 family', async () => {
    for (const characterSet of ['utf8mb4', 'utf8mb3', 'utf8', 'UTF8MB4']) {
      const connection = new MockMysqlConnection([
        { match: 'VERSION()', rows: [{ versionString: '8.0.36', versionComment: 'MySQL' }] },
      ]);
      // Fails later for want of a real catalog, but never with the charset guard.
      await expect(dumpMysql(connection, { render: { characterSet } }, sink())).rejects.not.toThrow(
        /written as UTF-8 bytes/,
      );
    }
  });

  it('pins the read session to utf8mb4 regardless of the declared charset', async () => {
    const connection = new MockMysqlConnection([
      { match: '@@SESSION.sql_mode', rows: [{ value: '' }] },
      { match: '@@SESSION.time_zone', rows: [{ value: 'SYSTEM' }] },
      { match: '@@SESSION.character_set_client', rows: [{ value: 'utf8mb4' }] },
      { match: 'VERSION()', rows: [{ versionString: '8.0.36', versionComment: 'MySQL' }] },
    ]);
    await dumpMysql(connection, { render: { characterSet: 'utf8mb3' } }, sink()).catch(() => {});
    expect(connection.executedSql).toContain('SET NAMES utf8mb4');
    expect(connection.executedSql).not.toContain('SET NAMES utf8mb3');
  });
});
