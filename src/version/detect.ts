import type { MysqlConnection, MysqlRow } from '../connection/types.js';
import { detectMysqlFlavor, parseMysqlVersion } from './types.js';
import type { MysqlVersion } from './types.js';

interface VersionRow extends MysqlRow {
  readonly versionString: string | null;
  readonly versionComment: string | null;
}

/**
 * Detects the server version and product flavor behind a live connection.
 *
 * Uses `VERSION()` rather than `@@version_comment` parsing for the numbers:
 * the comment is a free-form vendor string, while `VERSION()` is guaranteed
 * to start with `major.minor.patch`. The comment is read alongside it only
 * to tell MySQL, Percona and MariaDB apart.
 */
export async function detectMysqlVersion(
  connection: MysqlConnection,
  signal?: AbortSignal,
): Promise<MysqlVersion> {
  const result = await connection.query<VersionRow>(
    { sql: 'SELECT VERSION() AS versionString, @@version_comment AS versionComment' },
    signal,
    'native',
  );

  const row = result.rows[0];
  if (!row || !row.versionString) {
    throw new Error('Unable to detect MySQL version: VERSION() returned no data');
  }

  const versionString = String(row.versionString);
  const versionComment = row.versionComment === null ? undefined : String(row.versionComment);
  const { majorVersion, minorVersion, patchVersion, versionNumber } =
    parseMysqlVersion(versionString);

  return {
    versionString,
    majorVersion,
    minorVersion,
    patchVersion,
    versionNumber,
    flavor: detectMysqlFlavor(versionString, versionComment),
    versionComment,
  };
}
