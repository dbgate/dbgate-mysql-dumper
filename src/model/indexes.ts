export interface MysqlIndexColumn {
  readonly columnName: string | null;
  /** 1-based position within the key. */
  readonly ordinalPosition: number;
  /** Prefix length for a partial key part (`KEY (name(10))`), else `null`. */
  readonly prefixLength: number | null;
  /** `'ASC'`, `'DESC'`, or `null` for a key part with no meaningful order (`HASH`, `FULLTEXT`). */
  readonly direction: 'ASC' | 'DESC' | null;
  /**
   * Expression of a functional key part (MySQL 8.0.13+), where the key is
   * over an expression instead of a column and {@link columnName} is `null`.
   */
  readonly expression: string | null;
}

/**
 * One index as reported by `information_schema.STATISTICS`.
 *
 * The primary key is *also* an index here, named `PRIMARY`, exactly as MySQL
 * reports it; {@link isPrimary} distinguishes it. Unique constraints have no
 * separate existence in MySQL — a `UNIQUE` constraint **is** a unique index —
 * so there is no separate constraint model for them, only {@link isUnique}.
 */
export interface MysqlIndex {
  readonly databaseName: string;
  readonly tableName: string;
  readonly indexName: string;
  readonly isPrimary: boolean;
  readonly isUnique: boolean;
  /** `BTREE`, `HASH`, `FULLTEXT`, `SPATIAL`. */
  readonly indexType: string;
  readonly comment: string;
  readonly columns: readonly MysqlIndexColumn[];
  /** `STATISTICS.IS_VISIBLE = 'NO'` (MySQL 8.0+): the optimizer ignores the index. */
  readonly isVisible: boolean;
}
