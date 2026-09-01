import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MysqlConnection } from '../../src/connection/types.js';
import { quoteIdentifier } from '../../src/security/identifiers.js';
import { connectMysql2 } from '../../src/mysql2.js';

const execFileAsync = promisify(execFile);

/**
 * One MySQL server version under test.
 *
 * `container` is the Docker container name from `integration/docker-compose.yml`.
 * It is used *only* to reach the `mysqldump` and `mysql` binaries that ship
 * inside the image, for the native-interoperability tests — the library under
 * test never invokes an external process, and nothing in `src/` knows these
 * exist. See `docs/round-trip-testing.md`.
 */
export interface ServerTarget {
  readonly id: string;
  readonly label: string;
  readonly flavor: 'mysql' | 'mariadb';
  readonly port: number;
  readonly container: string;
}

export const SERVER_TARGETS: readonly ServerTarget[] = [
  {
    id: 'mysql57',
    label: 'MySQL 5.7',
    flavor: 'mysql',
    port: 33057,
    container: 'dbgate-mysql-dumper-57',
  },
  {
    id: 'mysql80',
    label: 'MySQL 8.0',
    flavor: 'mysql',
    port: 33080,
    container: 'dbgate-mysql-dumper-80',
  },
  {
    id: 'mysql84',
    label: 'MySQL 8.4',
    flavor: 'mysql',
    port: 33084,
    container: 'dbgate-mysql-dumper-84',
  },
  {
    id: 'mariadb106',
    label: 'MariaDB 10.6',
    flavor: 'mariadb',
    port: 33106,
    container: 'dbgate-mysql-dumper-mariadb-106',
  },
  {
    id: 'mariadb1011',
    label: 'MariaDB 10.11',
    flavor: 'mariadb',
    port: 33111,
    container: 'dbgate-mysql-dumper-mariadb-1011',
  },
  {
    id: 'mariadb114',
    label: 'MariaDB 11.4',
    flavor: 'mariadb',
    port: 33114,
    container: 'dbgate-mysql-dumper-mariadb-114',
  },
];

export interface ServerConfig {
  readonly host: string;
  readonly user: string;
  readonly password: string;
  /** When true, an unreachable server is a hard failure instead of a skip. CI should set this. */
  readonly required: boolean;
  /** How long to keep retrying the initial connection (the container may still be starting). */
  readonly waitMs: number;
}

export function readServerConfig(): ServerConfig {
  return {
    host: process.env.MYSQL_TEST_HOST ?? '127.0.0.1',
    user: process.env.MYSQL_TEST_USER ?? 'root',
    password: process.env.MYSQL_TEST_PASSWORD ?? 'Str0ng!Passw0rd#2024',
    required: process.env.MYSQL_TEST_REQUIRED === '1',
    waitMs: Number(process.env.MYSQL_TEST_WAIT_MS ?? 60_000),
  };
}

/** Targets to exercise, filtered by `MYSQL_TEST_TARGETS` (comma-separated ids) when set. */
export function selectedTargets(): readonly ServerTarget[] {
  const requested = process.env.MYSQL_TEST_TARGETS;
  if (!requested) {
    return SERVER_TARGETS;
  }
  const ids = new Set(requested.split(',').map(id => id.trim()));
  return SERVER_TARGETS.filter(target => ids.has(target.id));
}

export interface OpenConnection {
  readonly connection: MysqlConnection;
  close(): Promise<void>;
}

/** Opens one physical connection through this package's own mysql2 adapter. */
export async function openConnection(
  target: ServerTarget,
  database?: string,
): Promise<OpenConnection> {
  const config = readServerConfig();
  return connectMysql2({
    host: config.host,
    port: target.port,
    user: config.user,
    password: config.password,
    ...(database ? { database } : {}),
    // Deliberately left at driver defaults otherwise: these tests exist to
    // exercise this package's own value handling, not mysql2's conveniences.
    connectTimeout: 15_000,
    multipleStatements: false,
    charset: 'utf8mb4_unicode_ci',
  });
}

export interface ServerAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly versionString?: string;
}

const availabilityByTarget = new Map<string, Promise<ServerAvailability>>();

