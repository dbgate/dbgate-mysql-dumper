import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { rewriteBinaryLiterals } from '../src/restore/binaryLiterals.js';
import { isMysqlDump, redactSecrets, safeSqlPreview } from '../src/restore/preview.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { RestoreSessionState } from '../src/restore/sessionState.js';
import type { RestoreProgressEvent } from '../src/utils/progress.js';
import { MockMysqlConnection, serverError } from './mockConnection.js';

describe('restoreSqlDump: execution', () => {
  it('executes each statement without its delimiter', async () => {
    const connection = new MockMysqlConnection();
    const result = await restoreSqlDump({
      connection,
      source: 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n',
    });
    expect(connection.executedSql).toEqual(['CREATE TABLE t (id int)', 'INSERT INTO t VALUES (1)']);
    expect(result.statementsExecuted).toBe(2);
    expect(result.statementsFailed).toBe(0);
  });

  it('never sends a DELIMITER command to the server', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({
      connection,
      source: 'DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END ;;\nDELIMITER ;\n',
    });
    expect(connection.executedSql).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; END']);
  });

  it('sends executable comments to the server rather than stripping them', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({
      connection,
      source: '/*!40000 ALTER TABLE `t` DISABLE KEYS */;\n',
    });
    expect(connection.executedSql).toEqual(['/*!40000 ALTER TABLE `t` DISABLE KEYS */']);
  });

  it('uses execute(), so no driver placeholder substitution can occur', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({ connection, source: "INSERT INTO t VALUES ('why?');" });
    expect(connection.executed[0]?.kind).toBe('execute');
    expect(connection.executedSql[0]).toBe("INSERT INTO t VALUES ('why?')");
  });

  it('issues USE when a database is named', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({
      connection,
      source: 'SELECT 1;',
      options: { databaseName: 'my db' },
    });
    expect(connection.executedSql[0]).toBe('USE `my db`');
  });

  it('reports rows restored from affectedRows', async () => {
    const connection = new MockMysqlConnection([{ match: 'INSERT', affectedRows: 3 }]);
    const result = await restoreSqlDump({
      connection,
      source: 'INSERT INTO t VALUES (1),(2),(3);',
    });
    expect(result.rowsRestored).toBe(3);
  });

  it('reports bytes consumed', async () => {
    const source = 'SELECT 1;\nSELECT 2;\n';
    const result = await restoreSqlDump({ connection: new MockMysqlConnection(), source });
    expect(result.bytesConsumed).toBe(Buffer.byteLength(source, 'utf8'));
  });
});

describe('restoreSqlDump: sources', () => {
  it('accepts a string', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({ connection, source: 'SELECT 1;' });
    expect(connection.executedSql).toEqual(['SELECT 1']);
  });

  it('accepts a Buffer, keeping bytes intact', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({ connection, source: Buffer.from("SELECT 'é';", 'utf8') });
    expect(connection.executedSql).toEqual(["SELECT 'é'"]);
  });

  it('accepts a Readable stream', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({
      connection,
      source: Readable.from([Buffer.from('SELECT 1; SEL'), Buffer.from('ECT 2;')]),
    });
    expect(connection.executedSql).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('accepts an async iterable of strings', async () => {
    const connection = new MockMysqlConnection();
    async function* chunks(): AsyncGenerator<string> {
      yield 'SELECT ';
      yield '1;';
    }
    await restoreSqlDump({ connection, source: chunks() });
    expect(connection.executedSql).toEqual(['SELECT 1']);
  });

  it('decodes multi-byte text split across chunk boundaries', async () => {
    const bytes = Buffer.from("SELECT '😀';", 'utf8');
    for (let split = 1; split < bytes.length; split++) {
      const connection = new MockMysqlConnection();
      await restoreSqlDump({
        connection,
        source: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      });
      expect(connection.executedSql, `split at ${split}`).toEqual(["SELECT '😀'"]);
    }
  });
});

