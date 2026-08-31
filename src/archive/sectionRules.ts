import type { ArchiveObjectType, DumpSection } from './types.js';

const SECTION_BY_OBJECT_TYPE: Record<ArchiveObjectType, DumpSection> = {
  database: 'database',
  table: 'main',
  tableData: 'main',
  trigger: 'main',
  viewStub: 'main',
  event: 'events',
  function: 'routines',
  procedure: 'routines',
  view: 'views',
};

const SECTION_PRIORITY: Record<DumpSection, number> = {
  database: 0,
  main: 1,
  events: 2,
  routines: 3,
  views: 4,
};

/**
 * Ordering *within* one table/view's block in the `main` section.
 *
 * A table's structure, its data, and its triggers form one contiguous group
 * keyed by the table name, and this is the order inside that group. Triggers
 * come last for a reason `mysqldump` shares with `pg_dump`: a trigger
 * created before the data load would fire once per inserted row, which is
 * both a large slowdown and a correctness hazard (an `AFTER INSERT` trigger
 * writing to an audit table would fabricate rows the source never had).
 */
const MAIN_GROUP_PRIORITY: Record<ArchiveObjectType, number> = {
  database: 0,
  table: 0,
  tableData: 1,
  trigger: 2,
  // A view's stub is the whole of its group; it has no data or triggers.
  viewStub: 0,
  event: 0,
  function: 0,
  procedure: 0,
  view: 0,
};

/**
 * Ordering among routines. `mysqldump` iterates the routine kinds in the
 * fixed order `FUNCTION`, then `PROCEDURE` (it runs `SHOW FUNCTION STATUS`
 * before `SHOW PROCEDURE STATUS`), and this reproduces that. It is a
 * presentation choice, not a dependency: MySQL resolves names inside a
 * stored program lazily at call time, so a procedure that calls a function
 * declared after it still creates successfully.
 */
const ROUTINE_KIND_PRIORITY: Record<ArchiveObjectType, number> = {
  database: 0,
  table: 0,
  tableData: 0,
  trigger: 0,
  viewStub: 0,
  event: 0,
  function: 0,
  procedure: 1,
  view: 0,
};

export function assignDumpSection(objectType: ArchiveObjectType): DumpSection {
  return SECTION_BY_OBJECT_TYPE[objectType];
}

export function dumpSectionPriority(section: DumpSection): number {
  return SECTION_PRIORITY[section];
}

export function mainGroupPriority(objectType: ArchiveObjectType): number {
  return MAIN_GROUP_PRIORITY[objectType];
}

export function routineKindPriority(objectType: ArchiveObjectType): number {
  return ROUTINE_KIND_PRIORITY[objectType];
}
