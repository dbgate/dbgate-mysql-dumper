import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(import.meta.dirname, '..', 'src');

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

const SOURCE_FILES = collectSourceFiles(SOURCE_ROOT);

/** Source files excluding the optional driver adapter entry point. */
const CORE_FILES = SOURCE_FILES.filter(
  path => relative(SOURCE_ROOT, path).replace(/\\/g, '/') !== 'mysql2.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Architectural constraints, enforced as tests rather than left to review.
 *
 * Each of these is a promise the README makes. A promise that is only
 * documented is a promise that breaks quietly, so each has a test that fails
 * the moment it stops being true.
 */
describe('package boundaries', () => {
  it('has source files to check', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(20);
  });

  it('never spawns a process: no child_process anywhere in src/', () => {
    // The central constraint of this package. `mysqldump` and `mysql` are
    // used only by the integration tests, to prove interoperability.
    for (const path of SOURCE_FILES) {
      const source = read(path);
      expect(source, path).not.toMatch(/from\s+['"]node:child_process['"]/);
      expect(source, path).not.toMatch(/require\(['"]child_process['"]\)/);
      expect(source, path).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(source, path).not.toMatch(/\bexecFile(Sync)?\s*\(/);
    }
  });

  it('never shells out to the native tools by name', () => {
    for (const path of SOURCE_FILES) {
      const source = read(path);
      // The names appear in prose and option docs throughout; what must not
      // appear is an attempt to *run* them.
      expect(source, path).not.toMatch(/exec\w*\(\s*['"`]mysqldump/);
      expect(source, path).not.toMatch(/exec\w*\(\s*['"`]mysql\b/);
    }
  });

  it('keeps the core free of any mysql2 import', () => {
    // mysql2 is an optional peer dependency reachable only through the
    // separate `dbgate-mysql-dumper/mysql2` entry point.
    for (const path of CORE_FILES) {
      const source = read(path);
      expect(source, path).not.toMatch(/from\s+['"]mysql2/);
      expect(source, path).not.toMatch(/import\(\s*['"]mysql2/);
      expect(source, path).not.toMatch(/require\(['"]mysql2/);
    }
  });

  it('reaches mysql2 only through the adapter entry point', () => {
    const adapter = read(join(SOURCE_ROOT, 'mysql2.ts'));
    // A type-only import costs nothing at runtime; the value import is
    // dynamic, so loading this module without mysql2 installed still works.
    expect(adapter).toMatch(/import type \{[^}]*\} from 'mysql2';/);
    expect(adapter).toMatch(/await import\('mysql2'\)/);
    expect(adapter).not.toMatch(/^import \{[^}]*\} from 'mysql2';/m);
  });

  it('never splits SQL on a bare semicolon', () => {
    // The restore path uses a real lexer; a `split(';')` anywhere in src/
    // would mean something bypassed it.
    for (const path of SOURCE_FILES) {
      expect(read(path), path).not.toMatch(/\.split\(\s*['"];['"]\s*\)/);
    }
  });

  it('has no raw NUL byte in any source file', () => {
    // A NUL in a source file breaks some editors and diff tools; the one
    // place the code needs the code point uses a charCode comparison.
    for (const path of SOURCE_FILES) {
      expect(readFileSync(path).indexOf(0), path).toBe(-1);
    }
  });

  it('uses only relative .js specifiers between core modules', () => {
    // NodeNext resolution requires the extension; a missing one only fails
    // once the package is consumed as ESM, which is far too late to notice.
    for (const path of SOURCE_FILES) {
      const source = read(path);
      const specifiers = [...source.matchAll(/from\s+'(\.[^']*)'/g)].map(
        match => match[1] as string,
      );
      for (const specifier of specifiers) {
        expect(specifier.endsWith('.js'), `${path}: ${specifier}`).toBe(true);
      }
    }
  });
});

describe('public API surface', () => {
  // These import the whole barrel, which makes Vitest transform every module
  // in `src/` on a cold run; the default 5s timeout is not enough for that.
  const IMPORT_TIMEOUT = 60_000;

  it(
    'exports every documented entry point from the root module',
    { timeout: IMPORT_TIMEOUT },
    async () => {
      const api = await import('../src/index.js');
      for (const name of [
        'dumpMysql',
        'restoreSqlDump',
        'introspectMysql',
        'inspectDumpArchive',
        'renderPlainSql',
        'exportTableDataAsInserts',
        'preflightRestore',
        'isMysqlDump',
        'parseSqlStatements',
        'streamSqlStatements',
        'beginMysqlDumpSession',
        'checkTargetCompatibility',
        'quoteIdentifier',
        'quoteMysqlString',
        'StreamDumpWriter',
        'BufferDumpWriter',
      ]) {
        expect(api, name).toHaveProperty(name);
      }
    },
  );

  it(
    'exports the adapter functions from the mysql2 entry point',
    { timeout: IMPORT_TIMEOUT },
    async () => {
      const adapter = await import('../src/mysql2.js');
      expect(adapter).toHaveProperty('fromMysql2Connection');
      expect(adapter).toHaveProperty('fromMysql2Pool');
      expect(adapter).toHaveProperty('connectMysql2');
    },
  );

  it(
    'does not leak internal helpers whose names would collide',
    { timeout: IMPORT_TIMEOUT },
    async () => {
      const api = (await import('../src/index.js')) as Record<string, unknown>;
      // `escapeMysqlString` is re-exported from two modules; the barrel must
      // still resolve to exactly one binding.
      expect(typeof api.escapeMysqlString).toBe('function');
    },
  );
});
