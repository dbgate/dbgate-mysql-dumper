import { describe, expect, it } from 'vitest';
import {
  InvalidDelimiterError,
  MalformedSqlDumpError,
  StatementTooLargeError,
  UnsupportedClientCommandError,
} from '../src/restore/errors.js';
import { SqlStatementParser, parseSqlStatements } from '../src/restore/statementParser.js';
import type { SqlStatementParserOptions } from '../src/restore/statementParser.js';

/**
 * The byte-string form `SqlStatementParser.push` consumes: one code unit per
 * UTF-8 byte. Splitting *this* is what a real stream does, so the
 * chunk-boundary tests below exercise genuine byte boundaries — including
 * ones that fall in the middle of a multi-byte character.
 */
function toByteString(sql: string): string {
  return Buffer.from(sql, 'utf8').toString('latin1');
}

/**
 * Feeds `sql` through the parser one chunk at a time, splitting at `size`
 * bytes. Used to prove that statement boundaries are found identically no
 * matter where the stream happens to break.
 */
function parseInChunks(sql: string, size: number, options?: SqlStatementParserOptions): string[] {
  const bytes = toByteString(sql);
  const parser = new SqlStatementParser(options);
  const statements: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    for (const statement of parser.push(bytes.slice(offset, offset + size))) {
      statements.push(statement.sql);
    }
  }
  for (const statement of parser.finish()) {
    statements.push(statement.sql);
  }
  return statements;
}

function texts(sql: string, options?: SqlStatementParserOptions): string[] {
  return parseSqlStatements(sql, options).map(statement => statement.sql);
}

