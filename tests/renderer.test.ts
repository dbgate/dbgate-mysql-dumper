import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import type { MysqlDatabase } from '../src/model/database.js';
import { renderPlainSql } from '../src/renderer/plainSql.js';
import type { PlainSqlRenderOptions } from '../src/renderer/types.js';
import { executableComment, executableCommentTight } from '../src/renderer/versionGates.js';
import { toPortableSqlMode } from '../src/renderer/sqlMode.js';
import { applyDefinerPolicy, hasDefinerClause } from '../src/renderer/definer.js';
import { BufferDumpWriter } from '../src/writer/bufferWriter.js';
import {
  makeDatabase,
  makeEvent,
  makeRoutine,
  makeTable,
  makeTrigger,
  makeView,
} from './fixtures.js';

async function render(
  database: MysqlDatabase,
  options?: PlainSqlRenderOptions,
  archiveOptions?: Parameters<typeof inspectDumpArchive>[1],
): Promise<{ sql: string; warnings: string[] }> {
  const archive = inspectDumpArchive(database, archiveOptions);
  const writer = new BufferDumpWriter();
  const result = await renderPlainSql({
    database,
    archive,
    writer,
    options: { includeTimestamp: false, ...options },
    // Row data is the data layer's job; the renderer only frames it.
    onTableData: async () => true,
  });
  return { sql: writer.toString(), warnings: result.warnings.map(warning => warning.code) };
}

const simple = makeDatabase({ tables: [makeTable({ pureName: 't' })] });

describe('renderPlainSql: header and footer', () => {
  it('writes the mysqldump header block', async () => {
    const { sql } = await render(simple);
    const lines = sql.split('\n');
    expect(lines[0]).toMatch(/^-- MySQL dump 10\.13 {2}Distrib /);
    expect(lines[1]).toBe('--');
    expect(lines[2]).toBe('-- Host: localhost    Database: testdb');
    expect(lines[3]).toBe('-- ------------------------------------------------------');
    expect(lines[4]).toMatch(/^-- Server version\t/);
  });

  it('emits the session guards in mysqldump order', async () => {
    const { sql } = await render(simple);
    const guards = sql.split('\n').filter(line => line.startsWith('/*!4'));
    // The nine header guards, in order. `SET NAMES` is gated at 5.5.3 for
    // utf8mb4 rather than 4.1.1, so it is asserted separately below.
    expect(guards.slice(0, 9)).toEqual([
      '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
      '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
      '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
      '/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;',
      "/*!40103 SET TIME_ZONE='+00:00' */;",
      '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
      '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
      "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
      '/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;',
    ]);
  });

  it('gates SET NAMES utf8mb4 at 5.5.3, where utf8mb4 was introduced', async () => {
    const { sql } = await render(simple);
    expect(sql).toContain('/*!50503 SET NAMES utf8mb4 */;');
    const { sql: latin1 } = await render(simple, { characterSet: 'latin1' });
    expect(latin1).toContain('/*!40101 SET NAMES latin1 */;');
  });

  it('restores every guard in the footer', async () => {
    const { sql } = await render(simple);
    expect(sql).toContain('/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;');
    expect(sql).toContain('/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;');
    expect(sql).toContain('/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;');
    expect(sql).toContain('/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;');
    expect(sql).toContain('/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;');
    expect(sql.trimEnd().endsWith('-- Dump completed')).toBe(true);
  });

  it('warns loudly when session guards are turned off', async () => {
    const { sql, warnings } = await render(simple, { includeSessionGuards: false });
    expect(warnings).toContain('session-guards-disabled');
    expect(sql).not.toContain('FOREIGN_KEY_CHECKS');
  });

  it('omits the charset guards when setCharset is off', async () => {
    const { sql } = await render(simple, { setCharset: false });
    expect(sql).not.toContain('SET NAMES');
    expect(sql).not.toContain('@OLD_CHARACTER_SET_CLIENT');
    // The remaining guards stay, exactly as `mysqldump --skip-set-charset`.
    expect(sql).toContain('FOREIGN_KEY_CHECKS=0');
  });
});