describe('restoreSqlDump: errors', () => {
  const failing = () =>
    new MockMysqlConnection([
      { match: 'BOOM', error: serverError("Table 'x' doesn't exist", 1146, 'ER_NO_SUCH_TABLE') },
    ]);

  it('stops at the first failure by default', async () => {
    const connection = failing();
    const result = await restoreSqlDump({
      connection,
      source: 'SELECT 1;\nBOOM;\nSELECT 2;',
    });
    expect(result.statementsExecuted).toBe(1);
    expect(result.statementsFailed).toBe(1);
    expect(connection.executedSql).not.toContain('SELECT 2');
  });

  it('continues past a failure when stopOnError is off', async () => {
    const connection = failing();
    const result = await restoreSqlDump({
      connection,
      source: 'SELECT 1;\nBOOM;\nSELECT 2;',
      options: { stopOnError: false },
    });
    expect(result.statementsExecuted).toBe(2);
    expect(result.statementsFailed).toBe(1);
  });

  it('reports statement index, location, preview and the server error fields', async () => {
    const result = await restoreSqlDump({
      connection: failing(),
      source: 'SELECT 1;\n\nBOOM;\n',
    });
    const error = result.errors[0];
    expect(error?.statementIndex).toBe(1);
    expect(error?.location).toEqual({ startLine: 3, endLine: 3 });
    expect(error?.sqlPreview).toBe('BOOM');
    expect(error?.delimiter).toBe(';');
    expect(error?.serverError?.errno).toBe(1146);
    expect(error?.serverError?.code).toBe('ER_NO_SUCH_TABLE');
  });

  it('throws on a parse error, since later boundaries cannot be trusted', async () => {
    await expect(
      restoreSqlDump({ connection: new MockMysqlConnection(), source: "SELECT 'unterminated" }),
    ).rejects.toThrow(/Unterminated/);
  });
});

describe('restoreSqlDump: definer policy', () => {
  // A view rather than a procedure: it carries a DEFINER while still being a
  // single statement under the default `;` delimiter, so these tests are about
  // the definer policy and not about statement splitting.
  const definerSql =
    'CREATE DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS SELECT 1 AS `x`;';

  it('sends the definer unchanged by default', async () => {
    const connection = new MockMysqlConnection();
    await restoreSqlDump({ connection, source: definerSql });
    expect(connection.executedSql[0]).toContain('DEFINER=`root`@`localhost`');
  });

  it('strips the definer and warns when asked', async () => {
    const connection = new MockMysqlConnection();
    const result = await restoreSqlDump({
      connection,
      source: definerSql,
      options: { definerPolicy: 'strip' },
    });
    expect(connection.executedSql[0]).not.toContain('DEFINER=');
    expect(result.warnings.map(warning => warning.code)).toContain('definer-rewritten');
  });

  it('best-effort retries without the definer only on a definer error', async () => {
    const connection = new MockMysqlConnection([
      {
        match: sql => sql.includes('DEFINER='),
        error: serverError(
          'The user specified as a definer does not exist',
          1449,
          'ER_NO_SUCH_USER',
        ),
      },
    ]);
    const result = await restoreSqlDump({
      connection,
      source: definerSql,
      options: { definerPolicy: 'best-effort' },
    });
    expect(result.statementsExecuted).toBe(1);
    expect(result.statementsFailed).toBe(0);
    expect(connection.executedSql[1]).not.toContain('DEFINER=');
    expect(result.warnings.map(warning => warning.code)).toContain('definer-rewritten');
  });

  it('best-effort does not retry an unrelated failure', async () => {
    const connection = new MockMysqlConnection([
      { match: 'DEFINER=', error: serverError('You have an error in your SQL syntax', 1064) },
    ]);
    const result = await restoreSqlDump({
      connection,
      source: definerSql,
      options: { definerPolicy: 'best-effort' },
    });
    expect(result.statementsFailed).toBe(1);
    // Exactly one attempt: retrying a syntax error would achieve nothing.
    expect(connection.executedSql).toHaveLength(1);
  });
});

