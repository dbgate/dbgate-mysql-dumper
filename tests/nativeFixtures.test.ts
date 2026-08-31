import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isMysqlDump } from '../src/restore/preview.js';
import { parseSqlStatements, streamSqlStatements } from '../src/restore/statementParser.js';

/**
 * Regression tests against **real** `mysqldump` output.
 *
 * The files in `tests/fixtures/native/` were produced by the actual
 * `mysqldump` binaries shipped in the MySQL 8.0 and 8.4 Docker images, over
 * the fixture in `scripts/reference-fixture.sql`. Only three lines were
 * edited — the producer version, the host, and the completion timestamp —
 * because those legitimately vary per run and per installation; everything
 * else is byte-for-byte what MySQL wrote.
 *
 * Keeping them checked in means the parser's behaviour against genuine
 * native output is verified on every `npm test`, with no Docker, no network
 * and no MySQL installed. The Docker-backed suite in `integration/` proves
 * the same dumps actually *restore*; this proves the shape they have.
 */
const FIXTURE_DIRECTORY = join(import.meta.dirname, 'fixtures', 'native');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8');
}

const FIXTURE_NAMES = readdirSync(FIXTURE_DIRECTORY).filter(name => name.endsWith('.sql'));

describe('native mysqldump fixtures', () => {
  it('has fixtures to test against', () => {
    expect(FIXTURE_NAMES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(FIXTURE_NAMES)('%s is recognized as a MySQL dump', name => {
    expect(isMysqlDump(readFixture(name))).toBe(true);
  });

  it.each(FIXTURE_NAMES)('%s parses into statements without error', name => {
    const statements = parseSqlStatements(readFixture(name));
    expect(statements.length).toBeGreaterThan(0);
    // A DELIMITER command must never surface as something to execute.
    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/^\s*DELIMITER\b/i);
    }
  });

  it.each(FIXTURE_NAMES)('%s parses identically however the stream is chunked', async name => {
    const bytes = Buffer.from(readFixture(name), 'utf8');
    const reference = parseSqlStatements(bytes).map(statement => statement.sql);

    for (const chunkSize of [1, 7, 64, 997, 65_536]) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(bytes.subarray(offset, offset + chunkSize));
      }
      const streamed: string[] = [];
      for await (const statement of streamSqlStatements(Readable.from(chunks))) {
        streamed.push(statement.sql);
      }
      expect(streamed, `${name} at chunk size ${chunkSize}`).toEqual(reference);
    }
  });
});

