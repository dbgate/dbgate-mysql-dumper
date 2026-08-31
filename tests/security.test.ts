import { describe, expect, it } from 'vitest';
import { MysqlDumperError } from '../src/utils/errors.js';
import {
  quoteDefiner,
  quoteIdentifier,
  quoteQualifiedIdentifier,
} from '../src/security/identifiers.js';
import {
  escapeMysqlString,
  formatNumberLiteral,
  isSafeNumericLiteral,
  quoteMysqlBytes,
  quoteMysqlString,
  renderHexLiteral,
} from '../src/security/literals.js';

describe('quoteIdentifier', () => {
  it('always quotes with backticks', () => {
    expect(quoteIdentifier('books')).toBe('`books`');
    expect(quoteIdentifier('SELECT')).toBe('`SELECT`');
  });

  it('doubles embedded backticks', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we``ird`');
    // Two backticks become four, wrapped in one more pair: six in total.
    expect(quoteIdentifier('``')).toBe('`'.repeat(6));
  });

  it('leaves other characters untouched', () => {
    expect(quoteIdentifier('a\'b"c\\d;e')).toBe('`a\'b"c\\d;e`');
    expect(quoteIdentifier('😀 表')).toBe('`😀 表`');
  });

  it('rejects a NUL character, which MySQL forbids in an identifier', () => {
    expect(() => quoteIdentifier(`a${String.fromCharCode(0)}b`)).toThrow(MysqlDumperError);
  });

  it('joins qualified paths', () => {
    expect(quoteQualifiedIdentifier(['db', 'orders'])).toBe('`db`.`orders`');
  });
});

describe('quoteDefiner', () => {
  it('quotes user and host separately', () => {
    expect(quoteDefiner('root@localhost')).toBe('`root`@`localhost`');
    expect(quoteDefiner('app@%')).toBe('`app`@`%`');
  });

  it('splits on the last @, since a user name may contain one', () => {
    expect(quoteDefiner('me@example.com@%')).toBe('`me@example.com`@`%`');
  });

  it('handles a bare user name with no host', () => {
    expect(quoteDefiner('root')).toBe('`root`');
  });

  it('escapes backticks in either part', () => {
    expect(quoteDefiner('a`b@c`d')).toBe('`a``b`@`c``d`');
  });
});

describe('escapeMysqlString', () => {
  /**
   * The exact set `mysql_real_escape_string_quote` escapes. Verified against
   * real mysqldump output in `tests/fixtures/native/`.
   */
  it('escapes exactly the seven characters MySQL escapes', () => {
    expect(escapeMysqlString(String.fromCharCode(0))).toBe('\\0');
    expect(escapeMysqlString('\n')).toBe('\\n');
    expect(escapeMysqlString('\r')).toBe('\\r');
    expect(escapeMysqlString(String.fromCharCode(0x1a))).toBe('\\Z');
    expect(escapeMysqlString('"')).toBe('\\"');
    expect(escapeMysqlString("'")).toBe("\\'");
    expect(escapeMysqlString('\\')).toBe('\\\\');
  });

  it('does not escape a tab, matching mysqldump', () => {
    // A literal tab inside a quoted string is valid MySQL; mysqldump leaves
    // it alone, and the native fixtures contain a raw tab in a value.
    expect(escapeMysqlString('a\tb')).toBe('a\tb');
  });

  it('leaves ordinary text untouched and allocates nothing extra', () => {
    const plain = 'ordinary text 123';
    expect(escapeMysqlString(plain)).toBe(plain);
  });

  it('passes multi-byte characters through unchanged', () => {
    expect(escapeMysqlString('café 中文 😀')).toBe('café 中文 😀');
    // An astral character is two UTF-16 code units; neither may be mistaken
    // for an ASCII character needing an escape.
    expect(escapeMysqlString('😀')).toHaveLength(2);
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeMysqlString("a'b'c")).toBe("a\\'b\\'c");
    expect(escapeMysqlString('\\\\')).toBe('\\\\\\\\');
  });

  it('quotes a complete literal', () => {
    expect(quoteMysqlString("it's")).toBe("'it\\'s'");
    expect(quoteMysqlString('')).toBe("''");
  });
});

describe('quoteMysqlBytes', () => {
  it('escapes bytes and keeps them intact', () => {
    const bytes = Buffer.from([0x00, 0x0a, 0x0d, 0x1a, 0x22, 0x27, 0x5c, 0xff]);
    expect(quoteMysqlBytes(bytes).toString('latin1')).toBe(
      "'\\0\\n\\r\\Z\\\"\\'\\\\" + String.fromCharCode(0xff) + "'",
    );
  });

  it('preserves bytes that are not valid UTF-8', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x80]);
    const quoted = quoteMysqlBytes(bytes);
    expect(quoted.subarray(1, -1)).toEqual(bytes);
  });

  it('handles empty input', () => {
    expect(quoteMysqlBytes(Buffer.alloc(0)).toString('latin1')).toBe("''");
  });
});

describe('renderHexLiteral', () => {
  it('renders uppercase hexadecimal like mysqldump', () => {
    expect(renderHexLiteral(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe('0xDEADBEEF');
    expect(renderHexLiteral(Buffer.from([0x00, 0x01]))).toBe('0x0001');
  });

  it("renders zero-length input as '', since 0x alone is a syntax error", () => {
    expect(renderHexLiteral(Buffer.alloc(0))).toBe("''");
  });
});

describe('numeric literals', () => {
  it('accepts every shape MySQL parses as a number', () => {
    for (const value of ['0', '-1', '1.5', '.5', '-0.0000000001', '1e300', '3.4e38', '+7']) {
      expect(isSafeNumericLiteral(value), value).toBe(true);
    }
  });

  it('rejects anything that could break statement syntax', () => {
    for (const value of ["1'); DROP TABLE t; --", '1 2', 'NULL', '', '0x10', 'abc', '1,2']) {
      expect(isSafeNumericLiteral(value), value).toBe(false);
    }
  });

  it('formats a finite number with the shortest round-tripping form', () => {
    expect(formatNumberLiteral(1.5)).toBe('1.5');
    expect(formatNumberLiteral(-0)).toBe('0');
    // Exponential notation is kept: MySQL accepts it, and expanding
    // 1.7976931348623157e308 would produce a 309-digit literal MySQL parses
    // as DECIMAL and rejects.
    expect(formatNumberLiteral(1.7976931348623157e308)).toBe('1.7976931348623157e+308');
  });

  it('refuses non-finite values rather than emitting invalid SQL', () => {
    expect(() => formatNumberLiteral(Number.NaN)).toThrow();
    expect(() => formatNumberLiteral(Number.POSITIVE_INFINITY)).toThrow();
  });
});