describe('restoreSqlDump: session state', () => {
  const dumpHeader = [
    '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
    '/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;',
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
  ].join('\n');

  it('restores guards the dump changed when the restore stops early', async () => {
    // Without this the caller's connection goes back to their pool with
    // foreign-key checking silently disabled.
    const connection = new MockMysqlConnection([{ match: 'BOOM', error: new Error('nope') }]);
    const result = await restoreSqlDump({
      connection,
      source: `${dumpHeader}\nBOOM;\n`,
    });
    expect(result.warnings.map(warning => warning.code)).toContain('session-state-restored');
    expect(connection.executedSql).toContain(
      'SET FOREIGN_KEY_CHECKS=COALESCE(@OLD_FOREIGN_KEY_CHECKS, 1)',
    );
    expect(connection.executedSql).toContain('SET UNIQUE_CHECKS=COALESCE(@OLD_UNIQUE_CHECKS, 1)');
  });

  it('does not restore guards the dump already restored itself', async () => {
    const connection = new MockMysqlConnection();
    const result = await restoreSqlDump({
      connection,
      source: [
        dumpHeader,
        '/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;',
        '/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;',
        '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
      ].join('\n'),
    });
    expect(result.warnings.map(warning => warning.code)).not.toContain('session-state-restored');
  });

  it('can be turned off', async () => {
    const connection = new MockMysqlConnection([{ match: 'BOOM', error: new Error('nope') }]);
    await restoreSqlDump({
      connection,
      source: `${dumpHeader}\nBOOM;\n`,
      options: { restoreSessionState: false },
    });
    expect(connection.executedSql.some(sql => sql.includes('COALESCE'))).toBe(false);
  });
});

describe('RestoreSessionState', () => {
  it('tracks and clears each guarded variable', () => {
    const state = new RestoreSessionState();
    state.observe('/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */');
    expect(state.pendingCount).toBe(1);
    state.observe('/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */');
    expect(state.pendingCount).toBe(0);
  });

  it('ignores a statement that merely mentions a variable', () => {
    const state = new RestoreSessionState();
    state.observe("INSERT INTO log VALUES ('FOREIGN_KEY_CHECKS')");
    expect(state.pendingCount).toBe(0);
  });
});

describe('restoreSqlDump: transactions', () => {
  it('warns that singleTransaction cannot cover DDL', async () => {
    const connection = new MockMysqlConnection();
    const result = await restoreSqlDump({
      connection,
      source: 'SELECT 1;',
      options: { singleTransaction: true },
    });
    expect(connection.executedSql).toContain('START TRANSACTION');
    expect(connection.executedSql).toContain('COMMIT');
    expect(result.warnings.map(warning => warning.code)).toContain('single-transaction-limited');
  });

  it('rolls back when a statement fails', async () => {
    const connection = new MockMysqlConnection([{ match: 'BOOM', error: new Error('nope') }]);
    await restoreSqlDump({
      connection,
      source: 'BOOM;',
      options: { singleTransaction: true },
    });
    expect(connection.executedSql).toContain('ROLLBACK');
    expect(connection.executedSql).not.toContain('COMMIT');
  });
});

describe('restoreSqlDump: cancellation', () => {
  it('stops and reports cancelled without throwing', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await restoreSqlDump({
      connection: new MockMysqlConnection(),
      source: 'SELECT 1;\nSELECT 2;',
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.statementsExecuted).toBe(0);
  });
});

describe('restoreSqlDump: progress', () => {
  it('reports the delimiter and the dump section it is in', async () => {
    const events: RestoreProgressEvent[] = [];
    await restoreSqlDump({
      connection: new MockMysqlConnection(),
      source: [
        '--',
        '-- Dumping data for table `books`',
        '--',
        'INSERT INTO `books` VALUES (1);',
        'DELIMITER ;;',
        'CREATE PROCEDURE p() BEGIN SELECT 1; END ;;',
        'DELIMITER ;',
      ].join('\n'),
      progress: event => events.push(event),
    });

    const insert = events.find(event => event.statementIndex === 0 && event.phase === 'parsing');
    expect(insert?.currentObject).toBe('Dumping data for table `books`');
    expect(insert?.delimiter).toBe(';');

    const procedure = events.find(event => event.statementIndex === 1 && event.phase === 'parsing');
    expect(procedure?.delimiter).toBe(';;');
  });
});

