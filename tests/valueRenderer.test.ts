import { describe, expect, it } from 'vitest';
import { renderColumnValue } from '../src/data/valueRenderer.js';
import {
  isBinaryColumn,
  isGeneratedColumn,
  isNumericColumn,
  isSpatialColumn,
} from '../src/data/valueRenderer.js';
import type { MysqlColumn } from '../src/model/table.js';

/** Builds the minimal column shape the value renderer consults. */
function column(
  dataType: string,
  columnType = dataType,
): Pick<MysqlColumn, 'dataType' | 'columnType'> {
  return { dataType, columnType };
}

/** Renders a value the way a raw read delivers it: the server's own bytes. */
function renderRaw(
  text: string,
  dataType: string,
  options: { hexBlob?: boolean } = {},
): string | Buffer {
  return renderColumnValue(Buffer.from(text, 'utf8'), column(dataType), {
    hexBlob: options.hexBlob ?? true,
  });
}

describe('renderColumnValue: NULL', () => {
  it('renders SQL NULL for null and undefined', () => {
    expect(renderColumnValue(null, column('int'), { hexBlob: true })).toBe('NULL');
    expect(renderColumnValue(undefined as never, column('int'), { hexBlob: true })).toBe('NULL');
  });
});

describe('renderColumnValue: exact numerics', () => {
  it('emits BIGINT beyond JavaScript precision verbatim and unquoted', () => {
    // 9223372036854775807 is not representable as a JS number; the whole
    // point of the raw value path is that it never becomes one.
    expect(renderRaw('9223372036854775807', 'bigint')).toBe('9223372036854775807');
    expect(renderRaw('-9223372036854775808', 'bigint')).toBe('-9223372036854775808');
    expect(renderRaw('18446744073709551615', 'bigint')).toBe('18446744073709551615');
  });

  it('emits DECIMAL with every digit and trailing zero the server sent', () => {
    expect(renderRaw('12345678901234567890.1234567890', 'decimal')).toBe(
      '12345678901234567890.1234567890',
    );
    expect(renderRaw('0.0000000000', 'decimal')).toBe('0.0000000000');
    expect(renderRaw('-0.0000000001', 'decimal')).toBe('-0.0000000001');
  });

  it('emits FLOAT and DOUBLE in the serverial form, exponent included', () => {
    expect(renderRaw('1e300', 'double')).toBe('1e300');
    expect(renderRaw('3.4028234e38', 'float')).toBe('3.4028234e38');
    expect(renderRaw('501.25', 'double')).toBe('501.25');
  });

  it('emits YEAR and integers unquoted', () => {
    expect(renderRaw('2155', 'year')).toBe('2155');
    expect(renderRaw('65535', 'smallint')).toBe('65535');
    expect(renderRaw('0', 'tinyint')).toBe('0');
  });

  it('quotes unexpected text in a numeric column rather than emitting it bare', () => {
    // Defensive: unrecognized text can never break statement syntax.
    expect(renderRaw('1); DROP TABLE t; --', 'int')).toBe("'1); DROP TABLE t; --'");
  });
});

describe('renderColumnValue: binary', () => {
  it('renders binary families as hexadecimal when hexBlob is on', () => {
    for (const type of ['blob', 'longblob', 'binary', 'varbinary', 'bit']) {
      expect(
        renderColumnValue(Buffer.from([0x00, 0xff]), column(type), { hexBlob: true }),
        type,
      ).toBe('0x00FF');
    }
  });

  it('renders an empty binary value as an empty string literal', () => {
    expect(renderColumnValue(Buffer.alloc(0), column('blob'), { hexBlob: true })).toBe("''");
  });

  it('renders raw bytes with the _binary introducer when hexBlob is off', () => {
    const rendered = renderColumnValue(Buffer.from([0x00, 0xff, 0x27]), column('blob'), {
      hexBlob: false,
    });
    expect(Buffer.isBuffer(rendered)).toBe(true);
    expect((rendered as Buffer).toString('latin1')).toBe(
      `_binary '\\0${String.fromCharCode(0xff)}\\''`,
    );
  });

  it('never routes binary through a string, so invalid UTF-8 survives', () => {
    const bytes = Buffer.from([0xed, 0xa0, 0x80, 0xff]);
    const rendered = renderColumnValue(bytes, column('blob'), { hexBlob: false }) as Buffer;
    expect(rendered.subarray("_binary '".length, -1)).toEqual(bytes);
  });

  it('renders spatial values as byte literals, preserving the SRID prefix', () => {
    // MySQL sends a spatial value as SRID + WKB and accepts that form back,
    // so no ST_GeomFromText constructor is involved.
    const internal = Buffer.from([0xe6, 0x10, 0x00, 0x00, 0x01, 0x01]);
    expect(renderColumnValue(internal, column('point'), { hexBlob: true })).toBe('0xE61000000101');
  });
});

