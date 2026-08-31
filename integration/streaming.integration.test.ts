import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dumpMysql } from '../src/api/dump.js';
import type { MysqlRow } from '../src/connection/types.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { parseSqlStatements } from '../src/restore/statementParser.js';
import {
  createTestDatabase,
  dropDatabaseIfExists,
  execStatements,
  probeServer,
  selectedTargets,
} from './helpers/server.js';
import type { ServerTarget, TestDatabase } from './helpers/server.js';

/**
 * Rows in the large table.
 *
 * Kept modest and made *wide* instead: 65,536 rows of ~200 bytes is ~14 MB of
 * dump, which is plenty to expose buffering, while the table itself builds in
 * seconds. Row count is reached by repeated doubling rather than a recursive
 * CTE so this also runs on MySQL 5.7.
 */
const LARGE_ROW_COUNT = 65_536;

/** Cap used for the dump under test; also the bound asserted on every chunk. */
const STATEMENT_CAP = 256 * 1024;

/**
 * Memory and streaming behaviour on a table too large to hold in memory.
 *
 * Assertions are structural wherever possible — chunk sizes, statement sizes,
 * row counts — because heap sampling is noisy. The heap assertions are
 * generous enough not to flake, but "the whole thing was buffered" fails them.
 */
describe.each(selectedTargets())('streaming: $label', (target: ServerTarget) => {
  let available = false;
  let source: TestDatabase | null = null;
  let dump: Buffer | null = null;
  const scratch: TestDatabase[] = [];

  beforeAll(async () => {
    available = (await probeServer(target)).available;
    if (!available) return;

    source = await createTestDatabase(target, `stream_${target.id}_src`);
    scratch.push(source);
    await execStatements(source.connection, [
      `CREATE TABLE \`big\` (
         \`id\` int NOT NULL AUTO_INCREMENT,
         \`payload\` varchar(200) NOT NULL,
         \`amount\` decimal(20,6) NOT NULL,
         PRIMARY KEY (\`id\`)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `INSERT INTO \`big\` (\`payload\`,\`amount\`) VALUES ('${'padding '.repeat(20)}✓',1.5)`,
    ]);
    while ((await countRows(source)) < LARGE_ROW_COUNT) {
      await source.connection.query(
        { sql: 'INSERT INTO `big` (`payload`,`amount`) SELECT `payload`, `amount` FROM `big`' },
        undefined,
        'native',
      );
    }
  }, 300_000);

  afterAll(async () => {
    for (const database of scratch) {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    }
  });

  async function countRows(database: TestDatabase): Promise<number> {
    const result = await database.connection.query<MysqlRow>(
      { sql: 'SELECT COUNT(*) AS n FROM `big`' },
      undefined,
      'native',
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it('dumps a large table without buffering it', async () => {
    if (!available) return;
    const database = source as TestDatabase;

    const chunks: Buffer[] = [];
    let bytes = 0;
    let largestChunk = 0;
    let peakHeap = 0;
    const baseline = process.memoryUsage().heapUsed;

    const collecting = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        bytes += chunk.length;
        largestChunk = Math.max(largestChunk, chunk.length);
        if (chunks.length % 16 === 0) {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }
        callback();
      },
    });

    const result = await dumpMysql(
      database.connection,
      {
        databaseName: database.name,
        render: { includeTimestamp: false },
        dataExport: { maxStatementBytes: STATEMENT_CAP },
      },
      collecting,
    );
    dump = Buffer.concat(chunks);

    expect(result.rowsExported).toBeGreaterThanOrEqual(LARGE_ROW_COUNT);
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    // Many statements, not one giant one.
    expect(result.statementsWritten).toBeGreaterThan(20);
    // A statement is written as a single chunk, so no chunk may exceed the cap
    // by more than the statement prefix and terminator.
    expect(largestChunk).toBeLessThanOrEqual(STATEMENT_CAP + 4096);

    // The dump is streamed, so the *export* pipeline must not grow with the
    // table's size. The collector itself retains everything (that is the test
    // harness, not the library), so the bound accounts for it.
    const growth = Math.max(0, peakHeap - baseline);
    expect(growth, `heap grew ${growth} bytes while writing ${bytes}`).toBeLessThan(
      bytes * 2 + 32 * 1024 * 1024,
    );
  }, 600_000);

  it('keeps every generated INSERT under the configured cap', async () => {
    if (!available) return;
    const inserts = parseSqlStatements(dump as Buffer).filter(statement =>
      statement.sql.includes('INSERT INTO'),
    );
    expect(inserts.length).toBeGreaterThan(20);
    for (const statement of inserts) {
      expect(Buffer.byteLength(statement.sql, 'utf8')).toBeLessThanOrEqual(STATEMENT_CAP + 4096);
    }
  });

  it('restores a large dump without buffering it', async () => {
    if (!available) return;
    const database = source as TestDatabase;
    const restored = await createTestDatabase(target, `stream_${target.id}_tgt`);
    scratch.push(restored);

    const bytes = dump as Buffer;
    const baseline = process.memoryUsage().heapUsed;
    let peakHeap = 0;
    let sampled = 0;

    // Fed in small pieces, the way a file read stream would.
    async function* pieces(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    }

    const result = await restoreSqlDump({
      connection: restored.connection,
      source: pieces(),
      options: { databaseName: restored.name },
      progress: () => {
        if (++sampled % 64 === 0) {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }
      },
    });

    expect(result.errors.map(error => error.message)).toEqual([]);
    expect(result.bytesConsumed).toBe(bytes.length);
    expect(await countRows(restored)).toBe(await countRows(database));

    // Only one statement is held at a time, so restoring a 14 MB dump must not
    // cost anything like 14 MB of retained heap.
    const growth = Math.max(0, peakHeap - baseline);
    expect(growth, `heap grew ${growth} bytes restoring ${bytes.length}`).toBeLessThan(
      bytes.length + 32 * 1024 * 1024,
    );
  }, 900_000);

  it('cancels a long dump promptly and leaves the data intact', async () => {
    if (!available) return;
    const database = source as TestDatabase;
    const controller = new AbortController();

    let bytes = 0;
    const aborting = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        // Abort well into the data, not at the very start.
        if (bytes > 256 * 1024) controller.abort();
        callback();
      },
    });

    const started = Date.now();
    const result = await dumpMysql(
      database.connection,
      { databaseName: database.name, render: { includeTimestamp: false } },
      aborting,
      undefined,
      controller.signal,
    );
    const elapsed = Date.now() - started;

    expect(result.cancelled).toBe(true);
    // Stopped early: nowhere near the whole table was written, and quickly.
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    expect(elapsed, `cancellation took ${elapsed}ms`).toBeLessThan(60_000);

    // Cancelling a stream destroys the connection — MySQL has no in-band
    // cancellation — so a fresh one must still see the source intact.
    const { openConnection } = await import('./helpers/server.js');
    const reopened = await openConnection(target, database.name);
    try {
      const check = await reopened.connection.query<MysqlRow>(
        { sql: 'SELECT COUNT(*) AS n FROM `big`' },
        undefined,
        'native',
      );
      expect(Number(check.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(LARGE_ROW_COUNT);
    } finally {
      await reopened.close();
    }
  }, 300_000);
});
