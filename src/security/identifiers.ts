import { MysqlDumperError } from '../utils/errors.js';

/**
 * True when `value` contains the NUL code point (U+0000), which MySQL
 * forbids inside an identifier name. Written as a scan rather than an
 * `includes()` against a NUL string literal so no source file in this
 * package has to carry a raw NUL byte.
 */
function containsNul(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Quotes one MySQL identifier with backticks, doubling embedded backticks —
 * the escape MySQL itself defines for a quoted identifier.
 *
 * Backticks are used unconditionally, exactly as `mysqldump` does (its
 * `--quote-names` behaviour is on by default and effectively mandatory).
 * There is no "quote only when needed" mode: MySQL's reserved-word list
 * changes between releases, so a name that is safe unquoted on 5.7 can
 * become reserved on 8.0 (`RANK`, `ROW`, `GROUPS`, ...), and a dump that
 * omitted the quotes would then fail to restore on a newer server. Always
 * quoting costs two bytes and removes the whole class of problem.
 *
 * A NUL code point is rejected rather than escaped: MySQL forbids it in
 * identifiers outright, so its presence means the value did not come from a
 * MySQL catalog and must not be interpolated into SQL.
 */
export function quoteIdentifier(value: string): string {
  if (containsNul(value)) {
    throw new MysqlDumperError(
      'invalid-identifier',
      'Identifier contains a NUL character, which MySQL does not permit in an identifier name',
    );
  }
  return `\`${value.replace(/`/g, '``')}\``;
}

/** Quotes and joins a dotted identifier path, e.g. `["db", "orders"]` -> `` `db`.`orders` ``. */
export function quoteQualifiedIdentifier(parts: readonly string[]): string {
  return parts.map(quoteIdentifier).join('.');
}

/**
 * Renders a `DEFINER` clause value, which MySQL stores as `user@host` and
 * requires to be written as two independently quoted identifiers
 * (`` `root`@`localhost` ``) rather than one quoted string.
 *
 * The split is on the **last** `@`, because a MySQL user name may itself
 * contain `@` (`'me@example.com'@'%'` is a legal account) while a host name
 * may not. A value with no `@` at all is treated as a bare user name with an
 * unspecified host, which is what `information_schema` reports for a
 * definer whose host part is empty.
 */
export function quoteDefiner(definer: string): string {
  const separatorIndex = definer.lastIndexOf('@');
  if (separatorIndex < 0) {
    return quoteIdentifier(definer);
  }
  const user = definer.slice(0, separatorIndex);
  const host = definer.slice(separatorIndex + 1);
  return `${quoteIdentifier(user)}@${quoteIdentifier(host)}`;
}