describe('renderPlainSql: table structure', () => {
  it('writes the banner, DROP, charset guard and CREATE', async () => {
    const { sql } = await render(simple);
    expect(sql).toContain(
      [
        '--',
        '-- Table structure for table `t`',
        '--',
        '',
        'DROP TABLE IF EXISTS `t`;',
        '/*!40101 SET @saved_cs_client     = @@character_set_client */;',
        '/*!50503 SET character_set_client = utf8mb4 */;',
        'CREATE TABLE `t` (',
        '  `id` int NOT NULL',
        ') ENGINE=InnoDB;',
        '/*!40101 SET character_set_client = @saved_cs_client */;',
      ].join('\n'),
    );
  });

  it('omits DROP TABLE when addDropTable is off', async () => {
    const { sql } = await render(simple, { addDropTable: false });
    expect(sql).not.toContain('DROP TABLE IF EXISTS');
  });

  it('frames data with LOCK TABLES and DISABLE KEYS, even for an empty table', async () => {
    const { sql } = await render(simple);
    expect(sql).toContain(
      [
        'LOCK TABLES `t` WRITE;',
        '/*!40000 ALTER TABLE `t` DISABLE KEYS */;',
        '/*!40000 ALTER TABLE `t` ENABLE KEYS */;',
        'UNLOCK TABLES;',
      ].join('\n'),
    );
  });

  it('drops the lock and key statements when the options are off', async () => {
    const { sql } = await render(simple, { addLocks: false, disableKeys: false });
    expect(sql).not.toContain('LOCK TABLES');
    expect(sql).not.toContain('DISABLE KEYS');
    // The banner remains, as it does for `mysqldump --skip-add-locks`.
    expect(sql).toContain('-- Dumping data for table `t`');
  });
});

describe('renderPlainSql: views', () => {
  const withViews = makeDatabase({
    views: [makeView({ pureName: 'v', columnNames: ['id', 'title'] })],
  });

  it('writes a stub view with the real column names', async () => {
    const { sql } = await render(withViews);
    expect(sql).toContain(
      [
        'DROP TABLE IF EXISTS `v`;',
        '/*!50001 DROP VIEW IF EXISTS `v`*/;',
        'SET @saved_cs_client     = @@character_set_client;',
        '/*!50503 SET character_set_client = utf8mb4 */;',
        '/*!50001 CREATE VIEW `v` AS SELECT ',
        ' 1 AS `id`,',
        ' 1 AS `title`*/;',
        'SET character_set_client = @saved_cs_client;',
      ].join('\n'),
    );
  });

  it('splits the real definition into separately gated fragments', async () => {
    // A server older than 5.0.13 skips only the DEFINER fragment and still
    // creates the view.
    const { sql } = await render(withViews);
    expect(sql).toContain('/*!50001 CREATE ALGORITHM=UNDEFINED */\n');
    expect(sql).toContain('/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */\n');
    expect(sql).toContain('/*!50001 VIEW `v` AS select 1 AS `x` */;');
  });
});

