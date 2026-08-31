import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectMysql } from '../src/introspection/introspect.js';
import { preflightRestore } from '../src/preflight/preflightRestore.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { isMysqlDump } from '../src/restore/preview.js';
import type { MysqlRow } from '../src/connection/types.js';
import type { DumpProgressEvent } from '../src/utils/progress.js';
import { dumpToBuffer, naivelySplitOnSemicolons } from './helpers/dump.js';
import { createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import {
  createTestDatabase,
  dropDatabaseIfExists,
  execStatements,
  nativeMysqlRestore,
  probeServer,
  selectedTargets,
} from './helpers/server.js';
import type { ServerTarget, TestDatabase } from './helpers/server.js';

/**
 * Behaviour that needs a live server but is not part of the interoperability
 * matrix: dump modes, AUTO_INCREMENT semantics, session hygiene, streaming,
 * cancellation, and the diagnostics a real database produces.
 */
describe.each(selectedTargets())('behaviour: $label', (target: ServerTarget) => {
  let available = false;
  let fixture: FixtureDatabases | null = null;
  const scratchDatabases: TestDatabase[] = [];

  beforeAll(async () => {
    available = (await probeServer(target)).available;
    if (!available) return;
    fixture = await createFixtureDatabases(target, `behaviour_${target.id}`);
  });

  afterAll(async () => {
    for (const database of scratchDatabases) {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    }
    await fixture?.dispose();
  });

  async function freshTarget(name: string): Promise<TestDatabase> {
    const database = await createTestDatabase(target, `behaviour_${target.id}_${name}`);
    scratchDatabases.push(database);
    return database;
  }

  function source(): FixtureDatabases {
    return fixture as FixtureDatabases;
  }

  async function scalar(database: TestDatabase, sql: string): Promise<string | null> {
    const result = await database.connection.query<MysqlRow>({ sql }, undefined, 'raw');
    const value = Object.values(result.rows[0] ?? {})[0];
    return value === null || value === undefined
      ? null
      : Buffer.isBuffer(value)
        ? value.toString('utf8')
        : String(value);
  }

  describe('dump modes', () => {
    it('schema-only omits row data but keeps every object', async () => {
      if (!available) return;
      const { text, result } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        mode: 'schema-only',
        render: { includeTimestamp: false },
      });
      expect(result.rowsExported).toBe(0);
      expect(text).toContain('CREATE TABLE `books`');
      expect(text).toContain('CREATE DEFINER=');
      expect(text).not.toMatch(/^INSERT INTO/m);
      // Even the data frame is gone, exactly as `mysqldump --no-data`.
      expect(text).not.toContain('LOCK TABLES `books` WRITE');
    });

    it('data-only keeps rows but no definitions', async () => {
      if (!available) return;
      const { text, result } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        mode: 'data-only',
        render: { includeTimestamp: false },
      });
      expect(result.rowsExported).toBeGreaterThan(0);
      expect(text).toMatch(/^INSERT INTO `books`/m);
      expect(text).not.toContain('CREATE TABLE');
      expect(text).not.toContain('CREATE VIEW');
    });

    it('a schema-only dump restores into an empty database', async () => {
      if (!available) return;
      const restored = await freshTarget('schemaonly');
      const { sql } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        mode: 'schema-only',
        render: { includeTimestamp: false },
      });
      const result = await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });
      expect(result.errors).toEqual([]);
      expect(await scalar(restored, 'SELECT COUNT(*) FROM `books`')).toBe('0');
      const introspection = await introspectMysql(restored.connection);
      expect(introspection.database.tables.map(t => t.pureName)).toEqual(
        source().sourceIntrospection.database.tables.map(t => t.pureName),
      );
    });

    it('honors a table selection', async () => {
      if (!available) return;
      const { text } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        selection: { tables: ['authors'] },
        objectKinds: { includeViews: false, includeRoutines: false, includeEvents: false },
        render: { includeTimestamp: false },
      });
      expect(text).toContain('CREATE TABLE `authors`');
      expect(text).not.toContain('CREATE TABLE `books`');
    });

    it('dumps structure but not rows for a data-excluded table', async () => {
      if (!available) return;
      const { text } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        selection: { dataExcludedTables: ['books'] },
        render: { includeTimestamp: false },
      });
      expect(text).toContain('CREATE TABLE `books`');
      expect(text).not.toMatch(/^INSERT INTO `books`/m);
      expect(text).toMatch(/^INSERT INTO `authors`/m);
    });
  });

  describe('AUTO_INCREMENT', () => {
    it('preserves the next generated id across a restore', async () => {
      if (!available) return;
      const restored = await freshTarget('autoinc');
      const { sql } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });

      // A table with a gap: ids 1, 2, 7, 9 plus one generated. The next id
      // must come from the table's stored counter, not from max(id)+1.
      await execStatements(restored.connection, [
        "INSERT INTO `authors` (`name`) VALUES ('after restore')",
      ]);
      const sourceNext = await scalar(source().source, 'SELECT MAX(`id`) FROM `authors`');
      const restoredNext = await scalar(restored, 'SELECT MAX(`id`) FROM `authors`');
      expect(Number(restoredNext)).toBe(Number(sourceNext) + 1);
    });

    it('preserves an AUTO_INCREMENT beyond 2^53 exactly', async () => {
      if (!available) return;
      const restored = await freshTarget('bigcounter');
      const { sql } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });

      // 9007199254740995 is past JavaScript's exact-integer range; a value
      // routed through a JS number would come back rounded.
      await execStatements(restored.connection, [
        "INSERT INTO `big_counter` (`label`) VALUES ('generated')",
      ]);
      expect(
        await scalar(restored, "SELECT `id` FROM `big_counter` WHERE `label`='generated'"),
      ).toBe('9007199254740995');
    });

    it('preserves an empty table AUTO_INCREMENT', async () => {
      if (!available) return;
      const restored = await freshTarget('emptyautoinc');
      const { sql } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });
      await execStatements(restored.connection, [
        "INSERT INTO `empty_with_autoinc` (`note`) VALUES ('first')",
      ]);
      expect(await scalar(restored, 'SELECT `id` FROM `empty_with_autoinc`')).toBe('4242');
    });
  });

  describe('session hygiene', () => {
    it('leaves the dump connection session variables untouched', async () => {
      if (!available) return;
      const before = {
        sqlMode: await scalar(source().source, 'SELECT @@SESSION.sql_mode'),
        timeZone: await scalar(source().source, 'SELECT @@SESSION.time_zone'),
        charset: await scalar(source().source, 'SELECT @@SESSION.character_set_client'),
      };
      await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      expect({
        sqlMode: await scalar(source().source, 'SELECT @@SESSION.sql_mode'),
        timeZone: await scalar(source().source, 'SELECT @@SESSION.time_zone'),
        charset: await scalar(source().source, 'SELECT @@SESSION.character_set_client'),
      }).toEqual(before);
    });

    it('leaves FOREIGN_KEY_CHECKS on after a restore that fails midway', async () => {
      if (!available) return;
      const restored = await freshTarget('sessionleak');
      const dump = [
        '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
        'CREATE TABLE `ok` (`id` int);',
        'THIS IS NOT SQL;',
      ].join('\n');

      const result = await restoreSqlDump({
        connection: restored.connection,
        source: dump,
        options: { databaseName: restored.name },
      });
      expect(result.statementsFailed).toBe(1);
      // Without cleanup the caller's connection would go back to their pool
      // with referential integrity silently switched off.
      expect(await scalar(restored, 'SELECT @@SESSION.foreign_key_checks')).toBe('1');
    });
  });

  describe('diagnostics', () => {
    it('warns that a MyISAM table is not covered by the snapshot', async () => {
      if (!available) return;
      const { result } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        mode: 'schema-only',
        render: { includeTimestamp: false },
      });
      const warning = result.warnings.find(
        w => w.code === 'nontransactional-table-not-snapshot-consistent',
      );
      expect(warning?.objectReference?.name).toBe('myisam_notes');
    });

    it('warns that a table without a primary key reads unordered', async () => {
      if (!available) return;
      const { result } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      const codes = result.warnings.map(warning => warning.code);
      expect(codes).toContain('unordered-table-read');
      expect(codes).toContain('generated-column-not-exported');
      expect(codes).toContain('definer-preserved');
    });
  });

  describe('preflight', () => {
    it('reports the target version, packet size and sql_mode', async () => {
      if (!available) return;
      const report = await preflightRestore({
        connection: source().source.connection,
        database: source().sourceIntrospection.database,
      });
      expect(report.targetVersion.flavor).toBe('mysql');
      expect(report.maxAllowedPacket).toBeGreaterThan(0);
      expect(report.sqlMode).toBeDefined();
      // The source is the target here, so nothing can be unsupported.
      expect(report.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });
  });

  describe('streaming and cancellation', () => {
    it('reports progress through every phase', async () => {
      if (!available) return;
      const events: DumpProgressEvent[] = [];
      await dumpToBuffer(
        source().source.connection,
        { databaseName: source().source.name, render: { includeTimestamp: false } },
        event => events.push(event),
      );
      const phases = new Set(events.map(event => event.phase));
      expect(phases).toContain('connecting');
      expect(phases).toContain('introspecting');
      expect(phases).toContain('planning-archive');
      expect(phases).toContain('rendering-schema');
      expect(phases).toContain('exporting-data');
      expect(phases).toContain('finalizing');

      const dataEvent = events.find(event => event.exportState === 'finished');
      expect(dataEvent?.tableName).toBeDefined();
      expect(dataEvent?.bytesWritten).toBeGreaterThan(0);
    });

    it('stops cleanly when cancelled and releases the connection', async () => {
      if (!available) return;
      const controller = new AbortController();
      const events: DumpProgressEvent[] = [];
      const dump = dumpToBuffer(
        source().source.connection,
        { databaseName: source().source.name, render: { includeTimestamp: false } },
        event => {
          events.push(event);
          // Abort as soon as rendering starts, mid-dump.
          if (event.phase === 'rendering-schema') controller.abort();
        },
        controller.signal,
      );
      const { result } = await dump;
      expect(result.cancelled).toBe(true);

      // The connection must still be usable: the session teardown runs even
      // on the cancellation path.
      expect(await scalar(source().source, 'SELECT 1')).toBe('1');
    });
  });

  describe('why a real lexer is required', () => {
    it('produces dumps a naive semicolon splitter would tear apart', async () => {
      if (!available) return;
      const { text } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });

      // A `split(';')` cuts the procedure body — whose statements each end in
      // `;` — into fragments that are not valid SQL on their own.
      const naive = naivelySplitOnSemicolons(text);
      expect(naive.some(part => part.includes('DECLARE `v_tmp` INT DEFAULT 0'))).toBe(true);
      expect(naive.some(part => part.trim().startsWith('END'))).toBe(true);

      // The real parser keeps it in one piece.
      expect(text).toContain('DELIMITER ;;');
      expect(isMysqlDump(text)).toBe(true);
    });

    it('restores such a dump through the native client too', async () => {
      if (!available) return;
      const restored = await freshTarget('naiveproof');
      const { sql } = await dumpToBuffer(source().source.connection, {
        databaseName: source().source.name,
        render: { includeTimestamp: false },
      });
      await nativeMysqlRestore(target, restored.name, sql);
      expect(
        await scalar(
          restored,
          'SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()',
        ),
      ).toBe('2');
    });
  });
});
