import type { MysqlObjectReference } from './reference.js';

export type MysqlDiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * A structured diagnostic surfaced by introspection, archive planning,
 * rendering, data export or restore. Diagnostics are never thrown as
 * exceptions for recoverable conditions; callers inspect them explicitly
 * instead of parsing log text.
 */
export interface MysqlDiagnostic {
  readonly severity: MysqlDiagnosticSeverity;
  /** Stable machine-readable identifier, e.g. `"unsupported-object-kind"`. */
  readonly code: string;
  readonly message: string;
  readonly objectReference?: MysqlObjectReference;
}
