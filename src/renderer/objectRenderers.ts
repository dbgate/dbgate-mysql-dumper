import type { MysqlDatabase } from '../model/database.js';
import type { MysqlEvent, MysqlRoutine, MysqlTrigger, MysqlView } from '../model/programmable.js';
import type { MysqlTable } from '../model/table.js';
import { quoteIdentifier } from '../security/identifiers.js';
import { quoteMysqlString } from '../security/literals.js';
import { applyDefinerPolicy } from './definer.js';
import { toPortableSqlMode } from './sqlMode.js';
import type { ResolvedPlainSqlRenderOptions } from './types.js';
import {
  GATE_ALTER_TABLE_KEYS,
  GATE_CHARSET_AND_SQL_MODE,
  GATE_CREATE_DATABASE_IF_NOT_EXISTS,
  GATE_DATABASE_DEFAULT_CHARSET,
  GATE_DATABASE_ENCRYPTION,
  GATE_EVENTS,
  GATE_EVENT_DEFINER,
  GATE_STORED_PROGRAMS,
  GATE_TRIGGER_DEFINER,
  GATE_UTF8MB4,
  GATE_VIEWS,
  GATE_VIEW_DEFINER,
  executableComment,
  executableCommentTight,
} from './versionGates.js';

/**
 * A `--`-delimited section banner in `mysqldump`'s exact shape: a blank
 * line, a bare `--`, the title, another bare `--`.
 *
 * `trailingBlank` reproduces a real inconsistency in `mysqldump`'s own
 * output rather than smoothing it over: the per-object banners
 * ("Table structure for table", "Dumping data for table", the two view
 * banners, "Current Database") are followed by a blank line, while the two
 * per-database group banners ("Dumping events for database",
 * "Dumping routines for database") are not. Normalizing it would make a
 * structural diff against native output report noise on every dump.
 */
export function sectionComment(title: string, trailingBlank = true): string[] {
  const lines = ['', '--', `-- ${title}`, '--'];
  if (trailingBlank) {
    lines.push('');
  }
  return lines;
}

/**
 * The version gate for a `SET NAMES`/`SET character_set_client` naming
 * `characterSet`.
 *
 * `utf8mb4` did not exist before MySQL 5.5.3, so a `SET NAMES utf8mb4` gated
 * at 4.1.1 would be a syntax error on a 5.0 server that dutifully executed
 * it. `mysqldump` gates it at 5.5.3 for that charset and at 4.1.1 for the
 * ones that predate it, and this reproduces the distinction.
 *
 * Note this applies only where the charset statement stands on its own — the
 * header's `SET NAMES`, the table-structure guard, the view stub. Inside a
 * stored-program or view block the same statement is gated at the *block's*
 * version (5.0.3 / 5.0.1) instead, because a server that skips the block
 * must skip its guards too, or it would leave `character_set_client`
 * reassigned with no matching restore.
 */
export function charsetGate(characterSet: string): number {
  return characterSet.toLowerCase().startsWith('utf8mb4')
    ? GATE_UTF8MB4
    : GATE_CHARSET_AND_SQL_MODE;
}

/**
 * The `character_set_client` guard `mysqldump` wraps every `CREATE TABLE`
 * in.
 *
 * A `CREATE TABLE` can contain string literals — a column `DEFAULT`, an
 * `ENUM`/`SET` value list, a `COMMENT` — and MySQL interprets those using
 * the session's `character_set_client` at parse time. Pinning it around the
 * statement is what keeps a `DEFAULT 'café'` from changing meaning when
 * restored on a server whose client charset differs.
 */
function tableCharsetGuardOpen(options: ResolvedPlainSqlRenderOptions): string[] {
  return [
    `${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET @saved_cs_client     = @@character_set_client')};`,
    `${executableComment(charsetGate(options.characterSet), `SET character_set_client = ${options.characterSet}`)};`,
  ];
}

function tableCharsetGuardClose(): string[] {
  return [
    `${executableComment(GATE_CHARSET_AND_SQL_MODE, 'SET character_set_client = @saved_cs_client')};`,
  ];
}