describe('renderPlainSql: stored programs', () => {
  it('wraps a trigger in a DELIMITER region with its creation context', async () => {
    const database = makeDatabase({
      tables: [makeTable({ pureName: 't' })],
      triggers: [makeTrigger({ triggerName: 'trg', tableName: 't' })],
    });
    const { sql } = await render(database);
    expect(sql).toContain('/*!50003 SET @saved_cs_client      = @@character_set_client */ ;');
    expect(sql).toContain(
      "/*!50003 SET sql_mode              = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION' */ ;",
    );
    expect(sql).toContain('DELIMITER ;;\n/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/');
    expect(sql).toContain('END */;;\nDELIMITER ;');
    expect(sql).toContain('/*!50003 SET sql_mode              = @saved_sql_mode */ ;');
  });

  it('emits a routine unwrapped, with only its DROP gated', async () => {
    const database = makeDatabase({
      routines: [makeRoutine({ pureName: 'sp', kind: 'PROCEDURE' })],
    });
    const { sql } = await render(database);
    expect(sql).toContain("-- Dumping routines for database 'testdb'");
    expect(sql).toContain('/*!50003 DROP PROCEDURE IF EXISTS `sp` */;');
    expect(sql).toContain('DELIMITER ;;\nCREATE DEFINER=`root`@`localhost` PROCEDURE `sp`()');
    expect(sql).toContain('END ;;\nDELIMITER ;');
  });

  it('wraps the events section in a time-zone save and restore', async () => {
    const database = makeDatabase({ events: [makeEvent({ eventName: 'ev' })] });
    const { sql } = await render(database);
    expect(sql).toContain(
      "-- Dumping events for database 'testdb'\n--\n/*!50106 SET @save_time_zone= @@TIME_ZONE */ ;",
    );
    expect(sql).toContain('/*!50106 DROP EVENT IF EXISTS `ev` */;');
    expect(sql).toContain("/*!50003 SET time_zone             = 'SYSTEM' */ ;;");
    expect(sql).toContain(
      '/*!50106 CREATE*/ /*!50117 DEFINER=`root`@`localhost`*/ /*!50106 EVENT `ev`',
    );
    expect(sql).toContain('/*!50106 SET TIME_ZONE= @save_time_zone */ ;');
  });

  it('emits the routines banner once for several routines', async () => {
    const database = makeDatabase({
      routines: [
        makeRoutine({ pureName: 'a', kind: 'FUNCTION' }),
        makeRoutine({ pureName: 'b', kind: 'PROCEDURE' }),
      ],
    });
    const { sql } = await render(database);
    expect(sql.split("-- Dumping routines for database 'testdb'")).toHaveLength(2);
  });
});

describe('renderPlainSql: database statements', () => {
  it('emits CREATE DATABASE and USE when asked', async () => {
    const { sql } = await render(
      simple,
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).toContain('-- Current Database: `testdb`');
    expect(sql).toContain(
      "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `testdb` /*!40100 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci */ /*!80016 DEFAULT ENCRYPTION='N' */;",
    );
    expect(sql).toContain('USE `testdb`;');
  });

  it('emits neither by default', async () => {
    const { sql } = await render(simple);
    expect(sql).not.toContain('CREATE DATABASE');
    expect(sql).not.toContain('USE `testdb`');
  });
});

describe('renderPlainSql: definer policy', () => {
  const withRoutine = makeDatabase({
    routines: [makeRoutine({ pureName: 'sp', kind: 'PROCEDURE' })],
  });

  it('preserves the definer by default, and says so', async () => {
    const { sql, warnings } = await render(withRoutine);
    expect(sql).toContain('CREATE DEFINER=`root`@`localhost` PROCEDURE');
    expect(warnings).toContain('definer-preserved');
  });

  it('strips the definer when asked', async () => {
    const { sql } = await render(withRoutine, { definerPolicy: 'strip' });
    expect(sql).toContain('CREATE PROCEDURE `sp`()');
    expect(sql).not.toContain('DEFINER=`root`');
  });

  it('rewrites the definer to CURRENT_USER when asked', async () => {
    const { sql } = await render(withRoutine, { definerPolicy: 'current-user' });
    expect(sql).toContain('CREATE DEFINER=CURRENT_USER PROCEDURE');
  });
});

