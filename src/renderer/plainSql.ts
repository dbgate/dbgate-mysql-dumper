import type { ArchiveEntry, DumpSection } from '../archive/types.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { MysqlEvent, MysqlRoutine, MysqlTrigger, MysqlView } from '../model/programmable.js';
import type { MysqlTable } from '../model/table.js';
import { isAbortError, MysqlDumperError, throwIfAborted } from '../utils/errors.js';
import { hasDefinerClause } from './definer.js';
import {
  renderDatabase,
  renderEvent,
  renderEventsSectionClose,
  renderEventsSectionOpen,
  renderRoutine,
  renderTableDataClose,
  renderTableDataHeader,
  renderTableDataOpen,
  renderTableStructure,
  renderTrigger,
  renderView,
  renderViewStub,
  sectionComment,
} from './objectRenderers.js';
import { footerGuardLines, formatDumpTimestamp, headerGuardLines } from './sessionGuards.js';
import { resolvePlainSqlRenderOptions } from './types.js';
import type {
  PlainSqlRenderRequest,
  PlainSqlRenderResult,
  ResolvedPlainSqlRenderOptions,
} from './types.js';

/**
 * The dump-format version `mysqldump` stamps on its output.
 *
 * This is the *format* revision, not a product version, and it has read
 * `10.13` since MySQL 5.5. Emitting it is a factual claim about the shape of
 * the file — which this package does produce — and it is what tooling sniffs
 * for when deciding whether a `.sql` file is a MySQL dump. The `Distrib`
 * half of the same line names this package honestly, so nothing here
 * impersonates `mysqldump` itself.
 */
const DUMP_FORMAT_VERSION = '10.13';

/** Package name written into the header's `Distrib` field. */
const PRODUCT_LABEL = 'dbgate-mysql-dumper';

/**
 * Renders a validated {@link DumpArchiveInspection} as plain SQL in
 * `mysqldump`'s own layout.
 *
 * Purely a function of the static model and the archive plan: it never
 * queries the database, which is why row data has to arrive through the
 * `onTableData` hook (see `exportTableDataAsInserts` for the streaming
 * implementation `dumpMysql` supplies).
 */
export async function renderPlainSql(
  request: PlainSqlRenderRequest,
): Promise<PlainSqlRenderResult> {
  const options = resolvePlainSqlRenderOptions(request.options);
  const { database, archive, writer, signal, onProgress, onTableData } = request;

  if (!archive.valid) {
    throw new MysqlDumperError(
      'invalid-archive',
      'Cannot render an archive inspection that failed validation; see archive.diagnostics, archive.cycles and archive.unsatisfiedDependencies',
    );
  }

  const warnings: MysqlDiagnostic[] = [];
  const renderedDumpIds: string[] = [];
  const skippedDumpIds: string[] = [];

  const tables = new Map(database.tables.map(table => [table.pureName, table]));
  const views = new Map(database.views.map(view => [view.pureName, view]));
  const routines = new Map(database.routines.map(routine => [routine.pureName, routine]));
  const triggers = new Map(database.triggers.map(trigger => [trigger.triggerName, trigger]));
  const events = new Map(database.events.map(event => [event.eventName, event]));

  const emit = async (lines: readonly string[]): Promise<void> => {
    if (lines.length === 0) {
      return;
    }
    await writer.write(lines.join(options.lineEnding) + options.lineEnding, signal);
  };

  if (!options.includeSessionGuards) {
    warnings.push({
      severity: 'warning',
      code: 'session-guards-disabled',
      message:
        'render.includeSessionGuards is false, so the dump omits SQL_MODE, FOREIGN_KEY_CHECKS, UNIQUE_CHECKS and TIME_ZONE guards. String literals in this dump use backslash escapes, which a restoring session with NO_BACKSLASH_ESCAPES will misread; tables referencing each other may fail to restore in the emitted order; and TIMESTAMP values will shift if the restoring session is in a different time zone than the dump.',
    });
  }

  try {
    await emit(headerLines(request, options));
    await emit(headerGuardLines(options));

    if (database.characterSetName && !matchesCharset(database, options)) {
      warnings.push({
        severity: 'info',
        code: 'dump-charset-differs-from-database',
        message: `The dump is written with SET NAMES ${options.characterSet} while database "${database.databaseName}" defaults to ${database.characterSetName}. Values are converted losslessly as long as ${options.characterSet} can represent them, which utf8mb4 always can; set render.characterSet to change it.`,
      });
    }

    let processed = 0;
    const total = archive.entries.length;
    const flushSectionBanners = createSectionBannerFlusher(request, emit);

    for (const entry of archive.entries) {
      throwIfAborted(signal);
      processed++;
      onProgress?.({
        phase: 'rendering-schema',
        objectsProcessed: processed,
        objectsTotal: total,
        objectName: entry.name,
        databaseName: entry.databaseName,
        bytesWritten: writer.bytesWritten,
      });

      // `mysqldump` prints a section's banner because the switch was given,
      // not because the section has content, so banners are flushed at section
      // boundaries rather than by the first object in them.
      await flushSectionBanners(entry.section);

      const handled = await renderEntry(entry, {
        options,
        emit,
        database,
        tables,
        views,
        routines,
        triggers,
        events,
        warnings,
        onTableData,
        onProgress,
        writerBytes: () => writer.bytesWritten,
      });

      if (handled) {
        renderedDumpIds.push(entry.dumpId);
      } else {
        skippedDumpIds.push(entry.dumpId);
      }
    }

    // A database with no events and no routines still gets both banners.
    await flushSectionBanners(null);

    await emit(footerGuardLines(options));
    if (options.includeFooterComment) {
      await emit([
        '',
        options.includeTimestamp
          ? `-- Dump completed on ${formatDumpTimestamp(new Date())}`
          : '-- Dump completed',
      ]);
    }

    return {
      bytesWritten: writer.bytesWritten,
      renderedDumpIds,
      skippedDumpIds,
      warnings,
      cancelled: false,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        bytesWritten: writer.bytesWritten,
        renderedDumpIds,
        skippedDumpIds,
        warnings,
        cancelled: true,
      };
    }
    throw error;
  }
}

