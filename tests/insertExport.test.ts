import { describe, expect, it } from 'vitest';
import { exportTableDataAsInserts } from '../src/data/insertExport.js';
import type { MysqlRow } from '../src/connection/types.js';
import type { MysqlIndex } from '../src/model/indexes.js';
import type { MysqlColumn, MysqlTable } from '../src/model/table.js';
import { BufferDumpWriter } from '../src/writer/bufferWriter.js';
import { MockMysqlConnection } from './mockConnection.js';

function column(overrides: Partial<MysqlColumn> & { columnName: string }): MysqlColumn {
  return {
    ordinalPosition: 1,
    dataType: 'varchar',
    columnType: 'varchar(50)',
    isNullable: true,
    isUnsigned: false,
    defaultValue: null,
    isDefaultExpression: false,
    isAutoIncrement: false,
    generation: 'none',
    generationExpression: null,
    isInvisible: false,
    onUpdate: null,
    characterSetName: 'utf8mb4',
    collationName: 'utf8mb4_0900_ai_ci',
    characterMaximumLength: 50,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
    srsId: null,
    comment: '',
    ...overrides,
  };
}

function table(columns: readonly MysqlColumn[], pureName = 't'): MysqlTable {
  return {
    databaseName: 'db',
    pureName,
    engine: 'InnoDB',
    autoIncrement: null,
    tableCollation: 'utf8mb4_0900_ai_ci',
    tableCharacterSet: 'utf8mb4',
    rowFormat: 'Dynamic',
    createOptions: '',
    comment: '',
    createSql: `CREATE TABLE \`${pureName}\` (...)`,
    columns,
    isTransactional: true,
  };
}

function primaryKey(tableName: string, columnNames: readonly string[]): MysqlIndex {
  return {
    databaseName: 'db',
    tableName,
    indexName: 'PRIMARY',
    isPrimary: true,
    isUnique: true,
    indexType: 'BTREE',
    comment: '',
    isVisible: true,
    columns: columnNames.map((columnName, index) => ({
      columnName,
      ordinalPosition: index + 1,
      prefixLength: null,
      direction: 'ASC' as const,
      expression: null,
    })),
  };
}

/** Builds a raw-mode row: every value is the bytes MySQL sent, or null. */
function rawRow(values: Record<string, string | Buffer | null>): MysqlRow {
  const row: Record<string, Buffer | null> = {};
  for (const [key, value] of Object.entries(values)) {
    row[key] = value === null ? null : Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  }
  return row as MysqlRow;
}

const idColumn = column({
  columnName: 'id',
  ordinalPosition: 1,
  dataType: 'int',
  columnType: 'int',
});
const nameColumn = column({ columnName: 'name', ordinalPosition: 2 });

async function run(
  options: Parameters<typeof exportTableDataAsInserts>[0]['options'],
  rows: readonly MysqlRow[],
  overrides: {
    table?: MysqlTable;
    indexes?: readonly MysqlIndex[];
    maxAllowedPacket?: number;
    rawValueReads?: boolean;
  } = {},
): Promise<{ sql: string; result: Awaited<ReturnType<typeof exportTableDataAsInserts>> }> {
  const target = overrides.table ?? table([idColumn, nameColumn]);
  const connection = new MockMysqlConnection([{ match: 'SELECT', rows }], {
    ...(overrides.rawValueReads === undefined ? {} : { rawValueReads: overrides.rawValueReads }),
  });
  const writer = new BufferDumpWriter();
  const result = await exportTableDataAsInserts({
    connection,
    databaseName: 'db',
    table: target,
    indexes: overrides.indexes ?? [primaryKey(target.pureName, ['id'])],
    writer,
    ...(overrides.maxAllowedPacket === undefined
      ? {}
      : { maxAllowedPacket: overrides.maxAllowedPacket }),
    ...(options === undefined ? {} : { options }),
  });
  return { sql: writer.toString(), result };
}