/**
 * Converts `information_schema.SCHEMATA.DEFAULT_ENCRYPTION` into the form
 * `CREATE DATABASE ... DEFAULT ENCRYPTION` accepts.
 *
 * The catalog reports `'YES'`/`'NO'`, but the DDL clause takes only `'Y'` or
 * `'N'` — feeding the catalog value straight back makes MySQL reject the
 * whole statement with `ER_WRONG_VALUE_FOR_VAR` (1525,
 * *"Incorrect argument (should be Y or N) value: 'NO'"*), so a dump with
 * `includeCreateDatabase` would not restore at all. `mysqldump` emits `'N'`,
 * and this reproduces that.
 *
 * Anything already in the short form is passed through, and an unrecognized
 * value yields `null` so the clause is omitted rather than emitted wrong: a
 * database restored without the clause simply inherits the server default,
 * which is recoverable, whereas an invalid clause is not.
 */
function normalizeDefaultEncryption(value: string | null): string | null {
  const normalized = (value ?? '').trim().toUpperCase();
  if (normalized === 'Y' || normalized === 'YES') return 'Y';
  if (normalized === 'N' || normalized === 'NO') return 'N';
  return null;
}

/** The `-- Current Database:` block, plus `CREATE DATABASE` / `USE`. */
export function renderDatabase(
  database: MysqlDatabase,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const name = quoteIdentifier(database.databaseName);
  const lines = sectionComment(`Current Database: ${name}`);

  if (options.includeCreateDatabase) {
    const attributes: string[] = [];
    if (database.characterSetName) {
      const charsetClause = database.collationName
        ? `DEFAULT CHARACTER SET ${database.characterSetName} COLLATE ${database.collationName}`
        : `DEFAULT CHARACTER SET ${database.characterSetName}`;
      attributes.push(executableComment(GATE_DATABASE_DEFAULT_CHARSET, charsetClause));
    }
    const encryption = normalizeDefaultEncryption(database.defaultEncryption);
    if (encryption) {
      attributes.push(
        executableComment(
          GATE_DATABASE_ENCRYPTION,
          `DEFAULT ENCRYPTION=${quoteMysqlString(encryption)}`,
        ),
      );
    }
    const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
    lines.push(
      `CREATE DATABASE ${executableCommentTight(GATE_CREATE_DATABASE_IF_NOT_EXISTS, 'IF NOT EXISTS')} ${name}${suffix};`,
      '',
    );
  }

  if (options.includeUseDatabase) {
    lines.push(`USE ${name};`, '');
  }

  return lines;
}

/** The `-- Table structure for table` block: banner, `DROP TABLE`, charset guard, `CREATE TABLE`. */
export function renderTableStructure(
  table: MysqlTable,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const name = quoteIdentifier(table.pureName);
  const lines = sectionComment(`Table structure for table ${name}`);

  if (options.addDropTable) {
    lines.push(`DROP TABLE IF EXISTS ${name};`);
  }
  lines.push(...tableCharsetGuardOpen(options));
  // The server's own `SHOW CREATE TABLE` text, verbatim and unterminated —
  // MySQL never terminates it, so the `;` is this package's to add.
  lines.push(`${table.createSql};`);
  lines.push(...tableCharsetGuardClose());
  return lines;
}

/** The `-- Dumping data for table` banner. */
export function renderTableDataHeader(table: MysqlTable): string[] {
  return sectionComment(`Dumping data for table ${quoteIdentifier(table.pureName)}`);
}

/** Statements opening a table's data block: `LOCK TABLES` and `DISABLE KEYS`. */
export function renderTableDataOpen(
  table: MysqlTable,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const name = quoteIdentifier(table.pureName);
  const lines: string[] = [];
  if (options.addLocks) {
    lines.push(`LOCK TABLES ${name} WRITE;`);
  }
  if (options.disableKeys) {
    lines.push(`${executableComment(GATE_ALTER_TABLE_KEYS, `ALTER TABLE ${name} DISABLE KEYS`)};`);
  }
  return lines;
}

/** Statements closing a table's data block: `ENABLE KEYS` and `UNLOCK TABLES`. */
export function renderTableDataClose(
  table: MysqlTable,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const name = quoteIdentifier(table.pureName);
  const lines: string[] = [];
  if (options.disableKeys) {
    lines.push(`${executableComment(GATE_ALTER_TABLE_KEYS, `ALTER TABLE ${name} ENABLE KEYS`)};`);
  }
  if (options.addLocks) {
    lines.push('UNLOCK TABLES;');
  }
  return lines;
}

