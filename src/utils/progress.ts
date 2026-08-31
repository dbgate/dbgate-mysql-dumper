export type DumpProgressPhase =
  | 'connecting'
  | 'detecting-version'
  | 'starting-snapshot'
  | 'introspecting'
  | 'planning-archive'
  | 'rendering-schema'
  | 'exporting-data'
  | 'finalizing';

/** The dump section a progress event belongs to, mirroring mysqldump's own output order. */
export type DumpProgressSection =
  | 'header'
  | 'table-structure'
  | 'table-data'
  | 'view-stub'
  | 'view'
  | 'trigger'
  | 'routine'
  | 'event'
  | 'footer';

export interface DumpProgressEvent {
  readonly phase: DumpProgressPhase;
  readonly message?: string;
  readonly section?: DumpProgressSection;
  /** Archive entries rendered so far, and the total planned. */
  readonly objectsProcessed?: number;
  readonly objectsTotal?: number;
  /** Qualified name of the object currently being rendered/exported. */
  readonly objectName?: string;
  readonly databaseName?: string;
  readonly tableName?: string;
  /** Rows exported from the current table. */
  readonly rowsExported?: number;
  /** Rows exported across every table so far in this dump. */
  readonly totalRowsExported?: number;
  /** Bytes written to the output so far. */
  readonly bytesWritten?: number;
  /** Lifecycle of a table data export. */
  readonly exportState?: 'started' | 'progress' | 'finished' | 'failed' | 'cancelled';
}

export type DumpProgressCallback = (event: DumpProgressEvent) => void;

export type RestoreProgressPhase =
  'connecting' | 'preflight' | 'parsing' | 'executing' | 'finalizing';

export interface RestoreProgressEvent {
  readonly phase: RestoreProgressPhase;
  readonly message?: string;
  /** Statements executed plus statements failed so far. */
  readonly statementsProcessed?: number;
  /** The statement currently being parsed/executed, 0-based in source order. */
  readonly statementIndex?: number;
  /**
   * Running total of `affectedRows` reported by the server across every
   * statement executed so far; see `SqlDumpRestoreResult.rowsRestored`.
   */
  readonly rowsRestored?: number;
  /** UTF-8 bytes of the source consumed by the parser so far. */
  readonly bytesConsumed?: number;
  /**
   * Object/section the parser last recognized from the dump's own section
   * comments (`-- Table structure for table \`t\``), when detectable.
   */
  readonly currentObject?: string;
  /** The delimiter in force when this event was emitted; `';'` unless a `DELIMITER` command changed it. */
  readonly delimiter?: string;
  /** Lifecycle of the current execution attempt. */
  readonly executionState?: 'started' | 'finished' | 'failed';
  /** Details of the statement failure, emitted immediately with `executionState: 'failed'`. */
  readonly error?: {
    readonly statementIndex: number;
    readonly location: { readonly startLine: number; readonly endLine: number };
    readonly sqlPreview: string;
    readonly message: string;
  };
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;
