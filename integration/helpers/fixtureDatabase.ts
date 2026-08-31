import { introspectMysql } from '../../src/introspection/introspect.js';
import type { MysqlIntrospectionResult } from '../../src/introspection/types.js';
import { detectSourceCapabilities } from '../../src/version/capabilities.js';
import { detectMysqlVersion } from '../../src/version/detect.js';
import { buildDataStatements } from '../fixture/data.js';
import { buildProgramStatements, buildSchemaStatements } from '../fixture/schema.js';
import type { ServerTarget, TestDatabase } from './server.js';
import { createTestDatabase, dropDatabaseIfExists, execStatements } from './server.js';

export interface FixtureDatabases {
  readonly source: TestDatabase;
  readonly target: TestDatabase;
  /** Introspection of the fully-populated source, cached for reuse across assertions. */
  readonly sourceIntrospection: MysqlIntrospectionResult;
  dispose(): Promise<void>;
}

/**
 * Builds the source database — tables, then data, then views/triggers/
 * routines/event — and an empty target database, on one server.
 *
 * The ordering is load-bearing: data is inserted *before* the triggers
 * exist, so a trigger cannot fabricate audit rows the assertions do not
 * expect. That is the same reason `mysqldump` emits triggers after a
 * table's data, so the fixture and the dump agree.
 */
export async function createFixtureDatabases(
  target: ServerTarget,
  prefix: string,
): Promise<FixtureDatabases> {
  const source = await createTestDatabase(target, `${prefix}_src`);
  let targetDatabase: TestDatabase | null = null;

  try {
    const version = await detectMysqlVersion(source.connection);
    const capabilities = detectSourceCapabilities(version);

    await execStatements(source.connection, buildSchemaStatements(capabilities));
    await execStatements(source.connection, buildDataStatements(capabilities));
    await execStatements(source.connection, buildProgramStatements(capabilities));

    const sourceIntrospection = await introspectMysql(source.connection);

    targetDatabase = await createTestDatabase(target, `${prefix}_tgt`);
    const createdTarget = targetDatabase;

    return {
      source,
      target: createdTarget,
      sourceIntrospection,
      dispose: async () => {
        await source.close().catch(() => {});
        await createdTarget.close().catch(() => {});
        await dropDatabaseIfExists(target, source.name).catch(() => {});
        await dropDatabaseIfExists(target, createdTarget.name).catch(() => {});
      },
    };
  } catch (error) {
    await source.close().catch(() => {});
    await dropDatabaseIfExists(target, source.name).catch(() => {});
    if (targetDatabase) {
      await targetDatabase.close().catch(() => {});
      await dropDatabaseIfExists(target, targetDatabase.name).catch(() => {});
    }
    throw error;
  }
}

/** Creates just an empty database, for suites that build their own tiny schema. */
export async function createEmptyDatabase(
  target: ServerTarget,
  prefix: string,
): Promise<{ readonly database: TestDatabase; dispose(): Promise<void> }> {
  const database = await createTestDatabase(target, prefix);
  return {
    database,
    dispose: async () => {
      await database.close().catch(() => {});
      await dropDatabaseIfExists(target, database.name).catch(() => {});
    },
  };
}
