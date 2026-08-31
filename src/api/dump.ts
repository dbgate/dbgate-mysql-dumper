import type { Writable } from 'node:stream';
import { inspectDumpArchive } from '../archive/planner.js';
import type { ArchiveEntry } from '../archive/types.js';
import { acquireMysqlConnection } from '../connection/acquire.js';
import { beginMysqlDumpSession } from '../connection/session.js';
import type { MysqlConnection, MysqlConnectionInput, MysqlRow } from '../connection/types.js';
import { exportTableDataAsInserts } from '../data/insertExport.js';
import { introspectMysql } from '../introspection/introspect.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import { renderPlainSql } from '../renderer/plainSql.js';
import { normalizeDumpSelection } from '../selection/normalize.js';
import { isAbortError, MysqlDumperError } from '../utils/errors.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import { StreamDumpWriter } from '../writer/streamWriter.js';
import type { DumpMysqlOptions, DumpResult } from './types.js';

/**
 * The charset the read session is always pinned to.
 *
 * Row values are read as raw bytes and decoded as UTF-8, so the session's
 * `character_set_results` has to be a UTF-8 encoding or every non-ASCII
 * character is destroyed on the way out. Pinning it here — rather than
 * following `render.characterSet` — decouples "what encoding the file is in"
 * from "what encoding the wire is in", which are only accidentally the same
 * thing.
 */
const READ_SESSION_CHARACTER_SET = 'utf8mb4';

/**
 * Character sets the dump writer can honestly declare.
 *
 * The writer emits UTF-8 bytes. A dump that declares `SET NAMES latin1` while
 * containing UTF-8 bytes is doubly wrong — the server would decode every
 * multi-byte character as two latin1 characters — so rather than produce a
 * silently corrupt file, an unsupported charset is refused up front.
 *
 * Producing a genuinely latin1-encoded file would mean transcoding the whole
 * output stream, which is a real feature rather than a flag; it is listed in
 * `docs/known-limitations.md` instead of being half-implemented.
 */
const WRITABLE_CHARACTER_SETS: ReadonlySet<string> = new Set(['utf8mb4', 'utf8mb3', 'utf8']);

function assertWritableCharacterSet(characterSet: string | undefined): void {
  if (characterSet === undefined) {
    return;
  }
  if (!WRITABLE_CHARACTER_SETS.has(characterSet.toLowerCase())) {
    throw new MysqlDumperError(
      'unsupported-dump-charset',
      `render.characterSet ${JSON.stringify(characterSet)} is not supported by dumpMysql: the dump is written as UTF-8 bytes, so declaring another character set would produce a file whose SET NAMES contradicts its contents. Supported values: ${[...WRITABLE_CHARACTER_SETS].join(', ')}.`,
    );
  }
}

/**
 * Runs a complete MySQL dump: acquire one connection, pin the read session,
 * introspect, plan, render, and stream row data — writing plain SQL in
 * `mysqldump`'s own layout to `output`.
 *
 * Everything happens on **one** physical connection, and that is not an
 * implementation detail: the consistent snapshot, the pinned
 * `time_zone`/`sql_mode`/charset, and (in `lock-all-tables` mode) the read
 * lock are all session state. A pool handing out an arbitrary connection per
 * query would read each table under different conditions. When a pool is
 * passed, one connection is checked out for the whole dump and released
 * afterwards; a bare connection is borrowed and never closed.
 */