describe('exportTableDataAsInserts: statement shape', () => {
  it('produces one extended INSERT with no column list by default', async () => {
    const { sql, result } = await run(undefined, [
      rawRow({ id: '1', name: 'a' }),
      rawRow({ id: '2', name: 'b' }),
    ]);
    expect(sql).toBe("INSERT INTO `t` VALUES (1,'a'),(2,'b');\n");
    expect(result.rowsExported).toBe(2);
    expect(result.statementsWritten).toBe(1);
  });

  it('emits one statement per row when extendedInsert is off', async () => {
    const { sql, result } = await run({ extendedInsert: false }, [
      rawRow({ id: '1', name: 'a' }),
      rawRow({ id: '2', name: 'b' }),
    ]);
    expect(sql).toBe("INSERT INTO `t` VALUES (1,'a');\nINSERT INTO `t` VALUES (2,'b');\n");
    expect(result.statementsWritten).toBe(2);
  });

  it('names columns when completeInsert is on', async () => {
    const { sql } = await run({ completeInsert: true }, [rawRow({ id: '1', name: 'a' })]);
    expect(sql).toBe("INSERT INTO `t` (`id`, `name`) VALUES (1,'a');\n");
  });

  it('writes nothing at all for an empty table', async () => {
    const { sql, result } = await run(undefined, []);
    expect(sql).toBe('');
    expect(result.rowsExported).toBe(0);
    expect(result.statementsWritten).toBe(0);
  });
});

describe('exportTableDataAsInserts: generated and invisible columns', () => {
  it('excludes generated columns and switches to the column-list form', async () => {
    // mysqldump does exactly this: a positional VALUES list would not line up
    // once a generated column is missing from it.
    const generated = column({
      columnName: 'slug',
      ordinalPosition: 3,
      generation: 'stored',
      generationExpression: 'lower(`name`)',
    });
    const { sql, result } = await run(undefined, [rawRow({ id: '1', name: 'a' })], {
      table: table([idColumn, nameColumn, generated]),
    });
    expect(sql).toBe("INSERT INTO `t` (`id`, `name`) VALUES (1,'a');\n");
    expect(result.warnings.map(warning => warning.code)).toContain('generated-column-not-exported');
  });

  it('includes an invisible column but names it, since SELECT * would skip it', async () => {
    const invisible = column({ columnName: 'hidden', ordinalPosition: 3, isInvisible: true });
    const { sql } = await run(undefined, [rawRow({ id: '1', name: 'a', hidden: 'h' })], {
      table: table([idColumn, nameColumn, invisible]),
    });
    expect(sql).toBe("INSERT INTO `t` (`id`, `name`, `hidden`) VALUES (1,'a','h');\n");
  });

  it('warns and writes nothing when every column is generated', async () => {
    const onlyGenerated = column({ columnName: 'g', generation: 'virtual' });
    const { sql, result } = await run(undefined, [], { table: table([onlyGenerated]) });
    expect(sql).toBe('');
    expect(result.warnings.map(warning => warning.code)).toContain(
      'table-has-no-insertable-columns',
    );
  });
});

