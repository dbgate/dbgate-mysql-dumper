# Supported objects

"Round-trip tested" means the object survives dump → restore and the restored
database's introspected model deep-compares equal to the source, on **MySQL 5.7,
8.0, 8.4 and MariaDB 10.6, 10.11, 11.4**, across all four paths of the
interoperability matrix.

## Object matrix

| Object                                 | Dumped | Restored |      Round-trip tested      | Notes                                                                  |
| -------------------------------------- | :----: | :------: | :-------------------------: | ---------------------------------------------------------------------- |
| Database charset / collation           |   ✅   |    ✅    |             ✅              | `CREATE DATABASE` only with `includeCreateDatabase`.                   |
| Table (`CREATE TABLE`)                 |   ✅   |    ✅    |             ✅              | Verbatim `SHOW CREATE TABLE`, so every clause survives.                |
| Columns, defaults, comments            |   ✅   |    ✅    |             ✅              | Inline in the table DDL.                                               |
| Generated columns (`VIRTUAL`/`STORED`) |   ✅   |    ✅    |             ✅              | Excluded from `INSERT` and recomputed on restore.                      |
| `INVISIBLE` columns (8.0.23+)          |   ✅   |    ✅    |             ✅              | Named explicitly in `INSERT`, since `SELECT *` skips them.             |
| `AUTO_INCREMENT` value                 |   ✅   |    ✅    |             ✅              | Including values past 2^53; see below.                                 |
| Primary key                            |   ✅   |    ✅    |             ✅              | An index in MySQL, inline in the DDL.                                  |
| Unique keys / constraints              |   ✅   |    ✅    |             ✅              | Also indexes in MySQL.                                                 |
| Secondary indexes                      |   ✅   |    ✅    |             ✅              | Composite, prefixed, descending (8.0+), functional (8.0.13+).          |
| Invisible indexes (8.0+)               |   ✅   |    ✅    |             ✅              |                                                                        |
| `FULLTEXT` / `SPATIAL` indexes         |   ✅   |    ✅    | ⚠️ modelled, not in fixture | Carried in the table DDL.                                              |
| Foreign keys                           |   ✅   |    ✅    |             ✅              | Composite and **circular** both covered.                               |
| `CHECK` constraints (8.0.16+)          |   ✅   |    ✅    |             ✅              | Including `NOT ENFORCED`.                                              |
| Table engine, row format, options      |   ✅   |    ✅    |             ✅              | InnoDB and MyISAM both in the fixture.                                 |
| Per-column charset / collation         |   ✅   |    ✅    |             ✅              | `latin1` and `ascii` columns in a `utf8mb4` table.                     |
| Views                                  |   ✅   |    ✅    |             ✅              | Stub + final definition, as `mysqldump` does.                          |
| Dependent / nested views               |   ✅   |    ✅    |             ✅              | Fixture has one sorting _before_ its dependency.                       |
| Triggers                               |   ✅   |    ✅    |             ✅              | Multi-statement bodies; emitted after their table's data.              |
| Stored procedures                      |   ✅   |    ✅    |             ✅              | Bodies containing `;`, `--` and quoted text.                           |
| Stored functions                       |   ✅   |    ✅    |             ✅              | Characteristics preserved.                                             |
| Events                                 |   ✅   |    ✅    |             ✅              | Schedule, status, `ON COMPLETION`, creation time zone.                 |
| `DEFINER` clauses                      |   ✅   |    ✅    |             ✅              | Policy-controlled; see [restore-api.md](restore-api.md#definerpolicy). |
| `SQL SECURITY` mode                    |   ✅   |    ✅    |             ✅              | Part of the object DDL.                                                |
| Per-object creation context            |   ✅   |    ✅    |             ✅              | `character_set_client`, `collation_connection`, `sql_mode`.            |
| Partitioned tables                     |   ✅   |    ✅    | ⚠️ modelled, not in fixture | Carried verbatim in the table DDL.                                     |
| Temporary tables                       |   ❌   |    —     |              —              | Session-scoped; not visible in `information_schema`.                   |
| Users, roles, grants                   |   ❌   |    —     |              —              | Server-wide. See [known-limitations.md](known-limitations.md).         |
| Tablespaces                            |   ❌   |    —     |              —              | Server-wide, host file paths.                                          |
| Replication / GTID state               |   ❌   |    —     |              —              | Deliberately not emitted.                                              |
| Plugins, native UDFs                   |   ❌   |    —     |              —              | Depend on host shared libraries.                                       |

Everything in the ❌ block is reported by `unsupportedFeatureDiagnostics()` with
an explanation, so a UI can list exactly what a restore will not bring across
without hardcoding the list.

MariaDB sequences are detected but not emitted. Each produces a structured
`mariadb-sequence-not-dumped` warning and can be recreated separately from
`SHOW CREATE SEQUENCE`. MariaDB-specific table syntax is carried by canonical
`SHOW CREATE TABLE` output; functional/invisible-index catalog capabilities are
gated separately from descending indexes.

## Model coverage

`introspectMysql` returns a normalized `MysqlDatabase`:

```ts
{
  databaseName, characterSetName, collationName, defaultEncryption,
  tables:           MysqlTable[],       // engine, autoIncrement, collation, comment, createSql, columns
  views:            MysqlView[],        // definition, createSql, definer, securityType, checkOption,
                                        // algorithm, columnNames, creationContext
  indexes:          MysqlIndex[],       // isPrimary, isUnique, indexType, isVisible, key parts
  foreignKeys:      MysqlForeignKey[],  // referenced table, update/delete action, column pairs
  checkConstraints: MysqlCheckConstraint[],
  routines:         MysqlRoutine[],     // kind, deterministic, dataAccess, returnType, creationContext
  triggers:         MysqlTrigger[],     // timing, event, actionOrder, actionStatement, creationContext
  events:           MysqlEvent[],       // schedule, status, onCompletion, timeZone, creationContext
}
```

Per column: `dataType`, `columnType` (the full declared type, so `tinyint(1)` is
distinguishable from `tinyint` and unsigned from signed), nullability,
`defaultValue` with `isDefaultExpression`, `isAutoIncrement`, `generation` and
`generationExpression`, `isInvisible`, `onUpdate`, charset and collation,
precision, scale, datetime precision, `srsId`, and the comment.

There is deliberately **no** separate collection for primary keys or unique
constraints: in MySQL both _are_ indexes, and modelling them twice would invent a
distinction the server does not make.

## Notable behaviours

### `AUTO_INCREMENT`

The next value is carried in the table DDL, read as **text**, and preserved
exactly. `TABLES.AUTO_INCREMENT` for a `BIGINT UNSIGNED` key can legitimately
exceed `Number.MAX_SAFE_INTEGER`; routing it through a JavaScript number would
make the restored table resume generating keys at a _different_ value.

Covered by tests for gaps, empty tables (`AUTO_INCREMENT=4242` with no rows),
values past 2^53 (`9007199254740995`), explicitly inserted ids, and the next
generated id after restore.

An explicit `0` in an `AUTO_INCREMENT` column also round-trips, because the dump
header sets `SQL_MODE='NO_AUTO_VALUE_ON_ZERO'`.

### Generated columns

Never inserted — MySQL derives them, and rejects an explicit value. Their
presence forces the explicit-column-list `INSERT` form, exactly as in
`mysqldump`, and a `generated-column-not-exported` diagnostic states that the
value is recomputed rather than copied.

### Views

Two entries per view: a **stub** in the `main` section and the **real
definition** in the `views` section. The stub is what lets views be created in
plain name order even when one depends on another that sorts after it. See
[native-compatibility.md](native-compatibility.md#stub-views).

### Triggers

Emitted immediately after their table's **data**, not with its structure. A
trigger created before the load would fire once per inserted row — a large
slowdown and a correctness hazard, since an `AFTER INSERT` trigger writing to an
audit table would fabricate rows the source never had. The archive records that
as a _hard_ dependency.

A trigger whose table is not selected is dropped and reported, rather than
emitted against a table that will not exist.

### Routines and events

Bodies come from `SHOW CREATE`, wrapped in a `DELIMITER ;;` region.
`SHOW CREATE PROCEDURE` returns an _empty_ body — not an error — when the caller
lacks the privilege to see it; that is reported as
`routine-definition-unavailable` and the routine is skipped, keeping the rest of
the dump valid instead of emitting an empty `CREATE`.

Events additionally carry the session `time_zone` they were created under, since
`STARTS '2030-01-01 00:00:00'` means a different instant in a different zone.
The whole events section is wrapped in a zone save/restore pair.

### Nontransactional tables

A MyISAM/MEMORY/CSV/ARCHIVE table does not take part in an InnoDB consistent
snapshot. Under the default `consistency: 'single-transaction'` its rows are read
outside any snapshot, and a
`nontransactional-table-not-snapshot-consistent` warning is reported **per such
table**. Use `consistency: 'lock-all-tables'` if such a table must be consistent
with the rest.
