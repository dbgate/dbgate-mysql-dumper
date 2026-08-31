import { acquireMysqlConnection } from '../connection/acquire.js';
import type { MysqlConnectionInput, MysqlRow } from '../connection/types.js';
import { checkTargetCompatibility } from '../compatibility/check.js';
import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import { detectSourceCapabilities } from '../version/capabilities.js';
import { detectMysqlVersion } from '../version/detect.js';
import type { MysqlVersion, SourceCapabilities } from '../version/types.js';

export interface RestorePreflightRequest {
  readonly connection: MysqlConnectionInput;
  /**
   * The source model, when available. Supplying it turns the report from
   * "what can this target do" into "what does this dump need that this
   * target cannot do", which is the question that actually predicts a
   * failed restore.
   */
  readonly database?: MysqlDatabase;
  readonly signal?: AbortSignal;
}

export interface RestorePreflightReport {
  readonly targetVersion: MysqlVersion;
  readonly targetCapabilities: SourceCapabilities;
  /**
   * The target's `max_allowed_packet`. A statement larger than this is
   * rejected outright, so a dump generated against a server with a larger
   * value may not restore here — which is worth knowing before starting.
   */
  readonly maxAllowedPacket?: number;
  /** The target's `sql_mode`, which a dump's header replaces for the duration of the restore. */
  readonly sqlMode?: string;
  /** `errors` block a restore; `warning`/`info` describe what will differ. */
  readonly diagnostics: readonly MysqlDiagnostic[];
}

/**
 * Inspects a restore target before any statement runs.
 *
 * The whole point is to turn a mid-restore failure into an up-front,
 * actionable report: a dump containing `CHECK` constraints aimed at MySQL
 * 5.7 fails thousands of statements in, with a syntax error that names a
 * line number rather than the reason.
 */
export async function preflightRestore(
  request: RestorePreflightRequest,
): Promise<RestorePreflightReport> {
  const acquired = await acquireMysqlConnection(request.connection, request.signal);
  try {
    const targetVersion = await detectMysqlVersion(acquired.connection, request.signal);
    const targetCapabilities = detectSourceCapabilities(targetVersion);
    const diagnostics: MysqlDiagnostic[] = [];

    if (targetVersion.flavor !== 'mysql') {
      diagnostics.push({
        severity: 'warning',
        code: 'unverified-server-flavor',
        message: `Restore target reports flavor "${targetVersion.flavor}" (${targetVersion.versionString}). This package's compatibility contract covers MySQL; see docs/known-limitations.md.`,
      });
    }

    const settings = await readSettings(acquired, request.signal);

    if (request.database) {
      diagnostics.push(...checkTargetCompatibility(request.database, targetCapabilities));
    }

    return {
      targetVersion,
      targetCapabilities,
      ...(settings.maxAllowedPacket === undefined
        ? {}
        : { maxAllowedPacket: settings.maxAllowedPacket }),
      ...(settings.sqlMode === undefined ? {} : { sqlMode: settings.sqlMode }),
      diagnostics,
    };
  } finally {
    await acquired.release();
  }
}

async function readSettings(
  acquired: Awaited<ReturnType<typeof acquireMysqlConnection>>,
  signal?: AbortSignal,
): Promise<{ maxAllowedPacket?: number; sqlMode?: string }> {
  try {
    const result = await acquired.connection.query<MysqlRow>(
      {
        sql: 'SELECT @@GLOBAL.max_allowed_packet AS maxAllowedPacket, @@SESSION.sql_mode AS sqlMode',
      },
      signal,
      'native',
    );
    const row = result.rows[0];
    const maxAllowedPacket = Number(row?.maxAllowedPacket);
    return {
      ...(Number.isFinite(maxAllowedPacket) && maxAllowedPacket > 0 ? { maxAllowedPacket } : {}),
      ...(row?.sqlMode === undefined || row.sqlMode === null
        ? {}
        : { sqlMode: String(row.sqlMode) }),
    };
  } catch {
    // Not fatal: a target that will not report its settings can still be
    // restored to, and every other check in this report still applies.
    return {};
  }
}