interface RenderContext {
  readonly options: ResolvedPlainSqlRenderOptions;
  emit(lines: readonly string[]): Promise<void>;
  readonly database: PlainSqlRenderRequest['database'];
  readonly tables: ReadonlyMap<string, MysqlTable>;
  readonly views: ReadonlyMap<string, MysqlView>;
  readonly routines: ReadonlyMap<string, MysqlRoutine>;
  readonly triggers: ReadonlyMap<string, MysqlTrigger>;
  readonly events: ReadonlyMap<string, MysqlEvent>;
  readonly warnings: MysqlDiagnostic[];
  readonly onTableData: PlainSqlRenderRequest['onTableData'];
  readonly onProgress: PlainSqlRenderRequest['onProgress'];
  writerBytes(): number;
}

async function renderEntry(entry: ArchiveEntry, context: RenderContext): Promise<boolean> {
  const { options, emit, warnings } = context;

  switch (entry.objectType) {
    case 'database': {
      await emit(renderDatabase(context.database, options));
      return true;
    }

    case 'table': {
      const table = context.tables.get(entry.name);
      if (!table) return missing(entry, 'table', warnings, options);
      if (table.createSql.trim() === '') {
        return unsupported(
          entry,
          `Table "${entry.name}" has no SHOW CREATE TABLE text; it cannot be rendered. Re-run introspection with includeCreateSql enabled.`,
          warnings,
          options,
        );
      }
      await emit(renderTableStructure(table, options));
      return true;
    }

    case 'tableData': {
      const table = context.tables.get(entry.name);
      if (!table) return missing(entry, 'table', warnings, options);

      // The banner and the LOCK/DISABLE KEYS frame are written even for an
      // empty table, because `mysqldump` writes them unconditionally — an
      // empty table's block is exactly this frame with nothing between.
      await emit(renderTableDataHeader(table));
      await emit(renderTableDataOpen(table, options));

      let wroteRows = false;
      if (context.onTableData) {
        wroteRows = await context.onTableData(entry);
      }
      if (!context.onTableData) {
        warnings.push({
          severity: 'warning',
          code: 'data-not-rendered',
          message: `Row data for table "${entry.name}" was selected, but renderPlainSql only renders schema objects; use dumpMysql (or supply onTableData) with a live connection to stream rows.`,
          objectReference: { kind: 'table', databaseName: entry.databaseName, name: entry.name },
        });
      }

      await emit(renderTableDataClose(table, options));
      return wroteRows || !context.onTableData;
    }

    case 'viewStub': {
      const view = context.views.get(entry.name);
      if (!view) return missing(entry, 'view', warnings, options);
      await emit(renderViewStub(view, options));
      return true;
    }

    case 'view': {
      const view = context.views.get(entry.name);
      if (!view) return missing(entry, 'view', warnings, options);
      if (view.createSql.trim() === '') {
        return unsupported(
          entry,
          `View "${entry.name}" has no SHOW CREATE VIEW text; it cannot be rendered.`,
          warnings,
          options,
        );
      }
      reportDefiner(view.createSql, entry, 'view', context);
      await emit(renderView(view, options));
      return true;
    }

    case 'trigger': {
      const trigger = context.triggers.get(entry.name);
      if (!trigger) return missing(entry, 'trigger', warnings, options);
      if (trigger.createSql.trim() === '') {
        return unsupported(
          entry,
          `Trigger "${entry.name}" has no SHOW CREATE TRIGGER text; it cannot be rendered.`,
          warnings,
          options,
        );
      }
      reportDefiner(trigger.createSql, entry, 'trigger', context);
      await emit(renderTrigger(trigger, options));
      return true;
    }

    case 'function':
    case 'procedure': {
      const routine = context.routines.get(entry.name);
      if (!routine) return missing(entry, entry.objectType, warnings, options);
      if (routine.createSql.trim() === '') {
        // Already reported as `routine-definition-unavailable` during
        // introspection (the usual cause is a missing privilege); skipping
        // here keeps the rest of the dump valid instead of emitting an
        // empty CREATE.
        return false;
      }
      reportDefiner(routine.createSql, entry, entry.objectType, context);
      await emit(renderRoutine(routine, options));
      return true;
    }

    case 'event': {
      const event = context.events.get(entry.name);
      if (!event) return missing(entry, 'event', warnings, options);
      if (event.createSql.trim() === '') {
        return false;
      }
      // The banner is emitted by the section flusher; only the time-zone
      // wrapper is tied to an event actually being present, exactly as
      // `mysqldump` does — an empty events section has the banner and nothing
      // else.
      if (isFirstEvent(entry, context)) {
        await emit(renderEventsSectionOpen());
      }
      reportDefiner(event.createSql, entry, 'event', context);
      await emit(renderEvent(event, options));
      if (isLastEvent(entry, context)) {
        await emit(renderEventsSectionClose());
      }
      return true;
    }

    default: {
      const unreachable: never = entry.objectType;
      throw new MysqlDumperError(
        'unsupported-object',
        `Unhandled archive object type: ${String(unreachable)}`,
      );
    }
  }
}

