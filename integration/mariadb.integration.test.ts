import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectMysql } from '../src/introspection/introspect.js';
import type { MysqlRow } from '../src/connection/types.js';
import { dumpToBuffer } from './helpers/dump.js';
import {
  createTestDatabase,
  dropDatabaseIfExists,
  execStatements,
  nativeMysqlRestore,
  probeServer,
  selectedTargets,
} from './helpers/server.js';
import type { ServerTarget, TestDatabase } from './helpers/server.js';

const mariaTargets = selectedTargets().filter(target => target.flavor === 'mariadb');

if (mariaTargets.length === 0) {
  describe.skip('MariaDB fidelity', () => {
    it('requires a selected MariaDB target', () => {});
  });
}

describe.each(mariaTargets)('MariaDB fidelity: $label', (target: ServerTarget) => {
  let available = false;
  const databases: TestDatabase[] = [];

  beforeAll(async () => {
    available = (await probeServer(target)).available;
  });

  afterAll(async () => {
    for (const database of databases) {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    }
  });

  async function fresh(label: string): Promise<TestDatabase> {
    const database = await createTestDatabase(target, `maria_${target.id}_${label}`);
    databases.push(database);
    return database;
  }

  it('preserves MariaDB-specific columns, constraints and data through native restore', async () => {
    if (!available) return;
    const source = await fresh('source');
    const restored = await fresh('restored');
    await execStatements(source.connection, [
      `CREATE TABLE fidelity (
        id BIGINT PRIMARY KEY,
        payload JSON,
        hidden_text VARCHAR(40) INVISIBLE,
        generated_value BIGINT GENERATED ALWAYS AS (id * 2) STORED,
        created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),
        raw_data BLOB,
        location POINT,
        CONSTRAINT ck_positive CHECK (id > 0)
      ) ENGINE=InnoDB`,
      `INSERT INTO fidelity (id, payload, hidden_text, created_at, raw_data, location)
       VALUES (9007199254740993, '{"nested":{"ok":true}}', 'secret',
         '2025-02-03 04:05:06.123456', X'00FEFF', ST_GeomFromText('POINT(1 2)'))`,
    ]);

    const { sql, text } = await dumpToBuffer(source.connection, {
      databaseName: source.name,
      render: { includeTimestamp: false },
    });
    const sourceModel = await introspectMysql(source.connection, { databaseName: source.name });
    expect(sourceModel.version.flavor).toBe('mariadb');
    expect(text).toMatch(/^-- MariaDB dump /);
    expect(text).toContain('`payload` longtext');
    expect(text).toContain('INVISIBLE');
    expect(text).toContain('GENERATED ALWAYS');
    expect(text).toContain('CONSTRAINT `ck_positive` CHECK');

    await nativeMysqlRestore(target, restored.name, sql);
    const rows = await restored.connection.query<MysqlRow>(
      {
        sql: `SELECT CAST(id AS CHAR) id, payload, hidden_text AS hiddenText,
          CAST(generated_value AS CHAR) generatedValue,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') createdAt,
          HEX(raw_data) rawData, ST_AsText(location) location
        FROM fidelity`,
      },
      undefined,
      'raw',
    );
    const decodedRows = rows.rows.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          Buffer.isBuffer(value) ? value.toString('utf8') : value,
        ]),
      ),
    );
    expect(decodedRows).toEqual([
      {
        id: '9007199254740993',
        payload: '{"nested":{"ok":true}}',
        hiddenText: 'secret',
        generatedValue: '18014398509481986',
        createdAt: '2025-02-03 04:05:06.123456',
        rawData: '00FEFF',
        location: 'POINT(1 2)',
      },
    ]);
  });

  it('reports unsupported MariaDB sequence and system-history semantics explicitly', async () => {
    if (!available) return;
    const source = await fresh('sequence');
    await execStatements(source.connection, [
      'CREATE SEQUENCE invoice_sequence START WITH 42',
      'CREATE TABLE audit_history (id INT PRIMARY KEY, value VARCHAR(20)) WITH SYSTEM VERSIONING',
    ]);
    const result = await introspectMysql(source.connection, { databaseName: source.name });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'mariadb-sequence-not-dumped' }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'mariadb-system-version-history-not-dumped' }),
    );
  });
});
