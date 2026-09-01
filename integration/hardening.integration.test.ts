import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MysqlRow } from '../src/connection/types.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { dumpToBuffer } from './helpers/dump.js';
import {
  createTestDatabase,
  dropDatabaseIfExists,
  execStatements,
  nativeMysqlRestore,
  nativeMysqldump,
  probeServer,
  readServerConfig,
  runInContainer,
  selectedTargets,
} from './helpers/server.js';
import type { ServerTarget, TestDatabase } from './helpers/server.js';

/**
 * Hardening suite: the cases a production review turned up, kept as permanent
 * regression coverage.
 *
 * Every test here exists because the scenario was either found broken (and
 * fixed), or was an unverified assumption the rest of the suite happened not
 * to exercise. None of them duplicate the interoperability matrix.
 */
describe.each(selectedTargets())('hardening: $label', (target: ServerTarget) => {
  let available = false;
  const scratch: TestDatabase[] = [];

  beforeAll(async () => {
    available = (await probeServer(target)).available;
  });

  afterAll(async () => {
    for (const database of scratch) {
      await database.connection
        .query({ sql: 'UNLOCK TABLES' }, undefined, 'native')
        .catch(() => {});
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    }
  });

  async function fresh(name: string): Promise<TestDatabase> {
    const database = await createTestDatabase(target, `hard_${target.id}_${name}`);
    scratch.push(database);
    return database;
  }

  async function rows(database: TestDatabase, sql: string): Promise<string[]> {
    const result = await database.connection.query<MysqlRow>({ sql }, undefined, 'raw');
    return result.rows.map(row =>
      Object.values(row)
        .map(value =>
          value === null ? 'NULL' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value),
        )
        .join('|'),
    );
  }

  describe('CREATE DATABASE', () => {
    /**
     * Regression, critical: `SCHEMATA.DEFAULT_ENCRYPTION` reports `'NO'` but
     * `CREATE DATABASE ... DEFAULT ENCRYPTION` accepts only `'N'`. Emitting
     * the catalog value made native `mysql` reject the dump outright with
     * `ERROR 1525`, so `includeCreateDatabase` produced an unrestorable file.
     */
    it('produces a CREATE DATABASE dump native mysql accepts, with no target database', async () => {
      if (!available) return;
      const source = await fresh('cdb');
      await execStatements(source.connection, [
        'CREATE TABLE `t` (`id` int PRIMARY KEY, `s` varchar(32))',
        "INSERT INTO `t` VALUES (1,'value')",
      ]);

      const { text } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false, includeCreateDatabase: true },
      });
      expect(text).toContain('CREATE DATABASE');
      expect(text).not.toContain("ENCRYPTION='NO'");

      const cloneName = `${source.name}_clone`;
      await dropDatabaseIfExists(target, cloneName);
      const cloned = text.split(source.name).join(cloneName);
      const config = readServerConfig();
      try {
        // No database argument at all: the dump has to create and select its own.
        await runInContainer(
          target,
          [
            target.flavor === 'mariadb' ? 'mariadb' : 'mysql',
            '--default-character-set=utf8mb4',
            '-h',
            '127.0.0.1',
            '-u',
            config.user,
          ],
          Buffer.from(cloned, 'utf8'),
        );
        const { openConnection } = await import('./helpers/server.js');
        const opened = await openConnection(target, cloneName);
        try {
          expect(
            await rows(
              { ...source, name: cloneName, connection: opened.connection },
              'SELECT * FROM `t`',
            ),
          ).toEqual(['1|value']);
        } finally {
          await opened.close();
        }
      } finally {
        await dropDatabaseIfExists(target, cloneName).catch(() => {});
      }
    });
  });

  describe('session cleanup', () => {
    /**
     * Regression, critical: a `LOCK TABLES` held when a restore stopped early
     * was never released, so the caller's connection went back to their pool
     * holding a write lock — blocking every other session on that table, and
     * unable to touch any other table itself.
     */
    it('releases a table lock when a restore fails midway', async () => {
      if (!available) return;
      const database = await fresh('lock');
      await execStatements(database.connection, [
        'CREATE TABLE `locked` (`id` int)',
        'CREATE TABLE `other` (`id` int)',
      ]);

      const result = await restoreSqlDump({
        connection: database.connection,
        source: 'LOCK TABLES `locked` WRITE;\nTHIS IS NOT SQL;\nUNLOCK TABLES;',
        options: { databaseName: database.name },
      });
      expect(result.statementsFailed).toBe(1);
      expect(result.warnings.map(warning => warning.code)).toContain('session-state-restored');

      // With the lock still held this would fail with ER_TABLE_NOT_LOCKED.
      expect(await rows(database, 'SELECT * FROM `other`')).toEqual([]);
    });

    it('releases a table lock when a restore is cancelled', async () => {
      if (!available) return;
      const database = await fresh('lockcancel');
      await execStatements(database.connection, [
        'CREATE TABLE `locked` (`id` int)',
        'CREATE TABLE `other` (`id` int)',
      ]);

      const controller = new AbortController();
      const result = await restoreSqlDump({
        connection: database.connection,
        source: [
          'LOCK TABLES `locked` WRITE;',
          'INSERT INTO `locked` VALUES (1);',
          'INSERT INTO `locked` VALUES (2);',
          'UNLOCK TABLES;',
        ].join('\n'),
        options: { databaseName: database.name },
        signal: controller.signal,
        progress: event => {
          if (event.executionState === 'finished') controller.abort();
        },
      });
      expect(result.cancelled).toBe(true);
      expect(await rows(database, 'SELECT * FROM `other`')).toEqual([]);
    });

    it('leaves session variables untouched after a failed restore', async () => {
      if (!available) return;
      const database = await fresh('vars');
      await database.connection.query(
        { sql: 'SET NAMES latin1 COLLATE latin1_swedish_ci' },
        undefined,
        'native',
      );
      const before = await rows(
        database,
        `SELECT @@SESSION.foreign_key_checks, @@SESSION.unique_checks, @@SESSION.sql_mode,
                @@SESSION.character_set_client, @@SESSION.character_set_results,
                @@SESSION.collation_connection`,
      );
      await restoreSqlDump({
        connection: database.connection,
        source: [
          '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
          '/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;',
          '/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;',
          '/*!50503 SET NAMES utf8mb4 */;',
          '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
          '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
          "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
          'THIS IS NOT SQL;',
        ].join('\n'),
        options: { databaseName: database.name },
      });
      expect(
        await rows(
          database,
          `SELECT @@SESSION.foreign_key_checks, @@SESSION.unique_checks, @@SESSION.sql_mode,
                  @@SESSION.character_set_client, @@SESSION.character_set_results,
                  @@SESSION.collation_connection`,
        ),
      ).toEqual(before);
    });
  });

  describe('hostile stored programs', () => {
    /**
     * Every control-flow construct MySQL offers, plus strings and comments
     * containing the delimiter `mysqldump` will use. If the lexer mis-handles
     * any of them, the routine body is torn apart and the restore fails.
     */
    async function buildHostileDatabase(name: string): Promise<TestDatabase> {
      const database = await fresh(name);
      await execStatements(database.connection, [
        'CREATE TABLE `log` (`id` int AUTO_INCREMENT PRIMARY KEY, `note` varchar(200))',
        `CREATE PROCEDURE \`sp_hostile\`()
BEGIN
  DECLARE i INT DEFAULT 0;
  -- a comment containing ;; and $$ and // delimiters
  BEGIN
    DECLARE inner_v INT DEFAULT 1;
    INSERT INTO \`log\` (\`note\`) VALUES ('semi; colon ;; double $$ dollar // slash');
  END;
  my_loop: LOOP
    SET i = i + 1;
    IF i >= 3 THEN
      LEAVE my_loop;
    END IF;
  END LOOP my_loop;
  WHILE i < 5 DO
    SET i = i + 1;
  END WHILE;
  REPEAT
    SET i = i + 1;
  UNTIL i > 7 END REPEAT;
  CASE i
    WHEN 8 THEN INSERT INTO \`log\` (\`note\`) VALUES ('case eight;');
    ELSE INSERT INTO \`log\` (\`note\`) VALUES ('case other;');
  END CASE;
  /* block comment with ;; and END */
END`,
        `CREATE FUNCTION \`fn_hostile\`(p INT) RETURNS VARCHAR(64) DETERMINISTIC
BEGIN
  DECLARE r VARCHAR(64);
  CASE
    WHEN p > 0 THEN SET r = 'positive;;';
    ELSE SET r = 'other$$';
  END CASE;
  RETURN r;
END`,
        `CREATE TRIGGER \`trg_hostile\` BEFORE INSERT ON \`log\` FOR EACH ROW
BEGIN
  IF NEW.\`note\` IS NULL THEN
    SET NEW.\`note\` = 'defaulted;;value';
  END IF;
END`,
      ]);
      return database;
    }

    /** Calls the procedure and function, proving the restored bodies actually run. */
    async function expectBodiesWork(database: TestDatabase): Promise<void> {
      await database.connection.query({ sql: 'CALL `sp_hostile`()' }, undefined, 'native');
      expect(await rows(database, 'SELECT `note` FROM `log` ORDER BY `id`')).toEqual([
        'semi; colon ;; double $$ dollar // slash',
        'case eight;',
      ]);
      expect(await rows(database, 'SELECT `fn_hostile`(1)')).toEqual(['positive;;']);
    }

    it('native mysqldump -> our restore', async () => {
      if (!available) return;
      const source = await buildHostileDatabase('sp_native');
      const restored = await fresh('sp_native_t');
      const sql = await nativeMysqldump(target, source.name, [
        '--routines',
        '--triggers',
        '--events',
        '--hex-blob',
      ]);
      const result = await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });
      expect(result.errors.map(error => error.message)).toEqual([]);
      await expectBodiesWork(restored);
    });

    it('our dump -> native mysql restore', async () => {
      if (!available) return;
      const source = await buildHostileDatabase('sp_ours');
      const restored = await fresh('sp_ours_t');
      const { sql } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });
      await nativeMysqlRestore(target, restored.name, sql);
      await expectBodiesWork(restored);
    });
  });

  describe('native mysqldump option variants restore', () => {
    /**
     * `--compact` and `--skip-opt` drop the session guards, the DROP
     * statements and the locking frame. A restore must cope with all of them,
     * since these are what a user pipes in from an existing backup.
     */
    it.each([
      ['--compact'],
      ['--skip-comments'],
      ['--skip-opt'],
      ['--compact', '--routines'],
      ['--skip-extended-insert'],
      ['--complete-insert'],
    ])('restores a %s dump', async (...args: string[]) => {
      if (!available) return;
      const source = await fresh(`opt_${args.join('_').replace(/[^a-z]/g, '')}`);
      await execStatements(source.connection, [
        'CREATE TABLE `t` (`id` int PRIMARY KEY, `s` varchar(32))',
        "INSERT INTO `t` VALUES (1,'a'),(2,'b')",
        'CREATE VIEW `v` AS SELECT `id` AS `id` FROM `t`',
      ]);
      const restored = await fresh(`opt_t_${args.join('_').replace(/[^a-z]/g, '')}`);

      const sql = await nativeMysqldump(target, source.name, args);
      const result = await restoreSqlDump({
        connection: restored.connection,
        source: sql,
        options: { databaseName: restored.name },
      });
      expect(result.errors.map(error => error.message)).toEqual([]);
      expect(await rows(restored, 'SELECT * FROM `t` ORDER BY `id`')).toEqual(['1|a', '2|b']);
    });
  });

  describe('legacy latin1 dumps', () => {
    /**
     * A `mysqldump --default-character-set=latin1` file is not valid UTF-8.
     * The parser works on bytes and rewrites the non-UTF-8 literals to
     * hexadecimal, which preserves them exactly.
     */
    it('restores a latin1-encoded native dump byte-exactly', async () => {
      if (!available) return;
      const source = await fresh('latin1');
      await execStatements(source.connection, [
        'CREATE TABLE `t` (`id` int PRIMARY KEY, `s` varchar(64)) DEFAULT CHARSET=latin1',
        "INSERT INTO `t` VALUES (1,'café Ünicode'),(2,'plain ascii')",
      ]);
      const restored = await fresh('latin1_t');

      const config = readServerConfig();
      const { stdout } = await runInContainer(target, [
        target.flavor === 'mariadb' ? 'mariadb-dump' : 'mysqldump',
        '--default-character-set=latin1',
        '-h',
        '127.0.0.1',
        '-u',
        config.user,
        '--hex-blob',
        source.name,
      ]);

      const result = await restoreSqlDump({
        connection: restored.connection,
        source: stdout,
        options: { databaseName: restored.name },
      });
      expect(result.errors.map(error => error.message)).toEqual([]);
      expect(await rows(restored, 'SELECT HEX(`s`) FROM `t` ORDER BY `id`')).toEqual(
        await rows(source, 'SELECT HEX(`s`) FROM `t` ORDER BY `id`'),
      );
    });
  });

  describe('poisoned source session', () => {
    /**
     * A caller's connection may already carry `ANSI_QUOTES` (which makes
     * `SHOW CREATE TABLE` emit double-quoted identifiers no restore session
     * would accept) or `NO_BACKSLASH_ESCAPES` (which changes what the
     * generated literals mean). Both are subtracted for the dump's duration
     * and restored afterwards.
     */
    it('dumps correctly from an ANSI_QUOTES / NO_BACKSLASH_ESCAPES session', async () => {
      if (!available) return;
      const source = await fresh('mode');
      await execStatements(source.connection, [
        'CREATE TABLE `t` (`id` int PRIMARY KEY, `s` varchar(64))',
        `INSERT INTO \`t\` VALUES (1,'back\\\\slash and '' quote')`,
      ]);
      const restored = await fresh('mode_t');

      await source.connection.query(
        { sql: "SET SESSION sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'" },
        undefined,
        'native',
      );
      const { sql, text } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });

      // Backticks, not double quotes: the poisoned mode did not leak into the DDL.
      expect(text).toContain('CREATE TABLE `t`');
      // The caller's session is handed back exactly as it was.
      expect(await rows(source, 'SELECT @@SESSION.sql_mode')).toEqual([
        'ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
      ]);

      await nativeMysqlRestore(target, restored.name, sql);
      expect(await rows(restored, 'SELECT HEX(`s`) FROM `t`')).toEqual(
        await rows(source, 'SELECT HEX(`s`) FROM `t`'),
      );
    });
  });

  describe('view dependency chains', () => {
    /**
     * The stub-view mechanism is what allows plain name ordering. This chain
     * is built so alphabetical order is the *worst* possible one: `a_dep`
     * reads from `z_base`, and `m_mid` reads from `a_dep`.
     */
    it('restores a chain whose dependencies sort last', async () => {
      if (!available) return;
      const source = await fresh('views');
      await execStatements(source.connection, [
        'CREATE TABLE `t` (`id` int PRIMARY KEY, `name` varchar(64), `amount` decimal(20,4))',
        "INSERT INTO `t` VALUES (1,'alpha',123.4567)",
        'CREATE VIEW `z_base` AS SELECT `id` AS `id`, `name` AS `name`, `amount` AS `amount` FROM `t`',
        'CREATE VIEW `a_dep` AS SELECT `id` AS `id`, `name` AS `name`, `amount` AS `amount` FROM `z_base`',
        'CREATE VIEW `m_mid` AS SELECT `id` AS `id`, `name` AS `name` FROM `a_dep`',
      ]);
      const restored = await fresh('views_t');

      const { sql } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });
      await nativeMysqlRestore(target, restored.name, sql);

      const columns = (database: TestDatabase): Promise<string[]> =>
        rows(
          database,
          `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('a_dep','m_mid','z_base')
           ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        );

      // Column *types* too: a view created against a stub could otherwise keep
      // the stub's INT columns instead of the real ones.
      expect(await columns(restored)).toEqual(await columns(source));
      expect(await rows(restored, 'SELECT * FROM `m_mid`')).toEqual(['1|alpha']);
    });
  });

  describe('hostile identifiers', () => {
    /**
     * Table and column names containing a space, a backtick, a reserved word
     * and non-ASCII text. These exercise every place an identifier reaches
     * generated SQL: the `SELECT` list, the `INSERT` column list, the
     * `ORDER BY`, and the `LOCK TABLES` frame.
     */
    it('round-trips names with spaces, backticks, reserved words and unicode', async () => {
      if (!available) return;
      const source = await fresh('idents');
      // MariaDB stores identifiers in utf8mb3 and rejects supplementary
      // characters such as emoji even on an utf8mb4 connection.
      const unicodeColumn = target.flavor === 'mariadb' ? 'Ünicode' : 'Ünicode 😀';
      await execStatements(source.connection, [
        'CREATE TABLE `we``ird name` (' +
          '`or``der` int NOT NULL, ' +
          '`select` varchar(32), ' +
          '`col with space` varchar(32), ' +
          `\`${unicodeColumn}\` varchar(32), ` +
          'PRIMARY KEY (`or``der`))',
        "INSERT INTO `we``ird name` VALUES (1,'a','b','c'),(2,'d','e','f')",
      ]);
      const restored = await fresh('idents_t');

      const { sql, text } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });
      // The backtick in the name must be doubled everywhere it appears.
      expect(text).toContain('LOCK TABLES `we``ird name` WRITE;');
      expect(text).toContain('INSERT INTO `we``ird name`');

      await nativeMysqlRestore(target, restored.name, sql);
      const query = 'SELECT * FROM `we``ird name` ORDER BY `or``der`';
      expect(await rows(restored, query)).toEqual(await rows(source, query));
    });
  });

  describe('schema edge cases', () => {
    it('preserves ON UPDATE, CHECK OPTION, CHAR padding and trailing spaces', async () => {
      if (!available) return;
      const source = await fresh('edge');
      await execStatements(source.connection, [
        `CREATE TABLE \`t\` (
           \`id\` int NOT NULL AUTO_INCREMENT,
           \`touched\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           \`c\` char(10),
           \`vc\` varchar(10),
           \`bn\` binary(6),
           PRIMARY KEY (\`id\`)
         ) ENGINE=InnoDB`,
        "INSERT INTO `t` (`c`,`vc`,`bn`) VALUES ('ab   ','cd   ',0x616200000000)",
        'CREATE VIEW `v_check` AS SELECT `id` AS `id` FROM `t` WHERE `id` > 0 WITH CASCADED CHECK OPTION',
      ]);
      const restored = await fresh('edge_t');

      const { sql } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });
      await nativeMysqlRestore(target, restored.name, sql);

      // Hex, so a lost trailing space or padding byte cannot hide.
      const values = 'SELECT HEX(`c`), HEX(`vc`), HEX(`bn`) FROM `t`';
      expect(await rows(restored, values)).toEqual(await rows(source, values));

      const meta =
        "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='t' ORDER BY ORDINAL_POSITION";
      expect(await rows(restored, meta)).toEqual(await rows(source, meta));

      const checkOption =
        'SELECT TABLE_NAME, CHECK_OPTION FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()';
      expect(await rows(restored, checkOption)).toEqual(await rows(source, checkOption));
    });
  });

  describe('structural parity with native mysqldump', () => {
    /**
     * Enforces the README's headline claim: for the same database, this
     * package's dump matches
     * `mysqldump --routines --events --triggers --hex-blob` line for line
     * apart from three lines that cannot be identical — the producer name,
     * the host label and the completion timestamp — plus, on 5.7 only, the
     * four legacy charset/wording spellings enumerated below.
     *
     * The claim was previously verified by hand. A documented guarantee that
     * nothing checks is a guarantee that quietly stops being true, so it is a
     * test now.
     */
    it('matches native mysqldump line for line apart from documented divergences', async () => {
      if (!available) return;
      if (target.flavor === 'mariadb') return;
      const source = await fresh('parity');
      await execStatements(source.connection, [
        `CREATE TABLE \`items\` (
           \`id\` int NOT NULL AUTO_INCREMENT,
           \`name\` varchar(120) NOT NULL,
           \`price\` decimal(18,6) NOT NULL DEFAULT '0.000000',
           \`blob_data\` blob,
           \`payload\` json DEFAULT NULL,
           \`kind\` enum('a','b') NOT NULL DEFAULT 'a',
           \`tags\` set('x','y') DEFAULT NULL,
           \`created\` timestamp NULL DEFAULT NULL,
           PRIMARY KEY (\`id\`),
           UNIQUE KEY \`uq_items_name\` (\`name\`),
           KEY \`ix_items_price\` (\`price\`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='items; with a '' quote'`,
        `INSERT INTO \`items\` (\`name\`,\`price\`,\`blob_data\`,\`payload\`,\`kind\`,\`tags\`,\`created\`) VALUES
           ('emoji 😀 and ''quote''', 12.345678, 0x00FF00, '{"a": [1, 2]}', 'b', 'x,y', '2021-06-01 08:00:00'),
           ('plain', -0.000001, '', NULL, 'a', '', NULL)`,
        'CREATE VIEW `v_items` AS SELECT `id` AS `id`, `name` AS `name` FROM `items`',
        'CREATE PROCEDURE `sp_items`() BEGIN SELECT COUNT(*) FROM `items`; END',
        'CREATE FUNCTION `fn_items`() RETURNS INT DETERMINISTIC READS SQL DATA BEGIN RETURN 1; END',
        'CREATE TRIGGER `trg_items` BEFORE INSERT ON `items` FOR EACH ROW BEGIN SET NEW.`name` = TRIM(NEW.`name`); END',
      ]);

      const { text: ours } = await dumpToBuffer(source.connection, {
        databaseName: source.name,
        render: { includeTimestamp: false },
      });
      const native = (
        await nativeMysqldump(target, source.name, [
          '--routines',
          '--events',
          '--triggers',
          '--hex-blob',
        ])
      ).toString('utf8');

      /**
       * The spellings 5.7's `mysqldump` still hardcodes, mapped to the modern
       * ones this package emits on every version.
       *
       * These are the *only* divergences from native output, they appear on
       * 5.7 alone, and every one of them is deliberate and in the same
       * direction — ours is accepted everywhere 5.7's is, and one fixes a real
       * 5.7 defect:
       *
       * - `SET NAMES utf8mb4` gated at 4.1.1 would be a syntax error on any
       *   server between 4.1.1 and 5.5.3, which is where `utf8mb4` appeared.
       *   Gating it at 5.5.3, as 8.0's `mysqldump` does, is simply correct.
       * - 5.7 hardcodes the literal `utf8` in the `CREATE TABLE` and view-stub
       *   charset guards even when the dump is utf8mb4 — its own
       *   stored-program blocks say `utf8mb4` in the very same file. Any
       *   4-byte character in a column `DEFAULT`, an `ENUM` value or a
       *   `COMMENT` is then parsed as mb3 when restored. We declare the
       *   charset the file is actually written in.
       * - The view stub's charset assignment is left unguarded by 5.7, so a
       *   pre-4.1 server would fail on it instead of skipping it.
       * - `Temporary table structure for view` was reworded to `Temporary view
       *   structure for view` in 8.0; we use the current wording.
       *
       * Deliberately a whitelist of exact lines rather than a loose filter:
       * anything else that differs still fails this test.
       */
      const LEGACY_SPELLINGS = new Map([
        ['/*!40101 SET NAMES utf8mb4 */;', '/*!50503 SET NAMES utf8mb4 */;'],
        [
          '/*!40101 SET character_set_client = utf8 */;',
          '/*!50503 SET character_set_client = utf8mb4 */;',
        ],
        ['SET character_set_client = utf8;', '/*!50503 SET character_set_client = utf8mb4 */;'],
        [
          '-- Temporary table structure for view `v_items`',
          '-- Temporary view structure for view `v_items`',
        ],
      ]);

      /**
       * Drops the three lines that cannot be identical — producer name, host
       * label, completion timestamp — and modernizes the legacy spellings
       * above. Applied to both sides; on 8.0 and 8.4 the mapping is a no-op.
       */
      const normalize = (sql: string): string[] =>
        sql
          .split(/\r?\n/)
          .filter(
            line =>
              !line.startsWith('-- MySQL dump ') &&
              !line.startsWith('-- Host:') &&
              !line.startsWith('-- Dump completed'),
          )
          .map(line => LEGACY_SPELLINGS.get(line) ?? line);

      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync('test-output/parity', { recursive: true });
      writeFileSync(`test-output/parity/${target.id}-ours.sql`, ours);
      writeFileSync(`test-output/parity/${target.id}-native.sql`, native);

      expect(normalize(ours)).toEqual(normalize(native));
    });
  });
});