export async function dumpMysql(
  connectionInput: MysqlConnectionInput,
  options: DumpMysqlOptions,
  output: Writable,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult> {
  assertWritableCharacterSet(options.render?.characterSet);

  onProgress?.({ phase: 'connecting' });
  const acquired = await acquireMysqlConnection(connectionInput, signal);

  const session = await (async () => {
    onProgress?.({ phase: 'starting-snapshot' });
    try {
      return await beginMysqlDumpSession(
        acquired.connection,
        {
          ...(options.consistency === undefined ? {} : { consistency: options.consistency }),
          ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
          // Deliberately *not* `render.characterSet`: the read session is
          // always pinned to utf8mb4 so that raw byte reads decode correctly.
          // See `assertWritableCharacterSet`.
          characterSet: READ_SESSION_CHARACTER_SET,
        },
        signal,
      );
    } catch (error) {
      await acquired.release();
      throw error;
    }
  })();

  try {
    onProgress?.({ phase: 'introspecting' });
    const introspection = await introspectMysql(
      acquired.connection,
      {
        ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }),
        ...(options.selection === undefined ? {} : { selection: options.selection }),
      },
      signal,
    );
    onProgress?.({
      phase: 'detecting-version',
      message: introspection.version.versionString,
      databaseName: introspection.database.databaseName,
    });

    const mode = options.mode ?? 'full';
    const normalizedSelection = normalizeDumpSelection(options.selection, {
      caseInsensitiveTableNames: introspection.lowerCaseTableNames !== 0,
    });
    const archive = inspectDumpArchive(introspection.database, {
      mode,
      selection: normalizedSelection,
      ...(options.objectKinds === undefined ? {} : { objectKinds: options.objectKinds }),
      includeDatabaseEntry:
        (options.render?.includeCreateDatabase ?? false) ||
        (options.render?.includeUseDatabase ?? false),
    });
    onProgress?.({ phase: 'planning-archive', objectsTotal: archive.entries.length });

    if (!archive.valid) {
      throw new MysqlDumperError(
        'invalid-archive',
        'Archive planning failed; inspect the diagnostics, cycles and unsatisfiedDependencies returned by inspectDumpArchive for details',
      );
    }

    const writer = new StreamDumpWriter(output);
    const maxAllowedPacket = await readMaxAllowedPacket(acquired.connection, signal);
    const tablesByName = new Map(
      introspection.database.tables.map(table => [table.pureName, table]),
    );

    let rowsExported = 0;
    let statementsWritten = 0;
    const dataWarnings: MysqlDiagnostic[] = [];

    const onTableData = async (entry: ArchiveEntry): Promise<boolean> => {
      const table = tablesByName.get(entry.name);
      if (!table) {
        return false;
      }
      const result = await exportTableDataAsInserts({
        connection: acquired.connection,
        databaseName: introspection.database.databaseName,
        table,
        indexes: introspection.database.indexes,
        writer,
        ...(maxAllowedPacket === undefined ? {} : { maxAllowedPacket }),
        options: {
          ...options.dataExport,
          // The renderer's INSERT-shaping options and the exporter's are the
          // same knobs seen from two layers; `render` is the documented
          // place to set them, so it wins unless `dataExport` overrides.
          extendedInsert: options.dataExport?.extendedInsert ?? options.render?.extendedInsert,
          completeInsert: options.dataExport?.completeInsert ?? options.render?.completeInsert,
          hexBlob: options.dataExport?.hexBlob ?? options.render?.hexBlob,
        },
        ...(signal === undefined ? {} : { signal }),
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      rowsExported += result.rowsExported;
      statementsWritten += result.statementsWritten;
      dataWarnings.push(...result.warnings);
      return true;
    };

    const renderResult = await renderPlainSql({
      database: introspection.database,
      archive,
      writer,
      ...(options.render === undefined ? {} : { options: options.render }),
      ...(signal === undefined ? {} : { signal }),
      ...(onProgress === undefined ? {} : { onProgress }),
      sourceVersion: introspection.version,
      mode,
      // Drives the empty-section banners, which `mysqldump` emits because the
      // switch was given rather than because the section has content.
      includedKinds: {
        events: options.objectKinds?.includeEvents ?? true,
        routines: options.objectKinds?.includeRoutines ?? true,
      },
      onTableData,
    });

    onProgress?.({ phase: 'finalizing', bytesWritten: renderResult.bytesWritten });

    return {
      bytesWritten: renderResult.bytesWritten,
      renderedDumpIds: renderResult.renderedDumpIds,
      skippedDumpIds: renderResult.skippedDumpIds,
      warnings: [
        ...introspection.diagnostics,
        ...archive.diagnostics,
        ...renderResult.warnings,
        ...dataWarnings,
      ],
      cancelled: renderResult.cancelled,
      rowsExported,
      statementsWritten,
    };
  } finally {
    // Order matters: the session must be closed (transaction committed,
    // locks released, session variables restored) *before* the connection
    // goes back to a pool, or the next borrower inherits them.
    await session.finish();
    await acquired.release();
  }
}

/**
 * Reads the server's `max_allowed_packet` so generated statements stay
 * restorable.
 *
 * A statement larger than the target's `max_allowed_packet` is rejected with
 * `ER_NET_PACKET_TOO_LARGE`, and while the *target* may differ from the
 * source, the source's value is the only evidence available at dump time and
 * is the same default in practice. Failure to read it is not fatal — the
 * configured byte cap alone still bounds statements.
 *
 * Cancellation is the one failure that *is* propagated: swallowing it here
 * would let an aborted dump carry on to introspection and data export before
 * noticing, which defeats the point of the signal.
 */
async function readMaxAllowedPacket(
  connection: MysqlConnection,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const result = await connection.query<MysqlRow>(
      { sql: 'SELECT @@GLOBAL.max_allowed_packet AS value' },
      signal,
      'native',
    );
    const value = Number(result.rows[0]?.value);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return undefined;
  }
}
