import type { MysqlVersion, SourceCapabilities } from './types.js';

/**
 * Derives structural {@link SourceCapabilities} from a detected
 * {@link MysqlVersion}.
 *
 * Gating is by `versionNumber` (`major*10000 + minor*100 + patch`) so a
 * capability introduced in a *patch* release — several of MySQL 8.0's are —
 * is gated at the release that actually shipped it, not at `8.0`.
 *
 * MariaDB is deliberately given the conservative MySQL 5.x feature set
 * regardless of its (much higher) version numbers: its 10.x/11.x numbering
 * has no relationship to MySQL 8.0's, so comparing them numerically would
 * claim features MariaDB may implement differently or not at all. This
 * package's compatibility contract is MySQL; see `docs/known-limitations.md`.
 */
export function detectSourceCapabilities(version: MysqlVersion): SourceCapabilities {
  const isMariaDb = version.flavor === 'mariadb';
  const atLeast = (target: number): boolean => !isMariaDb && version.versionNumber >= target;

  return {
    supportsCheckConstraints: atLeast(80016),
    supportsGeneratedColumns: atLeast(50706),
    supportsJsonType: atLeast(50708),
    supportsInvisibleColumns: atLeast(80023),
    supportsDescendingIndexes: atLeast(80000),
    supportsUtf8mb40900Collations: atLeast(80000),
    supportsEvents: true,
    supportsExpressionDefaults: atLeast(80013),
    supportsSpatialReferenceSystems: atLeast(80000),
    reportsDefaultGeneratedExtra: atLeast(80013),
  };
}
