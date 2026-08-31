import type {
  MysqlConnection,
  MysqlExecResult,
  MysqlQuery,
  MysqlQueryResult,
  MysqlResultColumn,
  MysqlRow,
  MysqlServerErrorInfo,
  MysqlStreamOptions,
  MysqlValueMode,
} from '../src/connection/types.js';

/** One canned response, matched against a query by substring or predicate. */
export interface MockResponse {
  readonly match: string | RegExp | ((sql: string) => boolean);
  readonly rows?: readonly MysqlRow[];
  readonly columns?: readonly MysqlResultColumn[];
  readonly affectedRows?: number;
  /** When set, the query rejects with this error instead of resolving. */
  readonly error?: Error;
}

export interface RecordedQuery {
  readonly sql: string;
  readonly parameters?: readonly unknown[];
  readonly valueMode?: MysqlValueMode;
  readonly kind: 'query' | 'stream' | 'execute';
}

/**
 * An in-memory {@link MysqlConnection} for unit tests.
 *
 * Deliberately dumb: it matches a query against canned responses and records
 * everything it was asked to run. Tests assert on the recorded SQL — which is
 * how the session, restore and export layers are covered without a server —
 * rather than on a simulated MySQL, which would only test the simulation.
 */
export class MockMysqlConnection implements MysqlConnection {
  readonly supportsRawValueReads: boolean;
  readonly executed: RecordedQuery[] = [];
  private readonly responses: MockResponse[];

  constructor(responses: readonly MockResponse[] = [], options?: { rawValueReads?: boolean }) {
    this.responses = [...responses];
    this.supportsRawValueReads = options?.rawValueReads ?? true;
  }

  /** Adds a response, taking precedence over earlier ones. */
  respond(response: MockResponse): this {
    this.responses.unshift(response);
    return this;
  }

  /** Every SQL string this connection was asked to run, in order. */
  get executedSql(): string[] {
    return this.executed.map(entry => entry.sql);
  }

  private find(sql: string): MockResponse | undefined {
    return this.responses.find(response => {
      if (typeof response.match === 'string') {
        return sql.includes(response.match);
      }
      if (response.match instanceof RegExp) {
        return response.match.test(sql);
      }
      return response.match(sql);
    });
  }

  async query<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    _signal?: AbortSignal,
    valueMode?: MysqlValueMode,
  ): Promise<MysqlQueryResult<Row>> {
    this.executed.push({
      sql: query.sql,
      ...(query.parameters === undefined ? {} : { parameters: [...query.parameters] }),
      ...(valueMode === undefined ? {} : { valueMode }),
      kind: 'query',
    });
    const response = this.find(query.sql);
    if (response?.error) {
      throw response.error;
    }
    return {
      rows: (response?.rows ?? []) as Row[],
      columns: response?.columns ?? [],
      affectedRows: response?.affectedRows ?? 0,
    };
  }

  stream<Row extends MysqlRow = MysqlRow>(
    query: MysqlQuery,
    options?: MysqlStreamOptions,
  ): AsyncIterable<Row> {
    this.executed.push({
      sql: query.sql,
      ...(options?.valueMode === undefined ? {} : { valueMode: options.valueMode }),
      kind: 'stream',
    });
    const response = this.find(query.sql);
    const rows = (response?.rows ?? []) as Row[];
    const columns = response?.columns ?? [];
    options?.onColumns?.(columns);

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<Row> {
        if (response?.error) {
          throw response.error;
        }
        for (const row of rows) {
          if (options?.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          yield row;
        }
      },
    };
  }

  async execute(sql: string): Promise<MysqlExecResult> {
    this.executed.push({ sql, kind: 'execute' });
    const response = this.find(sql);
    if (response?.error) {
      throw response.error;
    }
    return { affectedRows: response?.affectedRows ?? 0 };
  }

  describeError(error: unknown): MysqlServerErrorInfo | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }
    const candidate = error as { errno?: number; code?: string; message?: string };
    return candidate.message === undefined
      ? undefined
      : {
          ...(candidate.errno === undefined ? {} : { errno: candidate.errno }),
          ...(candidate.code === undefined ? {} : { code: candidate.code }),
          message: candidate.message,
        };
  }

  async cancel(): Promise<void> {}
}

/** Builds an error shaped like the ones the mysql2 adapter surfaces. */
export function serverError(message: string, errno: number, code?: string): Error {
  return Object.assign(new Error(message), { errno, ...(code === undefined ? {} : { code }) });
}