/**
 * The stub ("temporary") view definition.
 *
 * A placeholder view with the right column names, created before any real
 * view definition exists. Every real definition emitted later can then
 * reference any other view — including one that sorts after it — because
 * something with the correct column list is already there. This is what
 * removes the need to topologically sort views, and reproducing it is
 * required for a dump to be structurally native.
 *
 * The literal `1 AS` column list, the trailing space after `SELECT`, and the
 * *un-gated* `SET @saved_cs_client` lines all match `mysqldump` exactly.
 */
export function renderViewStub(view: MysqlView, options: ResolvedPlainSqlRenderOptions): string[] {
  const name = quoteIdentifier(view.pureName);
  const lines = sectionComment(`Temporary view structure for view ${name}`);

  if (options.addDropTable) {
    // Both, because the placeholder may survive from an interrupted earlier
    // restore as either a real table or a view.
    lines.push(`DROP TABLE IF EXISTS ${name};`);
    lines.push(`${executableCommentTight(GATE_VIEWS, `DROP VIEW IF EXISTS ${name}`)};`);
  }

  lines.push('SET @saved_cs_client     = @@character_set_client;');
  lines.push(
    `${executableComment(charsetGate(options.characterSet), `SET character_set_client = ${options.characterSet}`)};`,
  );

  const columnList =
    view.columnNames.length > 0
      ? view.columnNames.map(columnName => ` 1 AS ${quoteIdentifier(columnName)}`).join(',\n')
      : ' 1';
  lines.push(
    `${executableCommentTight(GATE_VIEWS, `CREATE VIEW ${name} AS SELECT \n${columnList}`)};`,
  );
  lines.push('SET character_set_client = @saved_cs_client;');
  return lines;
}

/**
 * The real ("final") view definition.
 *
 * `mysqldump` splits the statement across three separately gated executable
 * comments — `CREATE ALGORITHM=...`, then `DEFINER=... SQL SECURITY ...`,
 * then `VIEW ... AS ...` — so that a server too old for `DEFINER` on views
 * (before 5.0.13) skips only that fragment and still creates the view. The
 * split is reproduced for the same reason.
 */
export function renderView(view: MysqlView, options: ResolvedPlainSqlRenderOptions): string[] {
  const name = quoteIdentifier(view.pureName);
  const lines = sectionComment(`Final view structure for view ${name}`);

  if (options.addDropTable) {
    lines.push(`${executableCommentTight(GATE_VIEWS, `DROP VIEW IF EXISTS ${name}`)};`);
  }

  const characterSet = view.creationContext.characterSetClient ?? options.characterSet;
  lines.push(
    `${executableComment(GATE_VIEWS, 'SET @saved_cs_client          = @@character_set_client')};`,
    `${executableComment(GATE_VIEWS, 'SET @saved_cs_results         = @@character_set_results')};`,
    `${executableComment(GATE_VIEWS, 'SET @saved_col_connection     = @@collation_connection')};`,
    `${executableComment(GATE_VIEWS, `SET character_set_client      = ${characterSet}`)};`,
    `${executableComment(GATE_VIEWS, `SET character_set_results     = ${characterSet}`)};`,
  );
  if (view.creationContext.collationConnection) {
    lines.push(
      `${executableComment(GATE_VIEWS, `SET collation_connection      = ${view.creationContext.collationConnection}`)};`,
    );
  }

  lines.push(...splitViewCreate(view, options));

  lines.push(
    `${executableComment(GATE_VIEWS, 'SET character_set_client      = @saved_cs_client')};`,
    `${executableComment(GATE_VIEWS, 'SET character_set_results     = @saved_cs_results')};`,
    `${executableComment(GATE_VIEWS, 'SET collation_connection      = @saved_col_connection')};`,
  );
  return lines;
}

/**
 * Splits `SHOW CREATE VIEW` output into the three gated fragments described
 * on {@link renderView}.
 *
 * MySQL renders the statement in one fixed shape
 * (`CREATE ALGORITHM=x DEFINER=u@h SQL SECURITY y VIEW n AS ...`), so the
 * boundaries are found by locating the `DEFINER=` clause and the `VIEW`
 * keyword after the security clause. When the text does not match — a
 * definer stripped by policy, or a future server rendering it differently —
 * the whole statement is emitted as one gated fragment, which restores
 * identically on any server new enough to have views at all.
 */
