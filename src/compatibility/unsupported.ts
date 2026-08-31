import type { MysqlDiagnostic } from '../model/diagnostics.js';

/**
 * Server-wide objects and state this package deliberately does not dump.
 *
 * Every one of these is either outside a single database's scope, requires
 * privileges a dump user should not need, or cannot be reproduced correctly
 * from a plain SQL file. Rather than silently omitting them — which would
 * make a dump look complete when it is not — each is described here so
 * `unsupportedFeatureDiagnostics()` can report them, and
 * `docs/known-limitations.md` can list them with the same wording.
 *
 * `mysqldump` covers some of these behind switches this package does not
 * implement; where that is so, the note names the switch, so a user who
 * needs it knows exactly what to reach for instead.
 */
export const UNSUPPORTED_FEATURES: readonly {
  readonly code: string;
  readonly summary: string;
  readonly detail: string;
}[] = [
  {
    code: 'users-and-grants-not-dumped',
    summary: 'users, roles and grants',
    detail:
      'Accounts live in the server-wide `mysql` system database, not in the dumped database, and recreating them needs privileges a dump user should not require. `mysqldump --all-databases` (or `mysqlpump --users`) covers them. This matters for DEFINER clauses: an object whose definer account does not exist on the target will not restore — see the definerPolicy option.',
  },
  {
    code: 'replication-state-not-dumped',
    summary: 'replication coordinates and GTID state',
    detail:
      '`mysqldump --source-data`/`--master-data` records the binary log file and position, and `--set-gtid-purged` records GTID state, so a dump can seed a replica. Neither is emitted here: both require RELOAD/REPLICATION CLIENT privileges and a locking strategy chosen for replication rather than for a consistent read, and a dump carrying a stale `SET @@GLOBAL.gtid_purged` is actively dangerous to restore.',
  },
  {
    code: 'tablespaces-not-dumped',
    summary: 'general tablespaces',
    detail:
      '`CREATE TABLESPACE` is server-wide and its data files are host paths, so a tablespace definition is not portable between servers. A table that names one restores only where that tablespace already exists; the `TABLESPACE` clause is preserved in the table DDL, but the tablespace itself is not created.',
  },
  {
    code: 'ndb-objects-not-dumped',
    summary: 'NDB Cluster-specific objects',
    detail:
      "NDB logfile groups, undo files and cluster-specific table attributes are not introspected. Dumping an NDB table produces its ordinary `CREATE TABLE`, which restores as the target server's default engine unless the target is also NDB.",
  },
  {
    code: 'plugins-and-udfs-not-dumped',
    summary: 'installed plugins and user-defined functions',
    detail:
      'Server plugins and native UDFs (`CREATE FUNCTION ... SONAME`) are registered server-wide and depend on shared libraries present on the host. A stored function written in SQL *is* dumped; a UDF backed by a shared library is not.',
  },
  {
    code: 'grants-on-objects-not-dumped',
    summary: 'privileges granted on dumped objects',
    detail:
      'A `GRANT SELECT ON db.t TO user` lives in the `mysql` system database alongside the account it names, and is not part of the dumped database. Restored objects are owned and accessible by whoever restores them.',
  },
];

/**
 * Returns one `info` diagnostic per server-wide feature this package does
 * not dump.
 *
 * Emitted as `info`, not `warning`: none of these is a defect in the dump,
 * and a warning per dump for something every dump has would be noise. They
 * exist so a caller building a UI can list exactly what a restore will not
 * bring across, without having to hardcode the list themselves.
 */
export function unsupportedFeatureDiagnostics(): MysqlDiagnostic[] {
  return UNSUPPORTED_FEATURES.map(feature => ({
    severity: 'info' as const,
    code: feature.code,
    message: `Not included in this dump: ${feature.summary}. ${feature.detail}`,
  }));
}
