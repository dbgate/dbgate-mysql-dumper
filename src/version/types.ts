/**
 * Which server product is behind the connection.
 *
 * MariaDB forked from MySQL 5.5 and its catalog, `SHOW CREATE` output and
 * `information_schema` diverge in ways this package has not verified. It is
 * detected and reported so callers can act on it, but no MariaDB
 * compatibility is claimed — see `docs/known-limitations.md`.
 */
export type MysqlFlavor = 'mysql' | 'mariadb' | 'percona' | 'unknown';

/** Normalized MySQL server version. */
export interface MysqlVersion {
  /** Raw `VERSION()` string, e.g. `"8.0.36"` or `"10.11.6-MariaDB-1:10.11.6+maria~ubu2204"`. */
  readonly versionString: string;
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly patchVersion: number;
  /**
   * Numeric form the server itself uses in `@@version` comparisons and in
   * executable comments: `major * 10000 + minor * 100 + patch`. `80036` for
   * MySQL 8.0.36.
   */
  readonly versionNumber: number;
  readonly flavor: MysqlFlavor;
  /** `@@version_comment`, e.g. `"MySQL Community Server - GPL"`. */
  readonly versionComment?: string;
}

/**
 * Capabilities derived once from {@link MysqlVersion}. These describe what
 * the *source* server exposes structurally; they say nothing about what a
 * restore target can accept (see the `compatibility` module for that).
 */
export interface SourceCapabilities {
  /** `information_schema.CHECK_CONSTRAINTS`; MySQL 8.0.16+. */
  readonly supportsCheckConstraints: boolean;
  /** Generated (`VIRTUAL`/`STORED`) columns; MySQL 5.7.6+. */
  readonly supportsGeneratedColumns: boolean;
  /** Native `JSON` column type; MySQL 5.7.8+. */
  readonly supportsJsonType: boolean;
  /** `INVISIBLE` columns; MySQL 8.0.23+. */
  readonly supportsInvisibleColumns: boolean;
  /** Functional key parts and descending indexes; MySQL 8.0+. */
  readonly supportsDescendingIndexes: boolean;
  /** `utf8mb4_0900_*` collations and the `utf8mb4` server default; MySQL 8.0+. */
  readonly supportsUtf8mb40900Collations: boolean;
  /** `CREATE EVENT` / `information_schema.EVENTS`; MySQL 5.1+, so always true here. */
  readonly supportsEvents: boolean;
  /** Expression defaults (`DEFAULT (expr)`) on non-TIMESTAMP columns; MySQL 8.0.13+. */
  readonly supportsExpressionDefaults: boolean;
  /** `information_schema.COLUMNS.SRS_ID` on spatial columns; MySQL 8.0+. */
  readonly supportsSpatialReferenceSystems: boolean;
  /**
   * `SHOW CREATE TABLE` renders `DEFAULT_GENERATED` in `COLUMNS.EXTRA` and
   * quotes expression defaults; MySQL 8.0.13+.
   */
  readonly reportsDefaultGeneratedExtra: boolean;
}

/**
 * Parses a `VERSION()` string. MySQL appends arbitrary suffixes after the
 * three numeric components (`8.0.36-0ubuntu0.22.04.1`,
 * `10.11.6-MariaDB-1:10.11.6+maria~ubu2204`), so only the leading
 * `major.minor.patch` is interpreted; the rest is kept verbatim for
 * flavor detection and reporting.
 */
export function parseMysqlVersion(versionString: string): {
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
  versionNumber: number;
} {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionString.trim());
  if (!match) {
    throw new Error(`Cannot parse MySQL version string: ${JSON.stringify(versionString)}`);
  }
  const majorVersion = Number(match[1]);
  const minorVersion = Number(match[2]);
  const patchVersion = match[3] === undefined ? 0 : Number(match[3]);
  return {
    majorVersion,
    minorVersion,
    patchVersion,
    versionNumber: majorVersion * 10000 + minorVersion * 100 + patchVersion,
  };
}

/**
 * Identifies the server product from `VERSION()` and `@@version_comment`.
 * MariaDB always carries `MariaDB` in its version string (a compatibility
 * guarantee of the fork itself); Percona is only distinguishable through
 * the version comment.
 */
export function detectMysqlFlavor(versionString: string, versionComment?: string): MysqlFlavor {
  const haystack = `${versionString} ${versionComment ?? ''}`.toLowerCase();
  if (haystack.includes('mariadb')) return 'mariadb';
  if (haystack.includes('percona')) return 'percona';
  if (haystack.includes('mysql') || /^\d/.test(versionString.trim())) return 'mysql';
  return 'unknown';
}
