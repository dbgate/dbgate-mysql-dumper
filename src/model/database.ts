import type { MysqlCheckConstraint, MysqlForeignKey } from './constraint.js';
import type { MysqlIndex } from './indexes.js';
import type { MysqlEvent, MysqlRoutine, MysqlTrigger, MysqlView } from './programmable.js';
import type { MysqlTable } from './table.js';

/**
 * The complete normalized model of one MySQL database, as returned by
 * {@link introspectMysql}.
 *
 * Objects are independent collections rather than a nested tree; consumers
 * join them by `databaseName`/`tableName`/`pureName` as needed. This mirrors
 * the flat `information_schema` shape MySQL itself exposes and keeps archive
 * planning free of implicit parent/child traversal.
 *
 * There is deliberately no separate collection for primary keys or unique
 * constraints: in MySQL both *are* indexes, and appear in {@link indexes}
 * with `isPrimary`/`isUnique` set — modelling them twice would invent a
 * distinction the server does not make.
 */
export interface MysqlDatabase {
  readonly databaseName: string;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  /** `SCHEMATA.DEFAULT_ENCRYPTION` (MySQL 8.0.16+), `'Y'` or `'N'`. */
  readonly defaultEncryption: string | null;
  readonly tables: readonly MysqlTable[];
  readonly views: readonly MysqlView[];
  readonly indexes: readonly MysqlIndex[];
  readonly foreignKeys: readonly MysqlForeignKey[];
  readonly checkConstraints: readonly MysqlCheckConstraint[];
  readonly routines: readonly MysqlRoutine[];
  readonly triggers: readonly MysqlTrigger[];
  readonly events: readonly MysqlEvent[];
}
