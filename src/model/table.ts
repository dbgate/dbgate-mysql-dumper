/**
 * How a column's value is produced. `'stored'` and `'virtual'` columns are
 * never valid `INSERT` targets, which is what makes `mysqldump` switch a
 * table's data output to the explicit-column-list form.
 */
export type MysqlColumnGeneration = 'none' | 'virtual' | 'stored';

export interface MysqlColumn {
  readonly columnName: string;
  readonly ordinalPosition: number;
  /**
   * Base type name from `information_schema.COLUMNS.DATA_TYPE`, lowercase
   * and without any length/precision/attribute suffix: `varchar`, `bigint`,
   * `decimal`, `json`, `blob`, `enum`.
   */
  readonly dataType: string;
  /**
   * Full declared type from `COLUMNS.COLUMN_TYPE`, including length,
   * precision, `unsigned`, `zerofill`, and the complete `enum(...)`/`set(...)`
   * value list: `bigint unsigned`, `decimal(18,6)`, `enum('a','b')`.
   * This is what a serializer needs to distinguish e.g. `tinyint(1)` from
   * `tinyint`, and signed from unsigned.
   */
  readonly columnType: string;
  readonly isNullable: boolean;
  readonly isUnsigned: boolean;
  /**
   * `COLUMNS.COLUMN_DEFAULT` verbatim. MySQL reports a *literal* default as
   * its bare text (`0`, `abc`) and an *expression* default as the
   * expression source — the two are told apart by
   * {@link isDefaultExpression}, not by inspecting the text.
   */
  readonly defaultValue: string | null;
  /**
   * True when {@link defaultValue} is an expression rather than a literal
   * (`DEFAULT (uuid())`, `DEFAULT CURRENT_TIMESTAMP`). Derived from
   * `EXTRA LIKE '%DEFAULT_GENERATED%'`, which MySQL 8.0.13+ reports; on
   * older servers only the `CURRENT_TIMESTAMP` special case exists and is
   * detected from the text.
   */
  readonly isDefaultExpression: boolean;
  readonly isAutoIncrement: boolean;
  readonly generation: MysqlColumnGeneration;
  /** `COLUMNS.GENERATION_EXPRESSION`, for generated columns. */
  readonly generationExpression: string | null;
  /** `INVISIBLE` columns (MySQL 8.0.23+) are excluded from `SELECT *`. */
  readonly isInvisible: boolean;
  /** `ON UPDATE CURRENT_TIMESTAMP` and friends, from the remainder of `EXTRA`. */
  readonly onUpdate: string | null;
  readonly characterSetName: string | null;
  readonly collationName: string | null;
  readonly characterMaximumLength: number | null;
  readonly numericPrecision: number | null;
  readonly numericScale: number | null;
  readonly datetimePrecision: number | null;
  /** Spatial reference system id (MySQL 8.0+), for `GEOMETRY` family columns. */
  readonly srsId: number | null;
  readonly comment: string;
}

export interface MysqlTable {
  readonly databaseName: string;
  readonly pureName: string;
  /** `TABLES.ENGINE`, e.g. `InnoDB`, `MyISAM`, `MEMORY`. `null` for a table whose engine is missing. */
  readonly engine: string | null;
  /**
   * `TABLES.AUTO_INCREMENT`: the *next* value the table would generate.
   * Carried as a string so a value above `Number.MAX_SAFE_INTEGER` — legal
   * for a `BIGINT UNSIGNED` key — survives without rounding.
   */
  readonly autoIncrement: string | null;
  readonly tableCollation: string | null;
  /** Charset implied by {@link tableCollation}; resolved during introspection. */
  readonly tableCharacterSet: string | null;
  readonly rowFormat: string | null;
  /** `TABLES.CREATE_OPTIONS`, e.g. `partitioned`, `row_format=DYNAMIC`. */
  readonly createOptions: string | null;
  readonly comment: string;
  /**
   * Verbatim `SHOW CREATE TABLE` text.
   *
   * The renderer emits this rather than reconstructing DDL from the column
   * model. MySQL's `CREATE TABLE` grammar carries partitioning clauses,
   * functional and prefixed key parts, spatial `SRID`, per-column charsets,
   * expression defaults, `COMPRESSION`/`ENCRYPTION`, tablespace placement
   * and engine-specific options — reproducing all of that faithfully is a
   * losing game against a server that already renders it exactly right.
   * The normalized column/index model above still exists, and drives
   * planning, data export and diagnostics; it just is not the source of the
   * DDL text. See `docs/architecture.md`.
   */
  readonly createSql: string;
  readonly columns: readonly MysqlColumn[];
  /** True when {@link engine} is one this package knows to be transactional. */
  readonly isTransactional: boolean;
}

/**
 * Storage engines whose reads participate in an InnoDB-style consistent
 * snapshot. Anything outside this set is reported as not snapshot-consistent
 * under `consistency: 'single-transaction'` rather than being silently
 * treated as if it were.
 */
const TRANSACTIONAL_ENGINES = new Set(['innodb', 'ndbcluster', 'ndb', 'rocksdb', 'tokudb']);

export function isTransactionalEngine(engine: string | null | undefined): boolean {
  return engine ? TRANSACTIONAL_ENGINES.has(engine.toLowerCase()) : false;
}
