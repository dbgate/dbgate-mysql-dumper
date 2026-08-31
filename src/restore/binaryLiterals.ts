import { isUtf8 } from 'node:buffer';

/**
 * Makes a statement containing raw binary bytes safe to send as text.
 *
 * `mysqldump`'s **default** (without `--hex-blob`) writes a `BLOB`,
 * `VARBINARY` or `BIT` value as `_binary '...'` holding the column's raw
 * bytes. Such a dump is not valid UTF-8, and the MySQL client protocol has
 * no way to send a query as opaque bytes through a JavaScript driver: every
 * driver — `mysql2` included — encodes the statement string using the
 * connection's character set. Decoding those bytes as UTF-8 first would
 * replace each invalid sequence with U+FFFD, so a `0xFF` byte in a `BLOB`
 * would restore as `EF BF BD` — silent, permanent corruption of exactly the
 * data a dump exists to preserve.
 *
 * Rather than refusing such dumps, this rewrites each offending literal into
 * the hexadecimal form MySQL treats as identical:
 *
 * ```
 * INSERT INTO t VALUES (_binary '<raw bytes>')   ->   INSERT INTO t VALUES (0x...)
 * ```
 *
 * `0x...` and `_binary '...'` denote the same byte string to MySQL — it is
 * the very substitution `--hex-blob` performs at dump time — so the restored
 * value is byte-identical, and the rewritten statement is pure ASCII and
 * therefore survives any encoding on the way to the server.
 *
 * Only literals that are *not* valid UTF-8 are touched. A statement whose
 * bytes are already valid UTF-8 is returned untouched, which is every
 * statement of a `--hex-blob` dump and every statement of one produced by
 * this package's defaults, so the common path costs one `isUtf8` scan.
 */

const enum Byte {
  Tab = 0x09,
  NewLine = 0x0a,
  Return = 0x0d,
  Substitute = 0x1a,
  Space = 0x20,
  DoubleQuote = 0x22,
  Hash = 0x23,
  SingleQuote = 0x27,
  Asterisk = 0x2a,
  Minus = 0x2d,
  Slash = 0x2f,
  Zero = 0x30,
  Backslash = 0x5c,
  Backtick = 0x60,
  LowerB = 0x62,
  LowerN = 0x6e,
  LowerR = 0x72,
  LowerZ = 0x5a,
}

/** Bytes MySQL's `mysql_real_escape_string` produces an escape sequence for, reversed. */
const UNESCAPE: ReadonlyMap<number, number> = new Map([
  [Byte.Zero, 0x00],
  [Byte.LowerN, Byte.NewLine],
  [Byte.LowerR, Byte.Return],
  [Byte.LowerZ, Byte.Substitute],
  [Byte.LowerB, 0x08],
  [0x74, Byte.Tab],
]);

export interface BinaryLiteralRewriteResult {
  /** The statement, guaranteed to be valid UTF-8 unless {@link failed} is set. */
  readonly bytes: Buffer;
  /** How many `_binary '...'` literals were converted to hexadecimal. */
  readonly rewrittenLiterals: number;
  /**
   * Set when the statement still holds non-UTF-8 bytes *outside* any string
   * literal — which no `mysqldump` output produces, and which cannot be
   * repaired without guessing. The caller reports it rather than sending
   * corrupted SQL.
   */
  readonly failed?: string;
}

/**
 * Returns `statement` unchanged when it is already valid UTF-8, and
 * otherwise with every non-UTF-8 string literal converted to a hexadecimal
 * literal.
 */