describe('exportTableDataAsInserts: batching', () => {
  // Each rendered tuple is a little over 200 bytes, so ten of them comfortably
  // exceed the 1024-byte floor `maxStatementBytes` is clamped to.
  const manyRows = Array.from({ length: 10 }, (_, index) =>
    rawRow({ id: String(index), name: 'x'.repeat(200) }),
  );

  it('caps rows per statement when asked', async () => {
    const { sql, result } = await run({ maxRowsPerStatement: 3 }, manyRows);
    expect(result.statementsWritten).toBe(4);
    expect(sql.split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('caps statement size in bytes, closing before the cap is exceeded', async () => {
    const { sql, result } = await run({ maxStatementBytes: 1024 }, manyRows);
    expect(result.statementsWritten).toBeGreaterThan(1);
    for (const statement of sql.split('\n').filter(Boolean)) {
      expect(Buffer.byteLength(statement, 'utf8')).toBeLessThanOrEqual(1024);
    }
  });

  it('still emits a single row larger than the cap, alone', async () => {
    const huge = rawRow({ id: '1', name: 'x'.repeat(5000) });
    const { sql, result } = await run({ maxStatementBytes: 1024 }, [huge]);
    expect(result.statementsWritten).toBe(1);
    expect(Buffer.byteLength(sql, 'utf8')).toBeGreaterThan(5000);
  });

  it('clamps the statement size against the server max_allowed_packet', async () => {
    // A statement above max_allowed_packet is rejected at restore time no
    // matter how it was produced, so the configured cap must not win.
    const { result } = await run({ maxStatementBytes: 10_000_000 }, manyRows, {
      maxAllowedPacket: 2000,
    });
    expect(result.statementsWritten).toBeGreaterThan(1);
  });

  it('is deterministic: the same rows always produce the same bytes', async () => {
    const first = await run({ maxRowsPerStatement: 3 }, manyRows);
    const second = await run({ maxRowsPerStatement: 3 }, manyRows);
    expect(first.sql).toBe(second.sql);
  });
});

describe('exportTableDataAsInserts: read order', () => {
  it('orders by the primary key so two dumps agree', async () => {
    const connection = new MockMysqlConnection([{ match: 'SELECT', rows: [] }]);
    await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, nameColumn]),
      indexes: [primaryKey('t', ['id'])],
      writer: new BufferDumpWriter(),
    });
    expect(connection.executedSql[0]).toBe('SELECT `id`, `name` FROM `db`.`t` ORDER BY `id`');
  });

  it('orders by every primary-key column, in key order', async () => {
    const connection = new MockMysqlConnection([{ match: 'SELECT', rows: [] }]);
    await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, nameColumn]),
      indexes: [primaryKey('t', ['id', 'name'])],
      writer: new BufferDumpWriter(),
    });
    expect(connection.executedSql[0]).toContain('ORDER BY `id`, `name`');
  });

  it('reads unordered and warns when the table has no primary key', async () => {
    const connection = new MockMysqlConnection([{ match: 'SELECT', rows: [] }]);
    const result = await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, nameColumn]),
      indexes: [],
      writer: new BufferDumpWriter(),
    });
    expect(connection.executedSql[0]).not.toContain('ORDER BY');
    expect(result.warnings.map(warning => warning.code)).toContain('unordered-table-read');
  });

  it('omits the ORDER BY when orderByPrimaryKey is off', async () => {
    const connection = new MockMysqlConnection([{ match: 'SELECT', rows: [] }]);
    await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, nameColumn]),
      indexes: [primaryKey('t', ['id'])],
      writer: new BufferDumpWriter(),
      options: { orderByPrimaryKey: false },
    });
    expect(connection.executedSql[0]).not.toContain('ORDER BY');
  });

  it('reads values in raw mode, never driver-native', async () => {
    const connection = new MockMysqlConnection([{ match: 'SELECT', rows: [] }]);
    await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn]),
      writer: new BufferDumpWriter(),
    });
    expect(connection.executed[0]?.valueMode).toBe('raw');
  });
});

describe('exportTableDataAsInserts: fidelity warnings', () => {
  it('warns when the connection cannot deliver raw values', async () => {
    const { result } = await run(undefined, [rawRow({ id: '1', name: 'a' })], {
      rawValueReads: false,
    });
    expect(result.warnings.map(warning => warning.code)).toContain('lossy-value-mode');
  });
});

describe('exportTableDataAsInserts: binary output', () => {
  it('writes a Buffer when hexBlob is off, so raw bytes survive', async () => {
    const blobColumn = column({
      columnName: 'data',
      ordinalPosition: 2,
      dataType: 'blob',
      columnType: 'blob',
    });
    const connection = new MockMysqlConnection([
      {
        match: 'SELECT',
        rows: [{ id: Buffer.from('1'), data: Buffer.from([0xff, 0x00, 0xfe]) }],
      },
    ]);
    const writer = new BufferDumpWriter();
    await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, blobColumn]),
      indexes: [primaryKey('t', ['id'])],
      writer,
      options: { hexBlob: false },
    });
    // The NUL byte is escaped as `\0`, so the three bytes are not contiguous;
    // what matters is that 0xFF and 0xFE reached the output as themselves
    // rather than as the U+FFFD replacement a UTF-8 decode would produce.
    const bytes = writer.toBuffer();
    expect(bytes.includes(Buffer.from('_binary ', 'latin1'))).toBe(true);
    expect(bytes.includes(0xff)).toBe(true);
    expect(bytes.includes(0xfe)).toBe(true);
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });
});

describe('exportTableDataAsInserts: cancellation', () => {
  it('stops cleanly and does not flush a partial statement', async () => {
    const controller = new AbortController();
    const connection = new MockMysqlConnection([
      { match: 'SELECT', rows: [rawRow({ id: '1', name: 'a' })] },
    ]);
    const writer = new BufferDumpWriter();
    controller.abort();

    const result = await exportTableDataAsInserts({
      connection,
      databaseName: 'db',
      table: table([idColumn, nameColumn]),
      indexes: [primaryKey('t', ['id'])],
      writer,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    // A half-built INSERT would be syntactically valid but hold an arbitrary
    // prefix of the table, which is worse than an obviously truncated dump.
    expect(writer.toString()).toBe('');
  });
});
