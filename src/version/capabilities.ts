import type { MysqlVersion, SourceCapabilities } from './types.js';

/**
 * Derives structural {@link SourceCapabilities} from a detected
 * {@link MysqlVersion}.
 *
 * Gating is by `versionNumber` (`major*10000 + minor*100 + patch`) so a
 * capability introduced in a *patch* release — several of MySQL 8.0's are —
 * is gated at the release that actually shipped it, not at `8.0`.
 *
 * MariaDB uses its own gates: its 10.x/11.x version line must never be
 * compared with MySQL 8.x. Capabilities whose catalog representation differs
 * (CHECK enforcement, functional/invisible indexes and native JSON) are kept
 * separate even when both products support a similarly named SQL feature.
 */
export function detectSourceCapabilities(version: MysqlVersion): SourceCapabilities {
  const isMariaDb = version.flavor === 'mariadb';
  const mysqlAtLeast = (target: number): boolean => !isMariaDb && version.versionNumber >= target;
  const mariaAtLeast = (target: number): boolean => isMariaDb && version.versionNumber >= target;

  return {
    supportsCheckConstraints: mysqlAtLeast(80016) || mariaAtLeast(100200),
    supportsCheckConstraintEnforcementMetadata: mysqlAtLeast(80016),
    supportsGeneratedColumns: mysqlAtLeast(50706) || mariaAtLeast(100200),
    supportsJsonType: mysqlAtLeast(50708),
    supportsInvisibleColumns: mysqlAtLeast(80023) || mariaAtLeast(100300),
    supportsDescendingIndexes: mysqlAtLeast(80000) || mariaAtLeast(100800),
    supportsIndexExpressions: mysqlAtLeast(80013),
    supportsInvisibleIndexes: mysqlAtLeast(80000),
    supportsUtf8mb40900Collations: mysqlAtLeast(80000),
    supportsEvents: true,
    supportsExpressionDefaults: mysqlAtLeast(80013) || mariaAtLeast(100200),
    supportsSpatialReferenceSystems: mysqlAtLeast(80000),
    reportsDefaultGeneratedExtra: mysqlAtLeast(80013),
  };
}