function splitViewCreate(view: MysqlView, options: ResolvedPlainSqlRenderOptions): string[] {
  const createSql = applyDefinerPolicy(view.createSql, options.definerPolicy).trim();
  const match =
    /^(CREATE\b[\s\S]*?)(DEFINER\s*=\s*\S+(?:\s+SQL SECURITY\s+\w+)?)\s+(VIEW\b[\s\S]*)$/i.exec(
      createSql,
    );
  if (!match) {
    return [`${executableComment(GATE_VIEWS, createSql)};`];
  }
  return [
    executableComment(GATE_VIEWS, (match[1] as string).trim()),
    executableComment(GATE_VIEW_DEFINER, (match[2] as string).trim()),
    `${executableComment(GATE_VIEWS, (match[3] as string).trim())};`,
  ];
}

/**
 * The saved-session block `mysqldump` writes around every stored program
 * (trigger, routine, event).
 *
 * MySQL records the `character_set_client`, `collation_connection` and
 * `sql_mode` in force when a stored program was created, and re-establishes
 * them whenever it runs. Recreating the object under different settings
 * therefore changes its behaviour — or stops its body parsing at all, if it
 * was written under `ANSI_QUOTES` or `PIPES_AS_CONCAT`. Restoring the
 * recorded context around the `CREATE` is what makes a stored-program dump
 * faithful rather than approximate.
 *
 * `terminator` is `';'` normally and `';;'` inside a `DELIMITER ;;` region,
 * matching where `mysqldump` places each block.
 */
export function renderCreationContextOpen(
  context: {
    readonly characterSetClient: string | null;
    readonly collationConnection: string | null;
    readonly sqlMode: string | null;
  },
  options: ResolvedPlainSqlRenderOptions,
  terminator = ';',
): string[] {
  const characterSet = context.characterSetClient ?? options.characterSet;
  const lines = [
    executableComment(GATE_STORED_PROGRAMS, 'SET @saved_cs_client      = @@character_set_client'),
    executableComment(GATE_STORED_PROGRAMS, 'SET @saved_cs_results     = @@character_set_results'),
    executableComment(GATE_STORED_PROGRAMS, 'SET @saved_col_connection = @@collation_connection'),
    executableComment(GATE_STORED_PROGRAMS, `SET character_set_client  = ${characterSet}`),
    executableComment(GATE_STORED_PROGRAMS, `SET character_set_results = ${characterSet}`),
  ];
  if (context.collationConnection) {
    lines.push(
      executableComment(
        GATE_STORED_PROGRAMS,
        `SET collation_connection  = ${context.collationConnection}`,
      ),
    );
  }
  const { sqlMode } = toPortableSqlMode(context.sqlMode, options.sqlModeCompatibility);
  lines.push(
    executableComment(GATE_STORED_PROGRAMS, 'SET @saved_sql_mode       = @@sql_mode'),
    executableComment(
      GATE_STORED_PROGRAMS,
      `SET sql_mode              = ${quoteMysqlString(sqlMode)}`,
    ),
  );
  return lines.map(line => `${line} ${terminator}`);
}

export function renderCreationContextClose(terminator = ';'): string[] {
  return [
    executableComment(GATE_STORED_PROGRAMS, 'SET sql_mode              = @saved_sql_mode'),
    executableComment(GATE_STORED_PROGRAMS, 'SET character_set_client  = @saved_cs_client'),
    executableComment(GATE_STORED_PROGRAMS, 'SET character_set_results = @saved_cs_results'),
    executableComment(GATE_STORED_PROGRAMS, 'SET collation_connection  = @saved_col_connection'),
  ].map(line => `${line} ${terminator}`);
}

/**
 * A trigger, emitted immediately after its table's data.
 *
 * The body may contain any number of `;`-terminated statements, so the
 * `CREATE` is wrapped in a `DELIMITER ;;` region — the mechanism that makes
 * a multi-statement stored program survive a plain-SQL dump at all.
 */
export function renderTrigger(
  trigger: MysqlTrigger,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  return [
    ...renderCreationContextOpen(trigger.creationContext, options),
    'DELIMITER ;;',
    splitProgramCreate(
      trigger.createSql,
      'TRIGGER',
      GATE_STORED_PROGRAMS,
      GATE_TRIGGER_DEFINER,
      options,
      ';;',
    ),
    'DELIMITER ;',
    ...renderCreationContextClose(),
  ];
}