describe('rewriteBinaryLiterals', () => {
  it('leaves a valid UTF-8 statement untouched', () => {
    const statement = Buffer.from("INSERT INTO t VALUES ('café 😀')", 'utf8');
    const result = rewriteBinaryLiterals(statement);
    expect(result.bytes).toEqual(statement);
    expect(result.rewrittenLiterals).toBe(0);
  });

  it('converts a raw _binary literal to hexadecimal, byte for byte', () => {
    // This is what makes a `mysqldump` dump *without* --hex-blob restorable:
    // the bytes cannot survive a UTF-8 decode, and 0x... means the same thing.
    const statement = Buffer.concat([
      Buffer.from("INSERT INTO t VALUES (_binary '", 'latin1'),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from("')", 'latin1'),
    ]);
    const result = rewriteBinaryLiterals(statement);
    expect(result.bytes.toString('utf8')).toBe('INSERT INTO t VALUES (0xFFFE80)');
    expect(result.rewrittenLiterals).toBe(1);
  });

  it('unescapes MySQL escape sequences before hex-encoding', () => {
    const statement = Buffer.concat([
      Buffer.from("VALUES (_binary '\\0\\n\\r\\Z\\\\\\'", 'latin1'),
      Buffer.from([0xff]),
      Buffer.from("')", 'latin1'),
    ]);
    const result = rewriteBinaryLiterals(statement);
    expect(result.bytes.toString('utf8')).toBe('VALUES (0x000A0D1A5C27FF)');
  });

  it('leaves valid UTF-8 literals in the same statement alone', () => {
    const statement = Buffer.concat([
      Buffer.from("INSERT INTO t VALUES ('text é', _binary '", 'utf8'),
      Buffer.from([0xff]),
      Buffer.from("')", 'latin1'),
    ]);
    const result = rewriteBinaryLiterals(statement);
    expect(result.bytes.toString('utf8')).toBe("INSERT INTO t VALUES ('text é', 0xFF)");
    expect(result.rewrittenLiterals).toBe(1);
  });

  it('reports failure rather than corrupting bytes outside any literal', () => {
    const statement = Buffer.concat([Buffer.from('SELECT '), Buffer.from([0xff])]);
    expect(rewriteBinaryLiterals(statement).failed).toBeDefined();
  });

  it('restores a raw-binary dump end to end', async () => {
    const connection = new MockMysqlConnection();
    const dump = Buffer.concat([
      Buffer.from("INSERT INTO `t` VALUES (1,_binary '", 'latin1'),
      Buffer.from([0x00, 0xff, 0xfe]),
      Buffer.from("');\n", 'latin1'),
    ]);
    const result = await restoreSqlDump({ connection, source: dump });
    expect(result.errors).toEqual([]);
    expect(connection.executedSql[0]).toBe('INSERT INTO `t` VALUES (1,0x00FFFE)');
  });
});

describe('isMysqlDump', () => {
  it('recognizes a mysqldump header', () => {
    expect(isMysqlDump('-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)\n--\n')).toBe(true);
  });

  it('recognizes this package own header', () => {
    expect(
      isMysqlDump('-- MySQL dump 10.13  Distrib dbgate-mysql-dumper, for Node.js (linux)\n'),
    ).toBe(true);
  });

  it('recognizes a headerless dump by its session guards', () => {
    expect(isMysqlDump('/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;')).toBe(
      true,
    );
  });

  it('rejects unrelated SQL', () => {
    expect(isMysqlDump('CREATE TABLE t (id int);')).toBe(false);
    expect(isMysqlDump('-- pg_dump\nCREATE TABLE t ();')).toBe(false);
  });

  it('accepts bytes as well as text', () => {
    expect(isMysqlDump(Buffer.from('-- MySQL dump 10.13  Distrib x'))).toBe(true);
  });
});

