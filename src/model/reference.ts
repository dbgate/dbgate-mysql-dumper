/** Discriminates every catalog object kind the model can represent. */
export type MysqlObjectKind =
  | 'database'
  | 'table'
  | 'column'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'event'
  | 'primaryKey'
  | 'uniqueIndex'
  | 'index'
  | 'foreignKey'
  | 'checkConstraint';

/**
 * A lightweight, denormalized pointer to a catalog object. Used for
 * diagnostics and archive dependency edges, not for storing the object
 * itself.
 *
 * MySQL has a single-level namespace — a *database* (which
 * `information_schema` confusingly calls a "schema") directly contains
 * tables, views, routines, triggers and events, with no schema level in
 * between. `databaseName` is therefore the only qualifier, unlike the
 * PostgreSQL/SQL Server siblings' `schemaName`.
 */
export interface MysqlObjectReference {
  readonly kind: MysqlObjectKind;
  readonly databaseName: string;
  readonly name: string;
  /** Owning table name, for column-, index-, constraint- and trigger-like kinds. */
  readonly parentName?: string;
}