/**
 * Both routine and event sections carry one banner for the whole group, not
 * one per object. Rather than threading mutable "already emitted" state
 * through the renderer, the first member is identified by name: the archive
 * orders each group by name, so the alphabetically first selected routine
 * (function or procedure) is the one that owns the banner.
 */
function renderableEventNames(context: RenderContext): string[] {
  return [...context.events.values()]
    .filter(event => event.createSql.trim() !== '')
    .map(event => event.eventName)
    .sort();
}

function isFirstEvent(entry: ArchiveEntry, context: RenderContext): boolean {
  return renderableEventNames(context)[0] === entry.name;
}

/**
 * The last event owns the section's closing `SET TIME_ZONE=@save_time_zone`,
 * the partner of the save the first event emitted.
 */
function isLastEvent(entry: ArchiveEntry, context: RenderContext): boolean {
  const names = renderableEventNames(context);
  return names[names.length - 1] === entry.name;
}

function reportDefiner(
  createSql: string,
  entry: ArchiveEntry,
  kind: 'view' | 'trigger' | 'function' | 'procedure' | 'event',
  context: RenderContext,
): void {
  if (context.options.definerPolicy !== 'preserve' || !hasDefinerClause(createSql)) {
    return;
  }
  context.warnings.push({
    severity: 'info',
    code: 'definer-preserved',
    message: `The ${kind} "${entry.name}" carries a DEFINER clause, which is kept verbatim (render.definerPolicy is "preserve"). Restoring it requires the named account to exist on the target, and the SET_USER_ID or SUPER privilege when it is not the restoring account. Use definerPolicy "strip" or "current-user" for a portable dump.`,
    objectReference: { kind, databaseName: entry.databaseName, name: entry.name },
  });
}

