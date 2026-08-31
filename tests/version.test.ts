import { describe, expect, it } from 'vitest';
import { checkTargetCompatibility } from '../src/compatibility/check.js';
import { unsupportedFeatureDiagnostics } from '../src/compatibility/unsupported.js';
import { detectSourceCapabilities } from '../src/version/capabilities.js';
import { detectMysqlVersion } from '../src/version/detect.js';
import { detectMysqlFlavor, parseMysqlVersion } from '../src/version/types.js';
import type { MysqlVersion } from '../src/version/types.js';
import { makeCheckConstraint, makeColumn, makeDatabase, makeIndex, makeTable } from './fixtures.js';
import { MockMysqlConnection } from './mockConnection.js';

function version(overrides: Partial<MysqlVersion> = {}): MysqlVersion {
  return {
    versionString: '8.0.36',
    majorVersion: 8,
    minorVersion: 0,
    patchVersion: 36,
    versionNumber: 80036,
    flavor: 'mysql',
    ...overrides,
  };
}

describe('parseMysqlVersion', () => {
  it('parses the leading three components and ignores vendor suffixes', () => {
    expect(parseMysqlVersion('8.0.36')).toEqual({
      majorVersion: 8,
      minorVersion: 0,
      patchVersion: 36,
      versionNumber: 80036,
    });
    expect(parseMysqlVersion('8.0.36-0ubuntu0.22.04.1').versionNumber).toBe(80036);
    expect(parseMysqlVersion('10.11.6-MariaDB-1:10.11.6+maria~ubu2204').versionNumber).toBe(101106);
  });

  it('defaults a missing patch component to zero', () => {
    expect(parseMysqlVersion('8.4').versionNumber).toBe(80400);
  });

  it('throws on unparseable input rather than guessing', () => {
    expect(() => parseMysqlVersion('not a version')).toThrow();
  });
});

describe('detectMysqlFlavor', () => {
  it('recognizes MariaDB from its version string', () => {
    expect(detectMysqlFlavor('10.11.6-MariaDB', 'mariadb.org binary distribution')).toBe('mariadb');
  });

  it('recognizes Percona from the version comment', () => {
    expect(detectMysqlFlavor('8.0.36-28', 'Percona Server (GPL)')).toBe('percona');
  });

  it('recognizes MySQL', () => {
    expect(detectMysqlFlavor('8.0.36', 'MySQL Community Server - GPL')).toBe('mysql');
  });
});

describe('detectMysqlVersion', () => {
  it('reads VERSION() and the version comment', async () => {
    const connection = new MockMysqlConnection([
      {
        match: 'VERSION()',
        rows: [{ versionString: '8.4.0', versionComment: 'MySQL Community Server - GPL' }],
      },
    ]);
    const detected = await detectMysqlVersion(connection);
    expect(detected.versionNumber).toBe(80400);
    expect(detected.flavor).toBe('mysql');
  });

  it('throws when the server reports nothing', async () => {
    await expect(detectMysqlVersion(new MockMysqlConnection())).rejects.toThrow(
      /Unable to detect MySQL version/,
    );
  });
});

describe('detectSourceCapabilities', () => {
  it('gates features at the patch release that shipped them', () => {
    // CHECK constraints arrived in 8.0.16, not in 8.0.
    expect(
      detectSourceCapabilities(version({ versionNumber: 80015 })).supportsCheckConstraints,
    ).toBe(false);
    expect(
      detectSourceCapabilities(version({ versionNumber: 80016 })).supportsCheckConstraints,
    ).toBe(true);
    expect(
      detectSourceCapabilities(version({ versionNumber: 80022 })).supportsInvisibleColumns,
    ).toBe(false);
    expect(
      detectSourceCapabilities(version({ versionNumber: 80023 })).supportsInvisibleColumns,
    ).toBe(true);
  });

  it('reports 5.7 capabilities correctly', () => {
    const capabilities = detectSourceCapabilities(version({ versionNumber: 50744 }));
    expect(capabilities.supportsGeneratedColumns).toBe(true);
    expect(capabilities.supportsJsonType).toBe(true);
    expect(capabilities.supportsCheckConstraints).toBe(false);
    expect(capabilities.supportsDescendingIndexes).toBe(false);
  });

  it('gives MariaDB the conservative set regardless of its version number', () => {
    // MariaDB 10.11 numerically exceeds MySQL 8.0, but the numbering is
    // unrelated; claiming 8.0 features from it would be wrong.
    const capabilities = detectSourceCapabilities(
      version({ versionNumber: 101106, flavor: 'mariadb' }),
    );
    expect(capabilities.supportsCheckConstraints).toBe(false);
    expect(capabilities.supportsDescendingIndexes).toBe(false);
  });
});

