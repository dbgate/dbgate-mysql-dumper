/**
 * Caller-facing object selection.
 *
 * Names are exact MySQL identifiers: they are matched against catalog names
 * as reported by the server and are never treated as wildcard patterns.
 *
 * **Case sensitivity** follows the server's own `lower_case_table_names`
 * setting, which introspection reads and normalization applies: on a server
 * where table names are case-insensitive (the default on Windows and macOS),
 * `Orders` and `orders` select the same table; on a case-sensitive server
 * (the Linux default) they do not. Routine, trigger and event names are
 * always case-insensitive in MySQL regardless of that setting, and are
 * matched accordingly.
 */
export interface DumpSelection {
  /** Exact table names to include. When omitted, all non-excluded tables are included. */
  readonly tables?: readonly string[];
  /** Exact table names to exclude, applied after {@link tables}. */
  readonly excludeTables?: readonly string[];
  /** Exact view names to include. When omitted, all non-excluded views are included. */
  readonly views?: readonly string[];
  readonly excludeViews?: readonly string[];
  /** Exact routine (procedure and function) names to include. */
  readonly routines?: readonly string[];
  readonly excludeRoutines?: readonly string[];
  /** Exact trigger names to include. */
  readonly triggers?: readonly string[];
  readonly excludeTriggers?: readonly string[];
  /** Exact event names to include. */
  readonly events?: readonly string[];
  readonly excludeEvents?: readonly string[];
  /**
   * Tables whose *structure* is dumped but whose rows are not — the
   * equivalent of `mysqldump --ignore-table` applied to data only. Useful
   * for large log/cache tables. A table excluded through
   * {@link excludeTables} is omitted entirely instead.
   */
  readonly dataExcludedTables?: readonly string[];
}

/**
 * Which object kinds participate in the dump at all, independent of the
 * per-name filters in {@link DumpSelection}. These map onto `mysqldump`'s
 * `--routines`, `--events` and `--triggers` switches — note that
 * `mysqldump` includes triggers by default but *excludes* routines and
 * events, a split this package deliberately does not reproduce (see the
 * defaults in `DumpMysqlOptions`).
 */
export interface DumpObjectKinds {
  readonly includeTables?: boolean;
  readonly includeViews?: boolean;
  readonly includeTriggers?: boolean;
  readonly includeRoutines?: boolean;
  readonly includeEvents?: boolean;
}

export interface NormalizedDumpSelection {
  readonly tables?: ReadonlySet<string>;
  readonly excludeTables: ReadonlySet<string>;
  readonly views?: ReadonlySet<string>;
  readonly excludeViews: ReadonlySet<string>;
  readonly routines?: ReadonlySet<string>;
  readonly excludeRoutines: ReadonlySet<string>;
  readonly triggers?: ReadonlySet<string>;
  readonly excludeTriggers: ReadonlySet<string>;
  readonly events?: ReadonlySet<string>;
  readonly excludeEvents: ReadonlySet<string>;
  readonly dataExcludedTables: ReadonlySet<string>;
  /**
   * Whether table and view names were folded to lower case when building the
   * sets above, mirroring the server's `lower_case_table_names`. Lookups
   * must fold the probe the same way; {@link isTableSelected} does.
   */
  readonly caseInsensitiveTableNames: boolean;
}