function missing(
  entry: ArchiveEntry,
  kind: string,
  warnings: MysqlDiagnostic[],
  options: ResolvedPlainSqlRenderOptions,
): boolean {
  const message = `Archive entry references ${kind} "${entry.name}", which was not found in the introspected model`;
  if (options.unsupportedFeaturePolicy === 'warn-omit') {
    warnings.push({ severity: 'warning', code: 'model-object-missing', message });
    return false;
  }
  throw new MysqlDumperError('model-object-missing', message);
}

function unsupported(
  entry: ArchiveEntry,
  message: string,
  warnings: MysqlDiagnostic[],
  options: ResolvedPlainSqlRenderOptions,
): boolean {
  if (options.unsupportedFeaturePolicy === 'warn-omit') {
    warnings.push({
      severity: 'warning',
      code: 'unsupported-object',
      message,
      objectReference: { kind: 'table', databaseName: entry.databaseName, name: entry.name },
    });
    return false;
  }
  throw new MysqlDumperError('unsupported-object', message);
}

function matchesCharset(
  database: PlainSqlRenderRequest['database'],
  options: ResolvedPlainSqlRenderOptions,
): boolean {
  return (database.characterSetName ?? '').toLowerCase() === options.characterSet.toLowerCase();
}

/**
 * The leading comment block.
 *
 * Shape matches `mysqldump` exactly — the same five lines, the same
 * `-- ------...` rule, the same tab before the server version — because
 * tools that sniff a `.sql` file (this package's own `isMysqlDump` among
 * them) key on it. Nothing here is derived from connection settings, so no
 * host, user or password can leak into the file: `hostLabel` is a purely
 * cosmetic caller-supplied string.
 */
function headerLines(
  request: PlainSqlRenderRequest,
  options: ResolvedPlainSqlRenderOptions,
): string[] {
  if (!options.includeHeaderComments) {
    return [];
  }
  const version = request.sourceVersion;
  return [
    `-- MySQL dump ${DUMP_FORMAT_VERSION}  Distrib ${PRODUCT_LABEL}, for Node.js (${process.platform})`,
    '--',
    `-- Host: ${options.hostLabel}    Database: ${request.database.databaseName}`,
    '-- ------------------------------------------------------',
    `-- Server version\t${version ? version.versionString : 'unknown'}`,
    '',
  ];
}

/**
 * Section-banner rank, matching {@link DumpSection} order.
 *
 * A banner is flushed once an entry from its section — or any later section —
 * is reached, which is what makes an *empty* section still produce its banner
 * in the right place.
 */
const SECTION_RANK: Readonly<Record<DumpSection, number>> = {
  database: 0,
  main: 1,
  events: 2,
  routines: 3,
  views: 4,
};

/**
 * Builds a function that emits the `events` and `routines` section banners at
 * the right point, whether or not those sections have any content.
 *
 * `mysqldump` prints
 * `-- Dumping events for database 'x'` and
 * `-- Dumping routines for database 'x'` whenever `--events`/`--routines` were
 * given, even for a database with none of either, and omits them entirely
 * otherwise — verified against MySQL 8.0. Pass `null` to flush whatever is
 * still pending, which is what a dump whose last entry is a table needs.
 */
function createSectionBannerFlusher(
  request: PlainSqlRenderRequest,
  emit: (lines: readonly string[]) => Promise<void>,
): (section: DumpSection | null) => Promise<void> {
  const databaseName = request.database.databaseName;
  const pending: { rank: number; lines: readonly string[] }[] = [];

  if (request.includedKinds?.events ?? true) {
    pending.push({
      rank: SECTION_RANK.events as number,
      lines: sectionComment(`Dumping events for database '${databaseName}'`, false),
    });
  }
  if (request.includedKinds?.routines ?? true) {
    pending.push({
      rank: SECTION_RANK.routines as number,
      lines: sectionComment(`Dumping routines for database '${databaseName}'`, false),
    });
  }

  return async (section: DumpSection | null): Promise<void> => {
    const limit: number =
      section === null ? Number.POSITIVE_INFINITY : (SECTION_RANK[section] as number);
    while (pending.length > 0 && (pending[0] as { rank: number }).rank <= limit) {
      const banner = pending.shift() as { lines: readonly string[] };
      await emit(banner.lines);
    }
  };
}