describe('secret redaction', () => {
  it('redacts an IDENTIFIED BY password', () => {
    expect(redactSecrets("CREATE USER a IDENTIFIED BY 'hunter2'")).toBe(
      "CREATE USER a IDENTIFIED BY '***REDACTED***'",
    );
  });

  it('redacts a plugin-qualified password and a hashed one', () => {
    expect(
      redactSecrets("ALTER USER a IDENTIFIED WITH caching_sha2_password BY 's3cret'"),
    ).toContain('***REDACTED***');
    expect(redactSecrets('CREATE USER a IDENTIFIED WITH x AS 0xDEADBEEF')).toContain(
      '***REDACTED***',
    );
  });

  it('redacts replication credentials', () => {
    expect(redactSecrets("CHANGE MASTER TO MASTER_PASSWORD = 'p'")).toContain('***REDACTED***');
    expect(redactSecrets("CHANGE REPLICATION SOURCE TO SOURCE_PASSWORD = 'p'")).toContain(
      '***REDACTED***',
    );
  });

  it('leaves ordinary SQL alone', () => {
    const sql = "INSERT INTO t VALUES ('not a password')";
    expect(redactSecrets(sql)).toBe(sql);
  });
});

describe('safeSqlPreview', () => {
  it('collapses whitespace and truncates', () => {
    expect(safeSqlPreview('SELECT\n  1,\n  2')).toBe('SELECT 1, 2');
    expect(safeSqlPreview('x'.repeat(500))).toHaveLength(201);
  });

  it('never splits a surrogate pair', () => {
    const preview = safeSqlPreview(`${'x'.repeat(199)}😀tail`, 200);
    // Cutting mid-pair would leave a lone high surrogate.
    expect(preview.endsWith('…')).toBe(true);
    expect([...preview].every(character => character.codePointAt(0) !== 0xd83d)).toBe(true);
  });

  it('redacts secrets before truncating', () => {
    expect(safeSqlPreview("CREATE USER a IDENTIFIED BY 'hunter2'")).not.toContain('hunter2');
  });
});

describe('restoreSqlDump: table locks', () => {
  /**
   * Regression: every dump wraps a table's data in
   * `LOCK TABLES t WRITE; … UNLOCK TABLES;`. A restore that stops in between
   * — the `stopOnError` default, or a cancellation — handed the caller's
   * connection back to their pool **still holding a write lock**, blocking
   * every other session that touched that table and leaving the holder unable
   * to touch any other table (`ER_TABLE_NOT_LOCKED`). Verified against a real
   * server in `integration/behaviour.integration.test.ts`.
   */
  it('releases a held table lock when a statement fails', async () => {
    const connection = new MockMysqlConnection([{ match: 'BOOM', error: new Error('nope') }]);
    const result = await restoreSqlDump({
      connection,
      source: 'LOCK TABLES `t` WRITE;\nBOOM;\nUNLOCK TABLES;',
    });
    expect(result.statementsFailed).toBe(1);
    expect(connection.executedSql).toContain('UNLOCK TABLES');
    expect(result.warnings.map(warning => warning.code)).toContain('session-state-restored');
  });

  it('releases a held table lock when the restore is cancelled', async () => {
    const controller = new AbortController();
    const connection = new MockMysqlConnection([
      {
        match: 'LOCK TABLES',
        // Abort as soon as the lock is taken, mid-dump.
        get affectedRows(): number {
          controller.abort();
          return 0;
        },
      },
    ]);
    const result = await restoreSqlDump({
      connection,
      source: 'LOCK TABLES `t` WRITE;\nINSERT INTO `t` VALUES (1);\nUNLOCK TABLES;',
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(connection.executedSql).toContain('UNLOCK TABLES');
  });

  it('does not issue a redundant UNLOCK when the dump already did', async () => {
    const connection = new MockMysqlConnection();
    const result = await restoreSqlDump({
      connection,
      source: 'LOCK TABLES `t` WRITE;\nINSERT INTO `t` VALUES (1);\nUNLOCK TABLES;',
    });
    expect(connection.executedSql.filter(sql => sql === 'UNLOCK TABLES')).toHaveLength(1);
    expect(result.warnings.map(warning => warning.code)).not.toContain('session-state-restored');
  });

  it('ignores LOCK TABLES text inside a routine body or a string', async () => {
    // Anchored at the statement start, so only a lock this session actually
    // executed is tracked.
    const connection = new MockMysqlConnection();
    await restoreSqlDump({
      connection,
      source: "INSERT INTO `log` VALUES ('LOCK TABLES x WRITE');",
    });
    expect(connection.executedSql).not.toContain('UNLOCK TABLES');
  });
});