describe('checkTargetCompatibility', () => {
  const oldTarget = detectSourceCapabilities(version({ versionNumber: 50744 }));

  /**
   * A table whose collation predates MySQL 8.0.
   *
   * `makeTable`'s default is `utf8mb4_0900_ai_ci`, which only exists from 8.0
   * on, so leaving it would add a second diagnostic to every case here and
   * obscure the one under test.
   */
  const legacyTable = (pureName: string, columns?: Parameters<typeof makeTable>[0]['columns']) =>
    makeTable({
      pureName,
      tableCollation: 'utf8mb4_general_ci',
      ...(columns === undefined ? {} : { columns }),
    });

  it('reports a CHECK constraint the target cannot accept', () => {
    const database = makeDatabase({
      tables: [legacyTable('t')],
      checkConstraints: [makeCheckConstraint({ tableName: 't', constraintName: 'ck' })],
    });
    const diagnostics = checkTargetCompatibility(database, oldTarget);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('unsupported-target-feature');
    expect(diagnostics[0]?.message).toContain('CHECK constraints');
  });

  it('reports a descending index the target cannot accept', () => {
    const database = makeDatabase({
      tables: [legacyTable('t')],
      indexes: [
        makeIndex({
          tableName: 't',
          indexName: 'ix',
          columns: [
            {
              columnName: 'id',
              ordinalPosition: 1,
              prefixLength: null,
              direction: 'DESC',
              expression: null,
            },
          ],
        }),
      ],
    });
    expect(checkTargetCompatibility(database, oldTarget)[0]?.message).toContain(
      'descending and functional indexes',
    );
  });

  it('reports a JSON column and an invisible column', () => {
    const database = makeDatabase({
      tables: [
        legacyTable('t', [
          makeColumn({ columnName: 'j', dataType: 'json', columnType: 'json' }),
          makeColumn({ columnName: 'h', isInvisible: true }),
        ]),
      ],
    });
    const codes = checkTargetCompatibility(database, oldTarget).map(d => d.message);
    expect(codes.some(message => message.includes('INVISIBLE columns'))).toBe(true);
    // 5.7 does support JSON, so that one must not be reported.
    expect(codes.some(message => message.includes('JSON data type'))).toBe(false);
  });

  it('reports a collation the target does not have', () => {
    // utf8mb4_0900_ai_ci is MySQL 8.0 and later only.
    const database = makeDatabase({ tables: [makeTable({ pureName: 't' })] });
    expect(checkTargetCompatibility(database, oldTarget)[0]?.message).toContain(
      'utf8mb4_0900_* collations',
    );
  });

  it('reports nothing when the target is new enough', () => {
    const database = makeDatabase({
      tables: [makeTable({ pureName: 't' })],
      checkConstraints: [makeCheckConstraint({ tableName: 't', constraintName: 'ck' })],
    });
    const newTarget = detectSourceCapabilities(version({ versionNumber: 80400 }));
    expect(checkTargetCompatibility(database, newTarget)).toEqual([]);
  });
});

describe('unsupportedFeatureDiagnostics', () => {
  it('names every server-wide feature this package does not dump', () => {
    const codes = unsupportedFeatureDiagnostics().map(diagnostic => diagnostic.code);
    expect(codes).toContain('users-and-grants-not-dumped');
    expect(codes).toContain('replication-state-not-dumped');
    expect(codes).toContain('tablespaces-not-dumped');
    expect(codes).toContain('ndb-objects-not-dumped');
  });

  it('reports them as info, not as warnings, since every dump has them', () => {
    expect(
      unsupportedFeatureDiagnostics().every(diagnostic => diagnostic.severity === 'info'),
    ).toBe(true);
  });

  it('explains each one rather than only naming it', () => {
    for (const diagnostic of unsupportedFeatureDiagnostics()) {
      expect(diagnostic.message.length).toBeGreaterThan(80);
    }
  });
});
