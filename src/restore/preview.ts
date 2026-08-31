/**
 * Redacts the value side of MySQL's credential-carrying clauses, so a
 * failing `CREATE USER` / `ALTER USER` / `CHANGE MASTER TO` statement never
 * echoes an actual secret into a preview, a diagnostic, or an error message.
 *
 * Deliberately narrow and pattern-based rather than a parser: it covers the
 * specific syntax MySQL itself uses for credentials, not arbitrary
 * "looks sensitive" text.
 */
const SQL_SECRET_PATTERNS: readonly RegExp[] = [
  // CREATE USER ... IDENTIFIED BY 'secret' / IDENTIFIED WITH plugin BY 'secret'
  /(IDENTIFIED\s+(?:WITH\s+\S+\s+)?(?:BY|AS)\s+)'(?:[^'\\]|\\.|'')*'/gi,
  // IDENTIFIED ... AS 0x... (a hashed password scripted as a binary literal)
  /(IDENTIFIED\s+(?:WITH\s+\S+\s+)?AS\s+)0x[0-9A-Fa-f]+/gi,
  // CHANGE MASTER TO MASTER_PASSWORD = 'secret', and the 8.0.23+ SOURCE_ spelling
  /((?:MASTER_PASSWORD|SOURCE_PASSWORD|PASSWORD)\s*=\s*)'(?:[^'\\]|\\.|'')*'/gi,
  // SET PASSWORD ... = 'secret' / PASSWORD('secret')
  /(\bPASSWORD\s*\(\s*)'(?:[^'\\]|\\.|'')*'/gi,
];

export function redactSecrets(text: string): string {
  return SQL_SECRET_PATTERNS.reduce(
    (result, pattern) =>
      result.replace(pattern, (_match, prefix: string) => `${prefix}'***REDACTED***'`),
    text,
  );
}

/**
 * Truncates SQL for inclusion in an error message or a progress event.
 *
 * Never a full statement — a single extended `INSERT` can be a megabyte —
 * and never a literal credential value.
 */
export function safeSqlPreview(sql: string, maximumLength = 200): string {
  const normalized = redactSecrets(sql).trim().replace(/\s+/g, ' ');
  if (normalized.length <= maximumLength) {
    return normalized;
  }
  let cut = normalized.slice(0, maximumLength);
  // Never split a surrogate pair: an emoji straddling the cut would leave a
  // lone high surrogate, making the preview ill-formed UTF-16 —
  // `JSON.stringify` would emit an unpaired `\ud83d`, and writing it as UTF-8
  // would substitute U+FFFD.
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** The header line every dump this package writes begins with. */
const DUMP_HEADER_PREFIX = '-- MySQL dump ';

/**
 * Heuristically detects whether `sample` looks like a MySQL SQL dump —
 * whether produced by `mysqldump` or by this package.
 *
 * Both write the same `-- MySQL dump 10.13  Distrib ...` header, so a single
 * check covers both; the `Distrib` half names the producer and is
 * deliberately *not* part of the test. As a fallback for a dump whose header
 * comments were suppressed, the characteristic session-guard preamble is
 * accepted too.
 *
 * Only the first few kilobytes need to be supplied; the check never reads
 * beyond what it is given, so a caller can pass the head of a large file.
 */
export function isMysqlDump(sample: string | Uint8Array): boolean {
  const text = typeof sample === 'string' ? sample : Buffer.from(sample).toString('utf8');
  const head = text.slice(0, 8192);
  if (head.trimStart().startsWith(DUMP_HEADER_PREFIX)) {
    return true;
  }
  return (
    /\/\*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT \*\//.test(head) ||
    /\/\*!40101 SET @OLD_SQL_MODE=@@SQL_MODE/.test(head)
  );
}
