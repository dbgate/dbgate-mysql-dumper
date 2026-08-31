/** Referential action for a foreign key's `ON UPDATE`/`ON DELETE` clause. */
export type MysqlReferentialAction =
  'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'SET DEFAULT';

export interface MysqlForeignKeyColumn {
  readonly columnName: string;
  readonly referencedColumnName: string;
  readonly ordinalPosition: number;
}

export interface MysqlForeignKey {
  readonly databaseName: string;
  readonly tableName: string;
  readonly constraintName: string;
  readonly referencedDatabaseName: string;
  readonly referencedTableName: string;
  readonly updateAction: MysqlReferentialAction;
  readonly deleteAction: MysqlReferentialAction;
  readonly columns: readonly MysqlForeignKeyColumn[];
}

/**
 * A `CHECK` constraint, from `information_schema.CHECK_CONSTRAINTS`
 * (MySQL 8.0.16+). Older servers parse and ignore `CHECK` clauses entirely,
 * so this collection is empty there.
 */
export interface MysqlCheckConstraint {
  readonly databaseName: string;
  readonly tableName: string;
  readonly constraintName: string;
  /** `CHECK_CLAUSE`, the server's own normalized rendering of the expression. */
  readonly checkClause: string;
  /** `TABLE_CONSTRAINTS.ENFORCED = 'YES'`; a `NOT ENFORCED` check is parsed but never evaluated. */
  readonly isEnforced: boolean;
}