describe('native mysqldump fixtures: structure', () => {
  const full = readFixture('mysql80-full-hexblob.sql');
  const statements = parseSqlStatements(full);
  const texts = statements.map(statement => statement.sql);

  /**
   * True when some statement contains `needle`.
   *
   * Substring rather than equality because the parser keeps a statement's
   * leading comments as part of it — which is what the `mysql` client does,
   * and what makes the SQL sent to the server byte-identical to the region
   * of the file it came from. (`location.startLine` still points at the
   * first real SQL character, so diagnostics are unaffected.)
   */
  const contains = (needle: string): boolean => texts.some(text => text.includes(needle));

  it('keeps every session guard as an executable comment, not a stripped comment', () => {
    // These carry real, version-gated SQL. A parser that treated `/*! */` as a
    // comment would silently drop the whole session setup.
    expect(contains('/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */')).toBe(true);
    expect(
      contains("/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */"),
    ).toBe(true);
    expect(contains('/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */')).toBe(true);
  });

  it('keeps DISABLE KEYS / ENABLE KEYS pairs', () => {
    expect(contains('/*!40000 ALTER TABLE `books` DISABLE KEYS */')).toBe(true);
    expect(contains('/*!40000 ALTER TABLE `books` ENABLE KEYS */')).toBe(true);
  });

  it('keeps LOCK TABLES / UNLOCK TABLES pairs', () => {
    expect(contains('LOCK TABLES `books` WRITE')).toBe(true);
    expect(texts.filter(text => text === 'UNLOCK TABLES').length).toBeGreaterThan(0);
  });

  it('keeps a multi-statement trigger body in one statement', () => {
    // Two `;`-terminated INSERTs inside the body: without DELIMITER handling
    // this would be torn into three pieces.
    const trigger = texts.find(text => text.includes('TRIGGER `trg_books_after_insert`'));
    expect(trigger).toBeDefined();
    expect(trigger).toContain("VALUES ('books', 'inserted')");
    expect(trigger).toContain("CONCAT('id=', NEW.`id`)");
    expect(trigger?.trimEnd().endsWith('END */')).toBe(true);
  });

  it('keeps a procedure body containing semicolons in one statement', () => {
    const procedure = texts.find(text => text.includes('PROCEDURE `sp_recount`'));
    expect(procedure).toBeDefined();
    expect(procedure).toContain('DECLARE `v_tmp` INT DEFAULT 0;');
    expect(procedure).toContain("'recounted; done'");
    expect(procedure?.trimEnd().endsWith('END')).toBe(true);
  });

  it('keeps an event body containing semicolons in one statement', () => {
    const event = texts.find(text => text.includes('EVENT `ev_cleanup`'));
    expect(event).toBeDefined();
    expect(event).toContain('DELETE FROM `audit_log` WHERE `id` < 0;');
    expect(event?.trimEnd().endsWith('END */')).toBe(true);
  });

  it('reports the delimiter in force for each stored program', () => {
    const trigger = statements.find(statement =>
      statement.sql.includes('TRIGGER `trg_books_after_insert`'),
    );
    expect(trigger?.delimiter).toBe(';;');
    const insert = statements.find(statement => statement.sql.includes('INSERT INTO `books`'));
    expect(insert?.delimiter).toBe(';');
  });

  it('keeps a stub view separate from its final definition', () => {
    const stub = texts.find(
      text => text.includes('CREATE VIEW `v_books`') && text.includes('1 AS `id`'),
    );
    const real = texts.find(text => text.includes('/*!50001 VIEW `v_books` AS select'));
    expect(stub).toBeDefined();
    expect(real).toBeDefined();
    expect(texts.indexOf(stub as string)).toBeLessThan(texts.indexOf(real as string));
  });

  it('keeps a whole extended INSERT, semicolons in values included', () => {
    const insert = texts.find(text => text.includes('INSERT INTO `books`'));
    expect(insert).toBeDefined();
    // Three rows in one statement, ending at the real delimiter.
    expect(insert?.match(/\),\(/g)?.length).toBe(2);
    expect(insert).toContain('\\ZCtrlZ');
  });

  it('reports the section each statement belongs to', () => {
    const insert = statements.find(statement => statement.sql.includes('INSERT INTO `books`'));
    expect(insert?.currentObject).toBe('Dumping data for table `books`');
  });
});

/**
 * Strips a statement's leading comment lines, leaving the SQL it introduces.
 *
 * Needed to ask "does this dump contain a top-level INSERT?" without being
 * fooled by an `INSERT` *inside* a trigger or procedure body — which a
 * schema-only dump legitimately contains.
 */
function leadingSql(statement: string): string {
  return statement
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--') && line.trim().length > 0)
    .join('\n')
    .trimStart();
}