export function rewriteBinaryLiterals(statement: Buffer): BinaryLiteralRewriteResult {
  if (isUtf8(statement)) {
    return { bytes: statement, rewrittenLiterals: 0 };
  }

  const parts: Buffer[] = [];
  let copiedFrom = 0;
  let rewrittenLiterals = 0;
  let index = 0;

  while (index < statement.length) {
    const byte = statement[index] as number;

    if (byte === Byte.Hash) {
      index = skipToEndOfLine(statement, index);
      continue;
    }
    if (
      byte === Byte.Minus &&
      statement[index + 1] === Byte.Minus &&
      isCommentBoundary(statement[index + 2])
    ) {
      index = skipToEndOfLine(statement, index);
      continue;
    }
    if (byte === Byte.Slash && statement[index + 1] === Byte.Asterisk) {
      const marker = statement[index + 2];
      // `/*!` and `/*+` are SQL, not comments — keep scanning their contents
      // so a binary literal inside one is still found.
      if (marker !== 0x21 && marker !== 0x2b) {
        index = skipBlockComment(statement, index);
        continue;
      }
      index += 2;
      continue;
    }
    if (byte === Byte.Backtick) {
      index = skipQuoted(statement, index, Byte.Backtick, false);
      continue;
    }
    if (byte === Byte.DoubleQuote) {
      index = skipQuoted(statement, index, Byte.DoubleQuote, true);
      continue;
    }
    if (byte === Byte.SingleQuote) {
      const end = skipQuoted(statement, index, Byte.SingleQuote, true);
      const content = statement.subarray(index + 1, end - 1);
      if (!isUtf8(content)) {
        const introducerStart = findBinaryIntroducer(statement, index);
        parts.push(statement.subarray(copiedFrom, introducerStart));
        parts.push(Buffer.from(toHexLiteral(unescape(content)), 'latin1'));
        copiedFrom = end;
        rewrittenLiterals++;
      }
      index = end;
      continue;
    }
    index++;
  }

  parts.push(statement.subarray(copiedFrom));
  const bytes = Buffer.concat(parts);

  if (!isUtf8(bytes)) {
    return {
      bytes,
      rewrittenLiterals,
      failed:
        "The statement contains bytes that are not valid UTF-8 outside of any string literal, so it cannot be sent to the server without corrupting them. Re-create the dump with hexadecimal binary literals (`mysqldump --hex-blob`, or this package's default `hexBlob: true`).",
    };
  }
  return { bytes, rewrittenLiterals };
}

/** MySQL treats `--` as a comment only when followed by whitespace or end of input. */
function isCommentBoundary(byte: number | undefined): boolean {
  return (
    byte === undefined ||
    byte === Byte.Space ||
    byte === Byte.Tab ||
    byte === Byte.NewLine ||
    byte === Byte.Return
  );
}

function skipToEndOfLine(statement: Buffer, index: number): number {
  const newline = statement.indexOf(Byte.NewLine, index);
  return newline === -1 ? statement.length : newline + 1;
}

function skipBlockComment(statement: Buffer, index: number): number {
  for (let scan = index + 2; scan < statement.length - 1; scan++) {
    if (statement[scan] === Byte.Asterisk && statement[scan + 1] === Byte.Slash) {
      return scan + 2;
    }
  }
  return statement.length;
}

/** Returns the index just past the closing quote at `index`. */
function skipQuoted(
  statement: Buffer,
  index: number,
  quote: number,
  backslashEscapes: boolean,
): number {
  let scan = index + 1;
  while (scan < statement.length) {
    const byte = statement[scan] as number;
    if (backslashEscapes && byte === Byte.Backslash) {
      scan += 2;
      continue;
    }
    if (byte === quote) {
      if (statement[scan + 1] === quote) {
        scan += 2;
        continue;
      }
      return scan + 1;
    }
    scan++;
  }
  return statement.length;
}

/**
 * Finds the start of an `_binary` (or `_utf8mb4`-style) introducer
 * immediately preceding the literal at `quoteIndex`, so it can be dropped
 * along with the literal it introduces. Returns `quoteIndex` when there is
 * none.
 */
function findBinaryIntroducer(statement: Buffer, quoteIndex: number): number {
  let scan = quoteIndex;
  while (scan > 0 && (statement[scan - 1] === Byte.Space || statement[scan - 1] === Byte.Tab)) {
    scan--;
  }
  const wordEnd = scan;
  while (scan > 0) {
    const byte = statement[scan - 1] as number;
    const isWordByte =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x5f;
    if (!isWordByte) {
      break;
    }
    scan--;
  }
  const word = statement.subarray(scan, wordEnd).toString('latin1');
  return /^_[A-Za-z0-9]+$/.test(word) ? scan : quoteIndex;
}

/** Reverses MySQL's string-literal escaping, yielding the literal's actual bytes. */
function unescape(content: Buffer): Buffer {
  const output = Buffer.allocUnsafe(content.length);
  let length = 0;
  let index = 0;
  while (index < content.length) {
    const byte = content[index] as number;
    if (byte === Byte.Backslash && index + 1 < content.length) {
      const next = content[index + 1] as number;
      output[length++] = UNESCAPE.get(next) ?? next;
      index += 2;
      continue;
    }
    if (byte === Byte.SingleQuote && content[index + 1] === Byte.SingleQuote) {
      output[length++] = Byte.SingleQuote;
      index += 2;
      continue;
    }
    output[length++] = byte;
    index++;
  }
  return output.subarray(0, length);
}

/**
 * Renders bytes as a MySQL hexadecimal literal. Zero-length input becomes
 * `''`, because MySQL's hexadecimal grammar requires at least one digit
 * pair and `0x` alone is a syntax error.
 */
function toHexLiteral(bytes: Buffer): string {
  return bytes.length === 0 ? "''" : `0x${bytes.toString('hex').toUpperCase()}`;
}