describe('renderColumnValue: text and temporal', () => {
  it('quotes and escapes text', () => {
    expect(renderRaw("it's", 'varchar')).toBe("'it\\'s'");
    expect(renderRaw('', 'varchar')).toBe("''");
  });

  it('preserves utf8mb4 text including astral characters', () => {
    expect(renderRaw('emoji 😀 中文', 'text')).toBe("'emoji 😀 中文'");
  });

  it('preserves zero dates and out-of-range TIME values verbatim', () => {
    // Neither is representable as a JavaScript Date; both come through as
    // the server's own text.
    expect(renderRaw('0000-00-00', 'date')).toBe("'0000-00-00'");
    expect(renderRaw('0000-00-00 00:00:00', 'datetime')).toBe("'0000-00-00 00:00:00'");
    expect(renderRaw('-838:59:59.000', 'time')).toBe("'-838:59:59.000'");
    expect(renderRaw('838:59:59.000', 'time')).toBe("'838:59:59.000'");
  });

  it('preserves fractional-second precision', () => {
    expect(renderRaw('2020-02-29 12:34:56.789012', 'datetime')).toBe(
      "'2020-02-29 12:34:56.789012'",
    );
  });

  it('preserves ENUM and SET values, including the empty set', () => {
    expect(renderRaw('hardcover', 'enum')).toBe("'hardcover'");
    expect(renderRaw('new,signed', 'set')).toBe("'new,signed'");
    expect(renderRaw('', 'set')).toBe("''");
  });

  it('preserves JSON text with its original spacing and key order', () => {
    // A driver that parsed and re-serialized this would reorder keys and
    // drop the spaces; the raw path does neither.
    const json = '{"b": 1, "a": [1, 2, {"c": null}]}';
    expect(renderRaw(json, 'json')).toBe(`'{\\"b\\": 1, \\"a\\": [1, 2, {\\"c\\": null}]}'`);
  });
});

describe('renderColumnValue: driver-native fallback', () => {
  it('renders a bigint without going through a JavaScript number', () => {
    expect(renderColumnValue(9223372036854775807n, column('bigint'), { hexBlob: true })).toBe(
      '9223372036854775807',
    );
  });

  it('renders a boolean as 1/0', () => {
    expect(renderColumnValue(true, column('tinyint'), { hexBlob: true })).toBe('1');
    expect(renderColumnValue(false, column('tinyint'), { hexBlob: true })).toBe('0');
  });

  it('renders a Date using UTC fields, matching the dump TIME_ZONE guard', () => {
    const value = new Date(Date.UTC(2020, 1, 29, 12, 34, 56, 789));
    expect(renderColumnValue(value, column('datetime'), { hexBlob: true })).toBe(
      "'2020-02-29 12:34:56.789'",
    );
    expect(renderColumnValue(value, column('date'), { hexBlob: true })).toBe("'2020-02-29'");
    expect(renderColumnValue(value, column('time'), { hexBlob: true })).toBe("'12:34:56'");
  });

  it('serializes a driver-parsed JSON object', () => {
    expect(renderColumnValue({ a: 1 }, column('json'), { hexBlob: true })).toBe(`'{\\"a\\":1}'`);
  });
});

describe('column classification', () => {
  it('recognizes the binary families', () => {
    for (const type of [
      'blob',
      'tinyblob',
      'mediumblob',
      'longblob',
      'binary',
      'varbinary',
      'bit',
    ]) {
      expect(isBinaryColumn(column(type)), type).toBe(true);
    }
    for (const type of ['text', 'varchar', 'char', 'json']) {
      expect(isBinaryColumn(column(type)), type).toBe(false);
    }
  });

  it('recognizes spatial types as binary too', () => {
    expect(isSpatialColumn(column('polygon'))).toBe(true);
    expect(isBinaryColumn(column('polygon'))).toBe(true);
  });

  it('recognizes numeric types, with BIT deliberately included', () => {
    expect(isNumericColumn(column('decimal'))).toBe(true);
    // BIT is numeric in MySQL but arrives as bytes, so the binary path wins.
    expect(isNumericColumn(column('bit'))).toBe(true);
    expect(isBinaryColumn(column('bit'))).toBe(true);
    expect(isNumericColumn(column('varchar'))).toBe(false);
  });

  it('recognizes generated columns, which can never be inserted', () => {
    expect(isGeneratedColumn({ generation: 'virtual' })).toBe(true);
    expect(isGeneratedColumn({ generation: 'stored' })).toBe(true);
    expect(isGeneratedColumn({ generation: 'none' })).toBe(false);
  });
});