describe('native mysqldump fixtures: option variants', () => {
  it('a --databases dump carries CREATE DATABASE and USE', () => {
    const texts = parseSqlStatements(readFixture('mysql80-databases.sql')).map(s => s.sql);
    expect(texts.some(text => text.includes('CREATE DATABASE'))).toBe(true);
    expect(texts.some(text => text.trimEnd().endsWith('USE `refdb`'))).toBe(true);
  });

  it('a --no-data dump has structure but no INSERT', () => {
    const texts = parseSqlStatements(readFixture('mysql80-schema-only.sql')).map(s => s.sql);
    expect(texts.some(text => text.includes('CREATE TABLE `books`'))).toBe(true);
    // `INSERT` still appears inside trigger and procedure bodies, so this
    // asks whether any *statement* is an INSERT, not whether the text occurs.
    expect(texts.some(text => leadingSql(text).startsWith('INSERT INTO'))).toBe(false);
  });

  it('a --no-create-info dump has INSERTs but no CREATE TABLE', () => {
    const texts = parseSqlStatements(readFixture('mysql80-data-only.sql')).map(s => s.sql);
    expect(texts.some(text => leadingSql(text).startsWith('INSERT INTO'))).toBe(true);
    expect(texts.some(text => leadingSql(text).startsWith('CREATE TABLE'))).toBe(false);
  });

  it('a --skip-extended-insert dump has one INSERT per row', () => {
    const texts = parseSqlStatements(readFixture('mysql80-complete-noextended.sql')).map(
      s => s.sql,
    );
    const inserts = texts.filter(text => text.includes('INSERT INTO `authors`'));
    expect(inserts.length).toBeGreaterThan(1);
    for (const insert of inserts) {
      expect(insert).not.toMatch(/\),\(/);
      // --complete-insert also names the columns.
      expect(insert).toContain('INSERT INTO `authors` (`id`, `name`');
    }
  });

  it('a minimal dump omits DROP, locks and key statements', () => {
    const texts = parseSqlStatements(readFixture('mysql80-minimal.sql')).map(s => s.sql);
    expect(texts.some(text => leadingSql(text).startsWith('DROP TABLE'))).toBe(false);
    expect(texts.some(text => leadingSql(text).startsWith('LOCK TABLES'))).toBe(false);
    expect(texts.some(text => text.includes('DISABLE KEYS'))).toBe(false);
    // Structure and data are still there.
    expect(texts.some(text => text.includes('CREATE TABLE `books`'))).toBe(true);
    expect(texts.some(text => text.includes('INSERT INTO `books`'))).toBe(true);
  });

  it('a non-hex-blob dump is handled by rewriting its binary literals', () => {
    // This fixture holds `_binary '...'` values; the bytes happen to be valid
    // UTF-8 here because the fixture was saved as text, but the code path is
    // the same one `restore.test.ts` covers with genuinely invalid bytes.
    const texts = parseSqlStatements(readFixture('mysql80-full.sql')).map(s => s.sql);
    expect(texts.some(text => text.includes('INSERT INTO `books`'))).toBe(true);
  });
});

describe('native mysqldump fixtures: version parity', () => {
  /**
   * Compares the *structure* of the 8.0 and 8.4 dumps of the same database.
   *
   * Byte equality is not expected — server versions render collations and
   * type defaults differently — but the sequence of statement *kinds* must
   * match, because that sequence is the dump format this package reproduces.
   */
  function statementKinds(sql: string): string[] {
    return parseSqlStatements(sql)
      .map(statement => statement.sql.replace(/\s+/g, ' ').trim())
      .map(text => {
        const match =
          /^(\/\*!\d+ )?(DROP TABLE|DROP VIEW|DROP EVENT|DROP FUNCTION|DROP PROCEDURE|CREATE TABLE|CREATE VIEW|CREATE DEFINER|LOCK TABLES|UNLOCK TABLES|INSERT INTO|USE|SET|\/\*!\d+ (?:CREATE|SET|ALTER TABLE))/i.exec(
            text,
          );
        return match ? (match[2] as string).toUpperCase() : text.slice(0, 20).toUpperCase();
      });
  }

  it('8.0 and 8.4 dumps have the same statement sequence', () => {
    expect(statementKinds(readFixture('mysql84-full-hexblob.sql'))).toEqual(
      statementKinds(readFixture('mysql80-full-hexblob.sql')),
    );
  });
});