describe('applyDefinerPolicy', () => {
  const sql = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() BEGIN END';

  it('detects a definer clause', () => {
    expect(hasDefinerClause(sql)).toBe(true);
    expect(hasDefinerClause('CREATE PROCEDURE `p`() BEGIN END')).toBe(false);
  });

  it('handles an account name containing a backtick', () => {
    const odd = 'CREATE DEFINER=`ro``ot`@`local``host` PROCEDURE `p`() BEGIN END';
    expect(hasDefinerClause(odd)).toBe(true);
    expect(applyDefinerPolicy(odd, 'strip')).toBe('CREATE PROCEDURE `p`() BEGIN END');
  });

  it('leaves the statement alone for preserve and best-effort', () => {
    expect(applyDefinerPolicy(sql, 'preserve')).toBe(sql);
    expect(applyDefinerPolicy(sql, 'best-effort')).toBe(sql);
  });
});

describe('executable comments', () => {
  it('pads the version to five digits, which MySQL requires', () => {
    expect(executableComment(40101, 'SET x=1')).toBe('/*!40101 SET x=1 */');
    expect(executableComment(1, 'X')).toBe('/*!00001 X */');
  });

  it('has a tight form matching mysqldump view statements', () => {
    expect(executableCommentTight(50001, 'DROP VIEW IF EXISTS `v`')).toBe(
      '/*!50001 DROP VIEW IF EXISTS `v`*/',
    );
  });
});

describe('toPortableSqlMode', () => {
  it('drops modes MySQL 8.0 removed so a 5.7 dump restores on 8.0', () => {
    const { sqlMode, removed } = toPortableSqlMode(
      'ONLY_FULL_GROUP_BY,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION',
      'portable',
    );
    expect(sqlMode).toBe('ONLY_FULL_GROUP_BY,NO_ENGINE_SUBSTITUTION');
    expect(removed).toEqual(['NO_AUTO_CREATE_USER']);
  });

  it('keeps everything under preserve', () => {
    const value = 'ONLY_FULL_GROUP_BY,NO_AUTO_CREATE_USER';
    expect(toPortableSqlMode(value, 'preserve').sqlMode).toBe(value);
  });

  it('handles an empty or null mode', () => {
    expect(toPortableSqlMode(null, 'portable').sqlMode).toBe('');
    expect(toPortableSqlMode('', 'portable').sqlMode).toBe('');
  });

  it('leaves a mode 8.0 still supports alone', () => {
    expect(toPortableSqlMode('ANSI_QUOTES,PIPES_AS_CONCAT', 'portable').sqlMode).toBe(
      'ANSI_QUOTES,PIPES_AS_CONCAT',
    );
  });
});

describe('renderPlainSql: determinism', () => {
  it('produces identical bytes for identical input', async () => {
    const database = makeDatabase({
      tables: [makeTable({ pureName: 'b' }), makeTable({ pureName: 'a' })],
      views: [makeView({ pureName: 'v' })],
      routines: [makeRoutine({ pureName: 'r', kind: 'FUNCTION' })],
      events: [makeEvent({ eventName: 'e' })],
    });
    const first = await render(database);
    const second = await render(database);
    expect(first.sql).toBe(second.sql);
  });
});

