/**
 * Post-build smoke test: loads the built `dist/` as both ESM and CJS and
 * exercises the parts that need no database.
 *
 * This catches the class of failure a unit test run against `src/` cannot:
 * a broken `exports` map, a missing `.d.ts`, an ESM/CJS interop mistake, or
 * an accidental top-level `mysql2` import that would make the core package
 * unloadable without the optional peer dependency installed.
 *
 * Run with `npm run test:package`.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(description, condition) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.error(`  FAIL ${description}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

section('build output');
for (const file of [
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/mysql2.js',
  'dist/mysql2.cjs',
  'dist/mysql2.d.ts',
]) {
  check(`${file} exists`, existsSync(join(root, file)));
}

section('ESM entry point');
const esm = await import(new URL('../dist/index.js', import.meta.url).href);
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
]) {
  check(`exports ${name}`, typeof esm[name] === 'function');
}

section('CJS entry point');
const cjs = require(join(root, 'dist/index.cjs'));
check('exports dumpMysql', typeof cjs.dumpMysql === 'function');
check('exports restoreSqlDump', typeof cjs.restoreSqlDump === 'function');
check('exports isMysqlDump', typeof cjs.isMysqlDump === 'function');

section('mysql2 adapter entry point');
const adapterEsm = await import(new URL('../dist/mysql2.js', import.meta.url).href);
check('exports fromMysql2Connection', typeof adapterEsm.fromMysql2Connection === 'function');
check('exports fromMysql2Pool', typeof adapterEsm.fromMysql2Pool === 'function');
check('exports connectMysql2', typeof adapterEsm.connectMysql2 === 'function');

const adapterCjs = require(join(root, 'dist/mysql2.cjs'));
check('CJS exports fromMysql2Connection', typeof adapterCjs.fromMysql2Connection === 'function');

section('behaviour without a database');
const statements = esm.parseSqlStatements(
  'DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END ;;\nDELIMITER ;\nSELECT 2;',
);
check('DELIMITER is consumed, not executed', statements.length === 2);
check(
  'a stored program body stays in one statement',
  statements[0].sql === 'CREATE PROCEDURE p() BEGIN SELECT 1; END',
);
check('the following statement is separate', statements[1].sql === 'SELECT 2');

check(
  'isMysqlDump recognizes native output',
  esm.isMysqlDump('-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)\n'),
);
check('quoteIdentifier escapes backticks', esm.quoteIdentifier('we`ird') === '`we``ird`');
check('quoteMysqlString escapes quotes', esm.quoteMysqlString("it's") === "'it\\'s'");

section('archive planning without a connection');
const archive = esm.inspectDumpArchive({
  databaseName: 'db',
  characterSetName: 'utf8mb4',
  collationName: 'utf8mb4_0900_ai_ci',
  defaultEncryption: null,
  tables: [],
  views: [],
  indexes: [],
  foreignKeys: [],
  checkConstraints: [],
  routines: [],
  triggers: [],
  events: [],
});
check(
  'an empty database plans to an empty, valid archive',
  archive.valid && archive.entries.length === 0,
);

section('core loads without the optional mysql2 peer dependency');
{
  // Resolution of `mysql2` is deliberately broken, then the core entry point is
  // loaded from scratch in a child process. This is the one check that proves
  // the optional peer dependency boundary holds in the *built* artifact rather
  // than only in `src/`.
  const { execFileSync } = await import('node:child_process');
  const probe = `
    const Module = require('module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'mysql2' || request.startsWith('mysql2/')) {
        throw new Error('mysql2 is not installed (simulated)');
      }
      return originalResolve.call(this, request, ...rest);
    };
    const api = require(${JSON.stringify(join(root, 'dist/index.cjs'))});
    if (typeof api.dumpMysql !== 'function' || typeof api.restoreSqlDump !== 'function') {
      throw new Error('core entry point is incomplete');
    }
    process.stdout.write('ok');
  `;
  let loaded = false;
  try {
    loaded = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim() === 'ok';
  } catch (error) {
    console.error(`  (child failed: ${String(error.message).slice(0, 200)})`);
  }
  check('dist/index.cjs loads with mysql2 unresolvable', loaded);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('All smoke checks passed.');