/**
 * A stored routine.
 *
 * Unlike triggers and events, `mysqldump` emits a routine's `CREATE`
 * *unwrapped* — no executable comment around it — because a server old
 * enough to lack stored routines could not parse the body anyway; only the
 * `DROP` is gated. This matches that.
 */
export function renderRoutine(
  routine: MysqlRoutine,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  const lines: string[] = [];
  if (options.addDropTable) {
    lines.push(
      `${executableComment(GATE_STORED_PROGRAMS, `DROP ${routine.kind} IF EXISTS ${quoteIdentifier(routine.pureName)}`)};`,
    );
  }
  lines.push(
    ...renderCreationContextOpen(routine.creationContext, options),
    'DELIMITER ;;',
    `${applyDefinerPolicy(routine.createSql, options.definerPolicy).trim()} ;;`,
    'DELIMITER ;',
    ...renderCreationContextClose(),
  );
  return lines;
}

/**
 * Saves the session time zone around the whole events section.
 *
 * An event's schedule is stored relative to the session time zone in force
 * when it was created — `STARTS '2030-01-01 00:00:00'` means a different
 * instant in a different zone — so each event's own block sets the recorded
 * zone. This outer pair returns the restoring session to where it started
 * once the section ends, and is emitted once per section, not once per
 * event, exactly as `mysqldump` does.
 */
export function renderEventsSectionOpen(): string[] {
  return [`${executableComment(GATE_EVENTS, 'SET @save_time_zone= @@TIME_ZONE')} ;`];
}

export function renderEventsSectionClose(): string[] {
  return [`${executableComment(GATE_EVENTS, 'SET TIME_ZONE= @save_time_zone')} ;`];
}

/** One event's `DROP` and gated `CREATE`, inside its own `DELIMITER ;;` region. */
export function renderEvent(event: MysqlEvent, options: ResolvedPlainSqlRenderOptions): string[] {
  const lines: string[] = [];
  if (options.addDropTable) {
    lines.push(
      `${executableComment(GATE_EVENTS, `DROP EVENT IF EXISTS ${quoteIdentifier(event.eventName)}`)};`,
    );
  }
  lines.push(
    'DELIMITER ;;',
    ...renderCreationContextOpen(event.creationContext, options, ';;'),
    `${executableComment(GATE_STORED_PROGRAMS, 'SET @saved_time_zone      = @@time_zone')} ;;`,
    `${executableComment(GATE_STORED_PROGRAMS, `SET time_zone             = ${quoteMysqlString(event.timeZone ?? 'SYSTEM')}`)} ;;`,
    splitProgramCreate(event.createSql, 'EVENT', GATE_EVENTS, GATE_EVENT_DEFINER, options, ' ;;'),
    `${executableComment(GATE_STORED_PROGRAMS, 'SET time_zone             = @saved_time_zone')} ;;`,
    ...renderCreationContextClose(';;'),
    'DELIMITER ;',
  );
  return lines;
}

/**
 * Splits a `SHOW CREATE TRIGGER`/`SHOW CREATE EVENT` statement into the
 * `CREATE` / `DEFINER=` / `<KEYWORD> ...` fragments `mysqldump` writes, each
 * separately gated so an older server skips only the definer clause.
 *
 * Falls back to one un-split fragment when the text does not match the
 * server's usual shape — for instance after `definerPolicy: 'strip'` has
 * removed the clause.
 */
function splitProgramCreate(
  createSql: string,
  keyword: 'TRIGGER' | 'EVENT',
  gate: number,
  definerGate: number,
  options: ResolvedPlainSqlRenderOptions,
  suffix: string,
): string {
  const sql = applyDefinerPolicy(createSql, options.definerPolicy).trim();
  const match = new RegExp(
    `^(CREATE)\\s+(DEFINER\\s*=\\s*\\S+)\\s+(${keyword}\\b[\\s\\S]*)$`,
    'i',
  ).exec(sql);
  if (!match) {
    return `${executableComment(gate, sql)}${suffix}`;
  }
  const head = `${executableCommentTight(gate, 'CREATE')} ${executableCommentTight(definerGate, (match[2] as string).trim())} `;
  return `${head}${executableComment(gate, (match[3] as string).trim())}${suffix}`;
}