describe('renderPlainSql: CREATE DATABASE encryption clause', () => {
  /**
   * Regression: `information_schema.SCHEMATA.DEFAULT_ENCRYPTION` reports
   * `'YES'`/`'NO'`, but `CREATE DATABASE ... DEFAULT ENCRYPTION` accepts only
   * `'Y'`/`'N'`. Emitting the catalog value verbatim made MySQL reject the
   * statement with `ER_WRONG_VALUE_FOR_VAR` (1525, "Incorrect argument
   * (should be Y or N) value: 'NO'"), so a dump taken with
   * `includeCreateDatabase` would not restore at all — through native `mysql`
   * or through this package.
   */
  it("renders the catalog's NO as N, matching mysqldump", async () => {
    const { sql } = await render(
      makeDatabase({ defaultEncryption: 'NO', tables: [makeTable({ pureName: 't' })] }),
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).toContain("/*!80016 DEFAULT ENCRYPTION='N' */");
    expect(sql).not.toContain("ENCRYPTION='NO'");
  });

  it("renders the catalog's YES as Y", async () => {
    const { sql } = await render(
      makeDatabase({ defaultEncryption: 'YES', tables: [makeTable({ pureName: 't' })] }),
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).toContain("/*!80016 DEFAULT ENCRYPTION='Y' */");
  });

  it('passes the already-short form through unchanged', async () => {
    const { sql } = await render(
      makeDatabase({ defaultEncryption: 'N', tables: [makeTable({ pureName: 't' })] }),
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).toContain("/*!80016 DEFAULT ENCRYPTION='N' */");
  });

  it('omits the clause entirely for an unrecognized value', async () => {
    // Omitting is recoverable — the database inherits the server default —
    // whereas an invalid clause makes the whole dump unrestorable.
    const { sql } = await render(
      makeDatabase({ defaultEncryption: 'MAYBE', tables: [makeTable({ pureName: 't' })] }),
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).not.toContain('DEFAULT ENCRYPTION');
    expect(sql).toContain('CREATE DATABASE');
  });

  it('omits the clause when the server does not report encryption', async () => {
    const { sql } = await render(
      makeDatabase({ defaultEncryption: null, tables: [makeTable({ pureName: 't' })] }),
      { includeCreateDatabase: true },
      { includeDatabaseEntry: true },
    );
    expect(sql).not.toContain('DEFAULT ENCRYPTION');
  });
});

describe('renderPlainSql: empty section banners', () => {
  /**
   * Regression: `mysqldump` emits the events and routines banners because
   * `--events`/`--routines` were given, **not** because the database has any —
   * verified against MySQL 8.0. Emitting them only when an object existed made
   * a dump of an event-free database differ structurally from native output.
   */
  it('emits both banners for a database with no routines and no events', async () => {
    const { sql } = await render(simple);
    expect(sql).toContain("-- Dumping events for database 'testdb'");
    expect(sql).toContain("-- Dumping routines for database 'testdb'");
  });

  it('places an empty events banner before the routines banner', async () => {
    const { sql } = await render(simple);
    expect(sql.indexOf('Dumping events')).toBeLessThan(sql.indexOf('Dumping routines'));
  });

  it('omits a banner when that kind was not requested', async () => {
    const archive = inspectDumpArchive(simple, {
      objectKinds: { includeEvents: false, includeRoutines: false },
    });
    const writer = new BufferDumpWriter();
    await renderPlainSql({
      database: simple,
      archive,
      writer,
      options: { includeTimestamp: false },
      includedKinds: { events: false, routines: false },
      onTableData: async () => true,
    });
    const sql = writer.toString();
    expect(sql).not.toContain('Dumping events');
    expect(sql).not.toContain('Dumping routines');
  });

  it('emits an empty events banner but no time-zone wrapper', async () => {
    // mysqldump's empty events section is the banner and nothing else.
    const { sql } = await render(simple);
    expect(sql).toContain("-- Dumping events for database 'testdb'");
    expect(sql).not.toContain('@save_time_zone');
  });

  it('still emits the time-zone wrapper when an event exists', async () => {
    const { sql } = await render(makeDatabase({ events: [makeEvent({ eventName: 'ev' })] }));
    expect(sql).toContain("-- Dumping events for database 'testdb'");
    expect(sql).toContain('/*!50106 SET @save_time_zone= @@TIME_ZONE */ ;');
    expect(sql).toContain('/*!50106 SET TIME_ZONE= @save_time_zone */ ;');
  });

  it('emits each banner exactly once, however many objects there are', async () => {
    const { sql } = await render(
      makeDatabase({
        routines: [
          makeRoutine({ pureName: 'a', kind: 'FUNCTION' }),
          makeRoutine({ pureName: 'b', kind: 'PROCEDURE' }),
        ],
        events: [makeEvent({ eventName: 'e1' }), makeEvent({ eventName: 'e2' })],
      }),
    );
    expect(sql.split("-- Dumping routines for database 'testdb'")).toHaveLength(2);
    expect(sql.split("-- Dumping events for database 'testdb'")).toHaveLength(2);
  });
});
