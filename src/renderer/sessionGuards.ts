import { quoteMysqlString } from '../security/literals.js';
import { charsetGate } from './objectRenderers.js';
import type { ResolvedPlainSqlRenderOptions } from './types.js';
import {
  GATE_CHARSET_AND_SQL_MODE,
  GATE_CHECKS,
  GATE_SQL_NOTES,
  GATE_TIME_ZONE,
  executableComment,
} from './versionGates.js';

/**
 * The `sql_mode` a restore runs under.
 *
 * `NO_AUTO_VALUE_ON_ZERO` is the mode `mysqldump` sets, and it is load-bearing
 * twice over:
 *
 * 1. It makes an explicit `0` inserted into an `AUTO_INCREMENT` column stay
 *    `0` instead of being replaced by a freshly generated value — so a source
 *    row with id `0` (legal, and produced by
 *    `INSERT ... VALUES (0, ...)` under this same mode) round-trips.
 * 2. Assigning the whole variable *replaces* the restoring session's
 *    `sql_mode`, which clears `NO_BACKSLASH_ESCAPES` if it was set. Without
 *    that, every `\'`, `\\`, `\n` and `\Z` in the dump's string literals
 *    would be read as two literal characters and the restored data would be
 *    silently wrong. See `src/security/literals.ts`.
 */
const RESTORE_SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';

/**
 * The header's session guards, in `mysqldump`'s exact order.
 *
 * Each is a save-and-set pair whose partner lives in {@link footerLines}, so
 * a restore leaves the client session exactly as it found it — this is why a
 * dump can be piped into an interactive `mysql` session without polluting it.
 */
export function headerGuardLines(options: ResolvedPlainSqlRenderOptions): string[] {
  const lines: string[] = [];

  if (options.setCharset) {
    lines.push(
      executableComment(
        GATE_CHARSET_AND_SQL_MODE,
        'SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT',
      ),
      executableComment(
        GATE_CHARSET_AND_SQL_MODE,
        'SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS',
      ),
      executableComment(
        GATE_CHARSET_AND_SQL_MODE,
        'SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION',
      ),
      executableComment(charsetGate(options.characterSet), `SET NAMES ${options.characterSet}`),
    );
  }

  if (options.includeSessionGuards) {
    if (options.timeZone !== null) {
      lines.push(
        executableComment(GATE_TIME_ZONE, 'SET @OLD_TIME_ZONE=@@TIME_ZONE'),
        executableComment(GATE_TIME_ZONE, `SET TIME_ZONE=${quoteMysqlString(options.timeZone)}`),
      );
    }
    lines.push(
      executableComment(GATE_CHECKS, 'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0'),
      executableComment(
        GATE_CHECKS,
        'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0',
      ),
      executableComment(
        GATE_CHARSET_AND_SQL_MODE,
        `SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE=${quoteMysqlString(RESTORE_SQL_MODE)}`,
      ),
      executableComment(GATE_SQL_NOTES, 'SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0'),
    );
  }

  return lines.map(line => `${line};`);
}

/**
 * The footer's restore statements, mirroring {@link headerGuardLines}.
 *
 * The blank line between the `TIME_ZONE` restore and the rest is
 * `mysqldump`'s own layout, kept so a structural diff against native output
 * reports nothing.
 */
export function footerGuardLines(options: ResolvedPlainSqlRenderOptions): string[] {
  const lines: string[] = [];

  if (options.includeSessionGuards && options.timeZone !== null) {
    lines.push(`${executableComment(GATE_TIME_ZONE, 'SET TIME_ZONE=@OLD_TIME_ZONE')};`);
    lines.push('');
  }

  if (options.includeSessionGuards) {
    lines.push(`${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET SQL_MODE=@OLD_SQL_MODE')};`);
    lines.push(
      `${executableComment(GATE_CHECKS, 'SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS')};`,
    );
    lines.push(`${executableComment(GATE_CHECKS, 'SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS')};`);
  }

  if (options.setCharset) {
    lines.push(
      `${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT')};`,
      `${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS')};`,
      `${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION')};`,
    );
  }

  if (options.includeSessionGuards) {
    lines.push(`${executableComment(GATE_SQL_NOTES, 'SET SQL_NOTES=@OLD_SQL_NOTES')};`);
  }

  return lines;
}

/**
 * Formats an instant the way `mysqldump` writes its completion timestamp:
 * `YYYY-MM-DD HH:MM:SS` in local time, with no zone marker.
 */
export function formatDumpTimestamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}
