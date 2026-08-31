import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { introspectMysql } from '../src/introspection/introspect.js';
import { restoreSqlDump } from '../src/restore/restoreSqlDump.js';
import { compareTableData, normalizeDatabase, normalizeDumpText } from './helpers/compare.js';
import { dumpToBuffer } from './helpers/dump.js';
import { createFixtureDatabases } from './helpers/fixtureDatabase.js';
import type { FixtureDatabases } from './helpers/fixtureDatabase.js';
import {
  createTestDatabase,
  dropDatabaseIfExists,
  nativeMysqlRestore,
  nativeMysqldump,
  probeServer,
  selectedTargets,
} from './helpers/server.js';
import type { ServerTarget, TestDatabase } from './helpers/server.js';

const OUTPUT_DIRECTORY = 'test-output/interop';

/**
 * The native-compatibility matrix, run against every configured MySQL
 * version.
 *
 * Four paths, each proving one direction of the two-way compatibility
 * promise the README makes:
 *
 * | Test | Dump produced by | Restored by      | Proves                              |
 * | ---- | ---------------- | ---------------- | ----------------------------------- |
 * | A    | this package     | native `mysql`   | our dumps are native-restorable     |
 * | B    | native mysqldump | this package     | we can restore native dumps         |
 * | C    | this package     | this package     | our own round trip is lossless      |
 * | D    | native mysqldump | native `mysql`   | baseline: the fixture itself is sane |
 *
 * Every path ends the same way: introspect the restored database, project it
 * through `normalizeDatabase`, and deep-compare it against the source —
 * *and* compare every table's rows byte for byte. A path that "restored
 * without error" but lost a value fails here, which is the point.
 *
 * `mysqldump` and `mysql` are invoked inside the server's own Docker
 * container. They are test tooling only; nothing under `src/` shells out,
 * and `tests/packageBoundaries.test.ts` asserts that stays true.
 */
describe.each(selectedTargets())('native interoperability: $label', (target: ServerTarget) => {
  let available = false;
  let fixture: FixtureDatabases | null = null;
  const scratchDatabases: TestDatabase[] = [];

  beforeAll(async () => {
    const availability = await probeServer(target);
    available = availability.available;
    if (!available) {
      return;
    }
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    fixture = await createFixtureDatabases(target, `interop_${target.id}`);
  });

  afterAll(async () => {
    for (const database of scratchDatabases) {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    }
    await fixture?.dispose();
  });

  /** A fresh empty database, disposed by this suite's `afterAll`. */
  async function freshTarget(name: string): Promise<TestDatabase> {
    const database = await createTestDatabase(target, `interop_${target.id}_${name}`);
    scratchDatabases.push(database);
    return database;
  }

  /**
   * Compares a restored database against the fixture source: schema model
   * first, then every table's rows.
   *
   * `stripDefiners` is set when the path under test rewrote definers, since
   * a definer difference is then the *expected* outcome rather than a
   * regression.
   */
  async function expectMatchesSource(
    restored: TestDatabase,
    options: { readonly stripDefiners?: boolean } = {},
  ): Promise<void> {
    const source = fixture as FixtureDatabases;
    const restoredIntrospection = await introspectMysql(restored.connection);

    expect(normalizeDatabase(restoredIntrospection.database, options)).toEqual(
      normalizeDatabase(source.sourceIntrospection.database, options),
    );

    const differences = await compareTableData(
      source.sourceIntrospection.database,
      source.source.connection,
      source.source.name,
      restored.connection,
      restored.name,
    );
    expect(
      differences.map(difference => difference.tableName),
      differences
        .map(
          difference =>
            `${difference.tableName}\n  source: ${difference.source.slice(0, 3).join('\n          ')}\n  target: ${difference.target.slice(0, 3).join('\n          ')}`,
        )
        .join('\n'),
    ).toEqual([]);
  }

  it('A: dbgate dump -> native mysql restore', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('a');

    const { sql } = await dumpToBuffer(source.source.connection, {
      databaseName: source.source.name,
      render: { includeTimestamp: false },
    });
    writeFileSync(`${OUTPUT_DIRECTORY}/${target.id}-a-dbgate-dump.sql`, sql);

    await nativeMysqlRestore(target, restored.name, sql);
    await expectMatchesSource(restored);
  });

  it('B: native mysqldump -> dbgate restore', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('b');

    const sql = await nativeMysqldump(target, source.source.name, [
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
    ]);
    writeFileSync(`${OUTPUT_DIRECTORY}/${target.id}-b-native-dump.sql`, sql);

    const result = await restoreSqlDump({
      connection: restored.connection,
      source: sql,
      options: { databaseName: restored.name },
    });

    expect(
      result.errors.map(
        error => `${error.statementIndex}: ${error.message} :: ${error.sqlPreview}`,
      ),
    ).toEqual([]);
    expect(result.statementsExecuted).toBeGreaterThan(10);
    await expectMatchesSource(restored);
  });

  it('C: dbgate dump -> dbgate restore', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('c');

    const { sql } = await dumpToBuffer(source.source.connection, {
      databaseName: source.source.name,
      render: { includeTimestamp: false },
    });

    const result = await restoreSqlDump({
      connection: restored.connection,
      source: sql,
      options: { databaseName: restored.name },
    });

    expect(
      result.errors.map(
        error => `${error.statementIndex}: ${error.message} :: ${error.sqlPreview}`,
      ),
    ).toEqual([]);
    await expectMatchesSource(restored);

    // Dumping the *restored* database must reproduce the original dump, which
    // is a stronger claim than "the models match": it also proves rendering is
    // deterministic, that nothing was reordered, and that every value came back
    // in the same literal form. The one normalization applied to both sides is
    // the server's column-charset re-rendering — see `normalizeDumpText`.
    const roundTripped = await dumpToBuffer(restored.connection, {
      databaseName: restored.name,
      render: { includeTimestamp: false },
    });
    expect(normalizeDumpText(roundTripped.text, restored.name)).toEqual(
      normalizeDumpText(sql.toString('utf8'), source.source.name),
    );
  });

  it('D: native mysqldump -> native mysql restore (baseline)', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('d');

    const sql = await nativeMysqldump(target, source.source.name, [
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
    ]);
    await nativeMysqlRestore(target, restored.name, sql);
    await expectMatchesSource(restored);
  });

  it('A (raw binary, hexBlob off): dbgate dump -> native mysql restore', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('araw');

    // The `_binary '...'` path writes bytes that are not valid UTF-8, so this
    // additionally proves the writer never routes a dump through a string.
    const { sql } = await dumpToBuffer(source.source.connection, {
      databaseName: source.source.name,
      render: { includeTimestamp: false, hexBlob: false },
    });
    writeFileSync(`${OUTPUT_DIRECTORY}/${target.id}-a-dbgate-dump-rawbinary.sql`, sql);

    await nativeMysqlRestore(target, restored.name, sql);
    await expectMatchesSource(restored);
  });

  it('C (one INSERT per row, explicit columns): dbgate dump -> dbgate restore', async () => {
    if (!available) return;
    const source = fixture as FixtureDatabases;
    const restored = await freshTarget('csingle');

    const { sql } = await dumpToBuffer(source.source.connection, {
      databaseName: source.source.name,
      render: { includeTimestamp: false, extendedInsert: false, completeInsert: true },
    });

    const result = await restoreSqlDump({
      connection: restored.connection,
      source: sql,
      options: { databaseName: restored.name },
    });
    expect(result.errors).toEqual([]);
    await expectMatchesSource(restored);
  });
});