describe('SqlStatementParser: basic splitting', () => {
  it('splits on semicolons and drops the delimiter', () => {
    expect(texts('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('emits a trailing statement with no delimiter', () => {
    expect(texts('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('ignores empty statements and stray delimiters', () => {
    expect(texts(';;;\n\n;  ;')).toEqual([]);
  });

  it('does not split on a semicolon inside a single-quoted string', () => {
    expect(texts(`INSERT INTO t VALUES ('a;b'); SELECT 2;`)).toEqual([
      `INSERT INTO t VALUES ('a;b')`,
      'SELECT 2',
    ]);
  });

  it('does not split on a semicolon inside a double-quoted string', () => {
    expect(texts(`INSERT INTO t VALUES ("a;b");`)).toEqual([`INSERT INTO t VALUES ("a;b")`]);
  });

  it('does not split on a semicolon inside a backtick identifier', () => {
    expect(texts('SELECT `we;ird` FROM t;')).toEqual(['SELECT `we;ird` FROM t']);
  });

  it('handles doubled quotes inside strings', () => {
    expect(texts(`SELECT 'it''s; fine';`)).toEqual([`SELECT 'it''s; fine'`]);
    expect(texts(`SELECT "he said ""hi;""";`)).toEqual([`SELECT "he said ""hi;"""`]);
  });

  it('handles doubled backticks inside identifiers', () => {
    expect(texts('SELECT `a``b;c` FROM t;')).toEqual(['SELECT `a``b;c` FROM t']);
  });

  it('honors backslash escapes inside strings', () => {
    expect(texts(`SELECT 'a\\'; still string';`)).toEqual([`SELECT 'a\\'; still string'`]);
    expect(texts(`SELECT 'ends with backslash\\\\'; SELECT 2;`)).toEqual([
      `SELECT 'ends with backslash\\\\'`,
      'SELECT 2',
    ]);
  });

  it('treats a backslash as literal inside a backtick identifier', () => {
    // MySQL has no backslash escape inside quoted identifiers, so the
    // backtick right after the backslash really does close the identifier.
    expect(texts('SELECT `a\\` , 1;')).toEqual(['SELECT `a\\` , 1']);
  });
});

describe('SqlStatementParser: comments', () => {
  it('ignores a semicolon in a -- comment', () => {
    expect(texts('SELECT 1 -- a; comment\n;')).toEqual(['SELECT 1 -- a; comment']);
  });

  it('requires whitespace after -- for a comment', () => {
    // `5--3` is arithmetic in MySQL, not a comment, so the `;` still splits.
    expect(texts('SELECT 5--3; SELECT 2;')).toEqual(['SELECT 5--3', 'SELECT 2']);
  });

  it('ignores a semicolon in a # comment', () => {
    expect(texts('SELECT 1 # a; comment\n;')).toEqual(['SELECT 1 # a; comment']);
  });

  it('ignores a semicolon in a block comment', () => {
    expect(texts('SELECT 1 /* a; comment */;')).toEqual(['SELECT 1 /* a; comment */']);
  });

  it('does not treat block comments as nesting', () => {
    // MySQL block comments do not nest: the first */ closes the comment.
    expect(texts('SELECT /* outer /* inner */ 1;')).toEqual(['SELECT /* outer /* inner */ 1']);
  });

  it('skips a statement that is only comments', () => {
    expect(texts('-- just a comment\n/* and another */\n;')).toEqual([]);
  });
});

describe('SqlStatementParser: executable comments', () => {
  it('keeps an executable comment as part of the statement', () => {
    expect(texts('/*!40101 SET @OLD=@@SQL_MODE */;')).toEqual(['/*!40101 SET @OLD=@@SQL_MODE */']);
  });

  it('treats an executable comment as content, not as an empty statement', () => {
    const statements = parseSqlStatements('/*!40000 ALTER TABLE `t` DISABLE KEYS */;');
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toBe('/*!40000 ALTER TABLE `t` DISABLE KEYS */');
  });

  it('keeps an optimizer hint as part of the statement', () => {
    expect(texts('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1;')).toEqual([
      'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1',
    ]);
  });

  it('splits on a delimiter inside an executable comment', () => {
    // This is genuine MySQL client behaviour — and precisely why mysqldump
    // wraps stored programs in a DELIMITER region.
    expect(texts('/*!50003 CREATE PROCEDURE p() BEGIN SELECT 1; END */;')).toEqual([
      '/*!50003 CREATE PROCEDURE p() BEGIN SELECT 1',
      'END */',
    ]);
  });

  it('tracks quotes inside an executable comment', () => {
    expect(texts(`/*!40101 SET SQL_MODE='A;B' */; SELECT 1;`)).toEqual([
      `/*!40101 SET SQL_MODE='A;B' */`,
      'SELECT 1',
    ]);
  });

  it('keeps MariaDB executable comments and skips the client sandbox directive', () => {
    const script = [
      '/*M!999999\\- enable the sandbox mode */',
      '/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;',
      'SELECT 1;',
    ].join('\n');
    expect(texts(script)).toEqual([
      '/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */',
      'SELECT 1',
    ]);
  });

  it('parses native MariaDB syntax identically at every byte boundary', () => {
    const script = [
      '/*M!999999\\- enable the sandbox mode */',
      '/*M!100616 SET NOTE_VERBOSITY=0 */;',
      'DELIMITER ;;',
      "CREATE PROCEDURE `p`() BEGIN SELECT 'Zażółć; 😀'; END ;;",
      'DELIMITER ;',
      'SELECT 2;',
    ].join('\n');
    const reference = parseInChunks(script, 65_536);
    for (const size of [4_096, 100, 7, 2, 1]) {
      expect(parseInChunks(script, size), `chunk size ${size}`).toEqual(reference);
    }
  });
});

describe('SqlStatementParser: DELIMITER', () => {
  const routineScript = [
    'DELIMITER ;;',
    'CREATE PROCEDURE `p`()',
    'BEGIN',
    '  INSERT INTO t VALUES (1);',
    '  INSERT INTO t VALUES (2);',
    'END ;;',
    'DELIMITER ;',
    'SELECT 1;',
  ].join('\n');

  it('consumes DELIMITER and never emits it as a statement', () => {
    const statements = texts(routineScript);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(
      [
        'CREATE PROCEDURE `p`()',
        'BEGIN',
        '  INSERT INTO t VALUES (1);',
        '  INSERT INTO t VALUES (2);',
        'END',
      ].join('\n'),
    );
    expect(statements[1]).toBe('SELECT 1');
  });

  it('supports arbitrary delimiter strings', () => {
    const script = 'DELIMITER $$\nSELECT 1; SELECT 2;$$\nDELIMITER ;\nSELECT 3;';
    expect(texts(script)).toEqual(['SELECT 1; SELECT 2;', 'SELECT 3']);
  });

  it('supports a multi-character word delimiter', () => {
    const script = 'DELIMITER GO\nSELECT 1;\nGO\nDELIMITER ;\nSELECT 2;';
    expect(texts(script)).toEqual(['SELECT 1;', 'SELECT 2']);
  });

  it('accepts a quoted delimiter argument', () => {
    expect(texts(`DELIMITER '||'\nSELECT 1;||\nDELIMITER ;\nSELECT 2;`)).toEqual([
      'SELECT 1;',
      'SELECT 2',
    ]);
  });

  it('ignores the rest of the DELIMITER line', () => {
    expect(texts('DELIMITER ;; -- switch\nSELECT 1;;')).toEqual(['SELECT 1']);
  });

  it('is case insensitive', () => {
    expect(texts('delimiter ;;\nSELECT 1;;')).toEqual(['SELECT 1']);
  });

  it('does not treat the word delimiter inside a statement as a command', () => {
    expect(texts('SELECT delimiter FROM t;')).toEqual(['SELECT delimiter FROM t']);
    expect(texts('SELECT 1;\nSELECT `delimiter` FROM t;')).toEqual([
      'SELECT 1',
      'SELECT `delimiter` FROM t',
    ]);
  });

  it('does not treat a delimiter word inside a string as a command', () => {
    expect(texts(`SELECT 'delimiter ;;';`)).toEqual([`SELECT 'delimiter ;;'`]);
  });

  it('reports the delimiter in force on each statement', () => {
    const statements = parseSqlStatements(routineScript);
    expect(statements[0]?.delimiter).toBe(';;');
    expect(statements[1]?.delimiter).toBe(';');
  });

  it('rejects a delimiter containing a backslash', () => {
    expect(() => texts('DELIMITER \\\\\nSELECT 1;')).toThrow(InvalidDelimiterError);
  });

  it('rejects an empty delimiter', () => {
    expect(() => texts('DELIMITER \nSELECT 1;')).toThrow(InvalidDelimiterError);
  });

  it('honors an initialDelimiter option', () => {
    expect(texts('SELECT 1$$SELECT 2$$', { initialDelimiter: '$$' })).toEqual([
      'SELECT 1',
      'SELECT 2',
    ]);
  });
});

describe('SqlStatementParser: unsupported client commands', () => {
  it('rejects source', () => {
    expect(() => texts('source other.sql\n')).toThrow(UnsupportedClientCommandError);
  });

  it('rejects system', () => {
    expect(() => texts('system rm -rf /\n')).toThrow(UnsupportedClientCommandError);
  });

  it('does not reject a column named source used in SQL', () => {
    expect(texts('SELECT source FROM t;')).toEqual(['SELECT source FROM t']);
  });
});

describe('SqlStatementParser: malformed input', () => {
  it('rejects an unterminated string', () => {
    expect(() => texts(`SELECT 'oops`)).toThrow(MalformedSqlDumpError);
  });

  it('rejects an unterminated identifier', () => {
    expect(() => texts('SELECT `oops')).toThrow(MalformedSqlDumpError);
  });

  it('rejects an unterminated block comment', () => {
    expect(() => texts('SELECT 1 /* oops')).toThrow(MalformedSqlDumpError);
  });

  it('enforces the statement size limit', () => {
    const huge = `SELECT '${'x'.repeat(5000)}'`;
    expect(() => texts(huge, { maxStatementBytes: 1024 })).toThrow(StatementTooLargeError);
  });
});

describe('SqlStatementParser: sql_mode tracking', () => {
  it('disables backslash escapes after NO_BACKSLASH_ESCAPES is set', () => {
    const script = [`SET sql_mode='NO_BACKSLASH_ESCAPES';`, `SELECT 'a\\'; SELECT 2;`].join('\n');
    // With NO_BACKSLASH_ESCAPES the backslash is literal, so the quote right
    // after it closes the string and the `;` really does end the statement.
    expect(texts(script)).toEqual([
      `SET sql_mode='NO_BACKSLASH_ESCAPES'`,
      `SELECT 'a\\'`,
      'SELECT 2',
    ]);
  });

  it('keeps backslash escapes for a mysqldump header', () => {
    const script = [
      `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;`,
      `SELECT 'a\\'; still string';`,
    ].join('\n');
    expect(texts(script)).toEqual([
      `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */`,
      `SELECT 'a\\'; still string'`,
    ]);
  });

  it('can be pinned with the backslashEscapes option', () => {
    expect(texts(`SELECT 'a\\'; SELECT 2;`, { backslashEscapes: 'disabled' })).toEqual([
      `SELECT 'a\\'`,
      'SELECT 2',
    ]);
  });
});

describe('SqlStatementParser: locations and metadata', () => {
  it('reports 1-based line ranges', () => {
    const statements = parseSqlStatements('SELECT 1;\n\nSELECT\n  2;\n');
    expect(statements[0]?.location).toEqual({ startLine: 1, endLine: 1 });
    expect(statements[1]?.location.startLine).toBe(3);
    expect(statements[1]?.location.endLine).toBe(4);
  });

  it('reports the current mysqldump section', () => {
    const script = [
      '--',
      '-- Dumping data for table `books`',
      '--',
      '',
      'INSERT INTO `books` VALUES (1);',
    ].join('\n');
    const statements = parseSqlStatements(script);
    expect(statements[0]?.currentObject).toBe('Dumping data for table `books`');
  });

  it('counts consumed bytes including multi-byte characters', () => {
    const sql = "SELECT 'é';";
    const parser = new SqlStatementParser();
    parser.push(toByteString(sql));
    parser.finish();
    expect(parser.bytesConsumed).toBe(Buffer.byteLength(sql, 'utf8'));
  });

  it('decodes multi-byte text correctly even when a chunk splits a character', () => {
    const sql = "SELECT 'é 😀 中';";
    const bytes = toByteString(sql);
    for (let split = 0; split <= bytes.length; split++) {
      const parser = new SqlStatementParser();
      const statements = [
        ...parser.push(bytes.slice(0, split)),
        ...parser.push(bytes.slice(split)),
        ...parser.finish(),
      ];
      expect(
        statements.map(statement => statement.sql),
        `split at ${split}`,
      ).toEqual(["SELECT 'é 😀 中'"]);
    }
  });
});

describe('SqlStatementParser: chunk-boundary invariance', () => {
  const script = [
    '-- header',
    `/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;`,
    'DROP TABLE IF EXISTS `t`;',
    'CREATE TABLE `t` (`id` int, `s` varchar(50));',
    `INSERT INTO \`t\` VALUES (1,'a;b'),(2,'c\\'d'),(3,'e\\\\'),(4,"f;g"),(5,'ünïcode 😀');`,
    'DELIMITER ;;',
    'CREATE TRIGGER `tr` AFTER INSERT ON `t` FOR EACH ROW',
    'BEGIN',
    "  INSERT INTO `log` VALUES ('a;b');",
    '  INSERT INTO `log` VALUES (2);',
    'END ;;',
    'DELIMITER ;',
    '/*!50106 DROP EVENT IF EXISTS `e` */;',
    'SELECT 1 -- trailing; comment',
    ';',
  ].join('\n');

  const reference = texts(script);

  it('produces the same statements at every chunk size', () => {
    expect(reference.length).toBeGreaterThan(5);
    for (let size = 1; size <= Buffer.byteLength(script, 'utf8'); size++) {
      expect(parseInChunks(script, size), `chunk size ${size}`).toEqual(reference);
    }
  });

  it('produces the same statements for every single split point', () => {
    const bytes = toByteString(script);
    for (let split = 0; split <= bytes.length; split++) {
      const parser = new SqlStatementParser();
      const collected = [
        ...parser.push(bytes.slice(0, split)),
        ...parser.push(bytes.slice(split)),
        ...parser.finish(),
      ].map(statement => statement.sql);
      expect(collected, `split at ${split}`).toEqual(reference);
    }
  });
});

describe('SqlStatementParser: hostile input hardening', () => {
  /**
   * Regression: an unbounded lookahead in the client-command detector let a
   * single long run of letters at the start of a statement grow the
   * cross-chunk carry buffer without limit, re-scanning it on every `push()`
   * and turning the parse quadratic.
   */
  it('does not buffer without bound on a long run of letters', () => {
    const letters = 'a'.repeat(200_000);
    const parser = new SqlStatementParser();
    const statements: string[] = [];
    const bytes = toByteString(`${letters};`);
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      for (const statement of parser.push(bytes.slice(offset, offset + 4096))) {
        statements.push(statement.sql);
      }
    }
    for (const statement of parser.finish()) {
      statements.push(statement.sql);
    }
    expect(statements).toEqual([letters]);
  });

  it('completes a pathological one-line input in reasonable time', () => {
    // Previously O(n^2): the line-start check scanned backwards to the
    // previous newline for every character of a long whitespace run.
    const script = `${' '.repeat(200_000)}SELECT 1;`;
    const started = Date.now();
    expect(texts(script)).toEqual(['SELECT 1']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects an absurdly long DELIMITER argument instead of buffering it', () => {
    expect(() => texts(`DELIMITER ${'x'.repeat(500)}\nSELECT 1;`)).toThrow(InvalidDelimiterError);
  });

  it('still recognizes DELIMITER when its first letter lands on a chunk boundary', () => {
    // Regression: the character held back across a chunk boundary had already
    // cleared the "at line start" flag, so `DELIMITER` was executed as SQL and
    // every stored program in the dump was silently split.
    const script = 'SELECT 1;\nDELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 2; END ;;\n';
    const bytes = toByteString(script);
    const boundary = script.indexOf('DELIMITER');
    const parser = new SqlStatementParser();
    const statements = [
      ...parser.push(bytes.slice(0, boundary)),
      ...parser.push(bytes.slice(boundary)),
      ...parser.finish(),
    ].map(statement => statement.sql);
    expect(statements).toEqual(['SELECT 1', 'CREATE PROCEDURE p() BEGIN SELECT 2; END']);
  });

  it('treats a command word as SQL when it is not line-initial', () => {
    expect(texts('SELECT 1; delimiter x;')).toEqual(['SELECT 1', 'delimiter x']);
  });

  it('does not treat a line-initial command word inside a block comment as a command', () => {
    // The comment spans lines, so a naive "previous character was a newline"
    // rule would fire on the `delimiter` inside it.
    expect(texts('/*\ndelimiter ;;\n*/ SELECT 1;')).toEqual(['/*\ndelimiter ;;\n*/ SELECT 1']);
  });

  it('does not treat a line-initial command word inside a string as a command', () => {
    expect(texts("SELECT '\ndelimiter ;;\n';")).toEqual(["SELECT '\ndelimiter ;;\n'"]);
  });
});