async function attemptProbe(target: ServerTarget): Promise<ServerAvailability> {
  const config = readServerConfig();
  const deadline = Date.now() + config.waitMs;
  let lastError = 'unknown error';

  for (;;) {
    let opened: OpenConnection | null = null;
    try {
      opened = await openConnection(target);
      const result = await opened.connection.query<{ version: string }>(
        { sql: 'SELECT VERSION() AS version' },
        undefined,
        'native',
      );
      return { available: true, versionString: String(result.rows[0]?.version ?? '') };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await opened?.close().catch(() => {});
    }

    if (Date.now() >= deadline) {
      return {
        available: false,
        reason:
          `No MySQL reachable at ${config.host}:${target.port} (${target.label}) after ${config.waitMs}ms — ${lastError}. ` +
          'Start one with "npm run docker:up", or point MYSQL_TEST_HOST/MYSQL_TEST_USER/MYSQL_TEST_PASSWORD at existing instances.',
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Probes one server once per process. Integration suites gate themselves on
 * the result: absent a server they skip (so `npm run test:integration` is
 * runnable on a machine without Docker), unless `MYSQL_TEST_REQUIRED=1`,
 * which turns absence into a thrown error so the suites can never silently
 * no-op where they were meant to run.
 */
export function probeServer(target: ServerTarget): Promise<ServerAvailability> {
  let probe = availabilityByTarget.get(target.id);
  if (!probe) {
    probe = attemptProbe(target).then(availability => {
      if (!availability.available) {
        if (readServerConfig().required) {
          throw new Error(`MYSQL_TEST_REQUIRED=1 but ${availability.reason}`);
        }
        console.warn(`\n[integration] SKIPPING ${target.label}: ${availability.reason}\n`);
      }
      return availability;
    });
    availabilityByTarget.set(target.id, probe);
  }
  return probe;
}

/**
 * Executes a list of already-delimited SQL statements sequentially.
 *
 * Deliberately does NOT go through `restoreSqlDump`: a fixture database must
 * be created by something independent of the code under test, otherwise a
 * statement-splitting bug could corrupt the fixture and mask itself. Each
 * array element is exactly one statement, so no delimiter handling is
 * involved at all here.
 */
export async function execStatements(
  connection: MysqlConnection,
  statements: readonly string[],
): Promise<void> {
  for (const [index, sql] of statements.entries()) {
    try {
      await connection.query({ sql }, undefined, 'native');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Fixture statement #${index} failed: ${message}\n--- statement ---\n${sql}\n-----------------`,
      );
    }
  }
}

let databaseCounter = 0;

export interface TestDatabase {
  readonly name: string;
  readonly target: ServerTarget;
  readonly connection: MysqlConnection;
  close(): Promise<void>;
}

export async function dropDatabaseIfExists(target: ServerTarget, name: string): Promise<void> {
  const admin = await openConnection(target);
  try {
    // The name comes from this helper, never from user input, but it is
    // quoted properly anyway — the same rule the library itself follows.
    await admin.connection.query(
      { sql: `DROP DATABASE IF EXISTS ${quoteIdentifier(name)}` },
      undefined,
      'native',
    );
  } finally {
    await admin.close();
  }
}

/**
 * Creates a fresh, empty database with a unique name and returns an open
 * connection to it. Callers must `close()` it and then
 * {@link dropDatabaseIfExists} in an `afterAll`.
 */
export async function createTestDatabase(
  target: ServerTarget,
  prefix: string,
  charset = 'utf8mb4',
): Promise<TestDatabase> {
  const name = `${prefix}_${Date.now().toString(36)}_${++databaseCounter}`;
  const admin = await openConnection(target);
  try {
    await admin.connection.query(
      {
        sql: `CREATE DATABASE ${quoteIdentifier(name)} DEFAULT CHARACTER SET ${charset}`,
      },
      undefined,
      'native',
    );
  } finally {
    await admin.close();
  }

  const opened = await openConnection(target, name);
  return { name, target, connection: opened.connection, close: opened.close };
}

/**
 * Runs a native client binary inside the server's own container.
 *
 * **Only integration tests may use this.** Its whole purpose is to prove
 * that dumps produced by this library restore through the real `mysql`
 * client, and that dumps produced by the real `mysqldump` restore through
 * this library. Nothing under `src/` shells out — that is the package's
 * central constraint, and a unit test (`tests/packageBoundaries.test.ts`)
 * asserts it stays true.
 */
export async function runInContainer(
  target: ServerTarget,
  argv: readonly string[],
  stdin?: Buffer,
): Promise<{ stdout: Buffer; stderr: string }> {
  const config = readServerConfig();
  const args = [
    'exec',
    ...(stdin ? ['-i'] : []),
    '-e',
    `MYSQL_PWD=${config.password}`,
    target.container,
    ...argv,
  ];

  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const stderrText = stderr.toString('utf8');
        if (error) {
          reject(new Error(`docker ${args.join(' ')} failed: ${stderrText || error.message}`));
          return;
        }
        resolve({ stdout, stderr: stderrText });
      },
    );
    if (stdin) {
      child.stdin?.end(stdin);
    }
  });
}

/** Runs the container's own `mysqldump`, returning the dump bytes. */
export async function nativeMysqldump(
  target: ServerTarget,
  database: string,
  extraArgs: readonly string[] = [],
): Promise<Buffer> {
  const config = readServerConfig();
  const { stdout } = await runInContainer(target, [
    target.flavor === 'mariadb' ? 'mariadb-dump' : 'mysqldump',
    '--default-character-set=utf8mb4',
    '-h',
    '127.0.0.1',
    '-u',
    config.user,
    ...extraArgs,
    database,
  ]);
  return stdout;
}

/** Feeds `sql` to the container's own `mysql` client, the way `mysql db < dump.sql` would. */
export async function nativeMysqlRestore(
  target: ServerTarget,
  database: string,
  sql: Buffer,
): Promise<void> {
  const config = readServerConfig();
  await runInContainer(
    target,
    [
      target.flavor === 'mariadb' ? 'mariadb' : 'mysql',
      '--default-character-set=utf8mb4',
      '-h',
      '127.0.0.1',
      '-u',
      config.user,
      database,
    ],
    sql,
  );
}

/** Ensures `docker` itself is usable, so a missing Docker is reported once and clearly. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}
