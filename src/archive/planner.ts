import type { MysqlDatabase } from '../model/database.js';
import type { MysqlDiagnostic } from '../model/diagnostics.js';
import type { DumpObjectKinds } from '../selection/types.js';
import {
  isEventSelected,
  isRoutineSelected,
  isTableDataExcluded,
  isTableSelected,
  isTriggerSelected,
  isViewSelected,
  normalizeDumpSelection,
} from '../selection/normalize.js';
import type { NormalizedDumpSelection } from '../selection/types.js';
import { createDumpId } from '../utils/hash.js';
import { createArchiveIdentity } from './identity.js';
import {
  assignDumpSection,
  dumpSectionPriority,
  mainGroupPriority,
  routineKindPriority,
} from './sectionRules.js';
import type {
  ArchiveCycle,
  ArchiveDependency,
  ArchiveEntry,
  ArchiveObjectType,
  DumpArchiveInspection,
  DumpMode,
  UnsatisfiedDependency,
} from './types.js';

export interface InspectDumpArchiveOptions {
  readonly mode?: DumpMode;
  readonly selection?: NormalizedDumpSelection;
  readonly objectKinds?: DumpObjectKinds;
  /** Emit a `database` entry (`CREATE DATABASE` / `USE`). Defaults to `false`, matching `mysqldump` without `--databases`. */
  readonly includeDatabaseEntry?: boolean;
}

interface MutableEntry {
  dumpId: string;
  identity: string;
  objectType: ArchiveObjectType;
  databaseName: string;
  name: string;
  parentName?: string;
  dependsOn: ArchiveDependency[];
  /** Name the entry sorts under within its section — the owning table for `tableData`/`trigger`. */
  groupKey: string;
  /** Stable tiebreaker within one group, e.g. several triggers on one table. */
  secondaryKey: string;
}

/**
 * Codepoint-ordered comparison, never `localeCompare`.
 *
 * `mysqldump` gets its order from the server's own `SHOW TABLES`, which sorts
 * by the `information_schema` collation, not by the client's locale. A
 * locale-aware sort here would reorder names differently depending on the
 * machine running the dump and break this package's determinism guarantee.
 */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Converts a normalized {@link MysqlDatabase} into an ordered,
 * dependency-validated set of {@link ArchiveEntry} objects.
 *
 * Independent of SQL text, output streams and connections: it decides only
 * *what* is dumped and in *what order*. The order it produces is
 * `mysqldump`'s, not a topological sort — see {@link DumpSection} for the
 * section layout and `ArchiveObjectType` for why view stubs make plain
 * name ordering safe. Dependencies are still recorded and then *verified*
 * against that fixed order, so a model or planning bug surfaces as
 * `valid: false` rather than as an unrestorable dump.
 */
export function inspectDumpArchive(
  database: MysqlDatabase,
  options: InspectDumpArchiveOptions = {},
): DumpArchiveInspection {
  const mode = options.mode ?? 'full';
  const selection = options.selection ?? normalizeDumpSelection();
  const kinds = options.objectKinds ?? {};
  const includeTables = kinds.includeTables ?? true;
  const includeViews = kinds.includeViews ?? true;
  const includeTriggers = kinds.includeTriggers ?? true;
  const includeRoutines = kinds.includeRoutines ?? true;
  const includeEvents = kinds.includeEvents ?? true;

  const wantsSchema = mode !== 'data-only';
  const wantsData = mode !== 'schema-only';

  const diagnostics: MysqlDiagnostic[] = [];
  const entries = new Map<string, MutableEntry>();

  function addEntry(
    objectType: ArchiveObjectType,
    name: string,
    groupKey: string,
    secondaryKey: string,
    parentName?: string,
  ): string {
    const identity = createArchiveIdentity({
      objectType,
      databaseName: database.databaseName,
      name,
      parentName,
    });
    const dumpId = createDumpId(identity);
    if (entries.has(dumpId)) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-archive-identity',
        message: `Duplicate archive identity for ${objectType} "${name}" in database "${database.databaseName}"`,
        objectReference: { kind: 'table', databaseName: database.databaseName, name, parentName },
      });
      return dumpId;
    }
    entries.set(dumpId, {
      dumpId,
      identity,
      objectType,
      databaseName: database.databaseName,
      name,
      parentName,
      dependsOn: [],
      groupKey,
      secondaryKey,
    });
    return dumpId;
  }

  function addDependency(
    fromDumpId: string,
    toDumpId: string | undefined,
    strength: ArchiveDependency['strength'],
  ): void {
    if (!toDumpId || fromDumpId === toDumpId) {
      return;
    }
    const entry = entries.get(fromDumpId);
    if (!entry) {
      return;
    }
    const existing = entry.dependsOn.find(dependency => dependency.targetDumpId === toDumpId);
    if (existing) {
      // A hard requirement always wins over a mere preference for the same pair.
      if (strength === 'hard' && existing.strength === 'preference') {
        entry.dependsOn = entry.dependsOn.filter(
          dependency => dependency.targetDumpId !== toDumpId,
        );
        entry.dependsOn.push({ targetDumpId: toDumpId, strength: 'hard' });
      }
      return;
    }
    entry.dependsOn.push({ targetDumpId: toDumpId, strength });
  }

  const databaseDumpId = options.includeDatabaseEntry
    ? addEntry('database', database.databaseName, database.databaseName, '')
    : undefined;

  const tableDumpId = new Map<string, string>();
  const tableDataDumpId = new Map<string, string>();
  const viewStubDumpId = new Map<string, string>();

  const selectedTables = includeTables
    ? database.tables.filter(table => isTableSelected(table.pureName, selection))
    : [];
  const selectedViews = includeViews
    ? database.views.filter(view => isViewSelected(view.pureName, selection))
    : [];

  for (const table of [...selectedTables].sort((a, b) => byCodepoint(a.pureName, b.pureName))) {
    if (wantsSchema) {
      const dumpId = addEntry('table', table.pureName, table.pureName, '0');
      tableDumpId.set(table.pureName, dumpId);
      addDependency(dumpId, databaseDumpId, 'hard');
    }
    if (wantsData && !isTableDataExcluded(table.pureName, selection)) {
      const dumpId = addEntry('tableData', table.pureName, table.pureName, '1', table.pureName);
      tableDataDumpId.set(table.pureName, dumpId);
      addDependency(dumpId, tableDumpId.get(table.pureName), 'hard');
      addDependency(dumpId, databaseDumpId, 'hard');
    }
  }

  for (const view of selectedViews) {
    if (!wantsSchema) {
      continue;
    }
    const dumpId = addEntry('viewStub', view.pureName, view.pureName, '0');
    viewStubDumpId.set(view.pureName, dumpId);
    addDependency(dumpId, databaseDumpId, 'hard');
  }

  if (includeTriggers && wantsSchema) {
    const selectedTriggers = database.triggers.filter(
      trigger =>
        isTriggerSelected(trigger.triggerName, selection) &&
        // A trigger is meaningless without its table, and `mysqldump` emits it
        // inside that table's block; a trigger on a table the selection
        // excluded is therefore dropped rather than orphaned.
        tableDumpId.has(trigger.tableName),
    );
    for (const trigger of selectedTriggers) {
      const dumpId = addEntry(
        'trigger',
        trigger.triggerName,
        trigger.tableName,
        `2:${trigger.actionOrder ?? 0}:${trigger.triggerName}`,
        trigger.tableName,
      );
      addDependency(dumpId, tableDumpId.get(trigger.tableName), 'hard');
      // Hard, not cosmetic: a trigger created before its table's rows are
      // loaded fires once per inserted row, fabricating side effects the
      // source database never had.
      addDependency(dumpId, tableDataDumpId.get(trigger.tableName), 'hard');
    }

    for (const trigger of database.triggers) {
      if (
        isTriggerSelected(trigger.triggerName, selection) &&
        !tableDumpId.has(trigger.tableName)
      ) {
        diagnostics.push({
          severity: 'info',
          code: 'trigger-table-not-selected',
          message: `Trigger "${trigger.triggerName}" is not dumped because its table "${trigger.tableName}" is not part of the selection`,
          objectReference: {
            kind: 'trigger',
            databaseName: database.databaseName,
            name: trigger.triggerName,
            parentName: trigger.tableName,
          },
        });
      }
    }
  }

  if (includeEvents && wantsSchema) {
    for (const event of [...database.events]
      .filter(event => isEventSelected(event.eventName, selection))
      .sort((a, b) => byCodepoint(a.eventName, b.eventName))) {
      const dumpId = addEntry('event', event.eventName, event.eventName, '');
      addDependency(dumpId, databaseDumpId, 'hard');
    }
  }

  if (includeRoutines && wantsSchema) {
    for (const routine of [...database.routines]
      .filter(routine => isRoutineSelected(routine.pureName, selection))
      .sort((a, b) => byCodepoint(a.pureName, b.pureName))) {
      const dumpId = addEntry(
        routine.kind === 'FUNCTION' ? 'function' : 'procedure',
        routine.pureName,
        routine.pureName,
        '',
      );
      addDependency(dumpId, databaseDumpId, 'hard');
    }
  }

  if (wantsSchema) {
    for (const view of [...selectedViews].sort((a, b) => byCodepoint(a.pureName, b.pureName))) {
      const dumpId = addEntry('view', view.pureName, view.pureName, '');
      // The real definition replaces this view's own stub, and relies on
      // every *other* referenced view's stub already existing — which is
      // exactly why all stubs are emitted in the `main` section, before any
      // real definition. Recorded as a hard edge so the check below proves
      // the emitted order really does place every stub first.
      addDependency(dumpId, viewStubDumpId.get(view.pureName), 'hard');
      for (const otherStubDumpId of viewStubDumpId.values()) {
        addDependency(dumpId, otherStubDumpId, 'hard');
      }
      for (const tableEntryDumpId of tableDumpId.values()) {
        // A view's body may reference any table; the table's structure must
        // exist for the definition to compile.
        addDependency(dumpId, tableEntryDumpId, 'preference');
      }
    }
  }

  // Foreign keys are recorded as *preferences* only. Every dump this package
  // writes opens with `FOREIGN_KEY_CHECKS=0`, so any table order restores
  // correctly — which is precisely what makes circular foreign keys work.
  // Recording them as hard edges would report a false cycle for exactly the
  // schemas that restore fine.
  for (const foreignKey of database.foreignKeys) {
    const from = tableDumpId.get(foreignKey.tableName);
    const to = tableDumpId.get(foreignKey.referencedTableName);
    if (from && to) {
      addDependency(from, to, 'preference');
    }
  }

  const ordered = [...entries.values()].sort(compareEntries);
  const { cycles, unsatisfiedDependencies } = validateOrder(ordered);
  const valid =
    cycles.length === 0 &&
    unsatisfiedDependencies.length === 0 &&
    !diagnostics.some(diagnostic => diagnostic.severity === 'error');

  for (const cycle of cycles) {
    diagnostics.push({
      severity: 'error',
      code: 'archive-dependency-cycle',
      message: `Hard dependency cycle between archive entries: ${cycle.memberDumpIds.join(', ')}`,
    });
  }
  for (const violation of unsatisfiedDependencies) {
    diagnostics.push({
      severity: 'error',
      code: 'archive-order-violation',
      message: `Archive entry ${violation.fromDumpId} is emitted before its hard dependency ${violation.toDumpId}`,
    });
  }

  return {
    valid,
    entries: ordered.map((entry, index) => toArchiveEntry(entry, valid ? index : undefined)),
    diagnostics,
    cycles,
    unsatisfiedDependencies,
  };
}

function compareEntries(a: MutableEntry, b: MutableEntry): number {
  const sectionDelta =
    dumpSectionPriority(assignDumpSection(a.objectType)) -
    dumpSectionPriority(assignDumpSection(b.objectType));
  if (sectionDelta !== 0) {
    return sectionDelta;
  }

  const section = assignDumpSection(a.objectType);
  if (section === 'routines') {
    // Functions before procedures, then by name — `mysqldump`'s order.
    const kindDelta = routineKindPriority(a.objectType) - routineKindPriority(b.objectType);
    if (kindDelta !== 0) {
      return kindDelta;
    }
  }

  const groupDelta = byCodepoint(a.groupKey, b.groupKey);
  if (groupDelta !== 0) {
    return groupDelta;
  }
  const withinGroupDelta = mainGroupPriority(a.objectType) - mainGroupPriority(b.objectType);
  if (withinGroupDelta !== 0) {
    return withinGroupDelta;
  }
  const secondaryDelta = byCodepoint(a.secondaryKey, b.secondaryKey);
  if (secondaryDelta !== 0) {
    return secondaryDelta;
  }
  return byCodepoint(a.name, b.name);
}

function toArchiveEntry(entry: MutableEntry, sequenceNumber: number | undefined): ArchiveEntry {
  return {
    dumpId: entry.dumpId,
    identity: entry.identity,
    objectType: entry.objectType,
    section: assignDumpSection(entry.objectType),
    databaseName: entry.databaseName,
    name: entry.name,
    ...(entry.parentName === undefined ? {} : { parentName: entry.parentName }),
    dependsOn: entry.dependsOn,
    ...(sequenceNumber === undefined ? {} : { sequenceNumber }),
  };
}

/**
 * Verifies the fixed emission order against the recorded hard dependencies,
 * and separately reports any hard cycle.
 *
 * This is a *check*, not a sort. The order is dictated by native
 * compatibility, so if a hard dependency points backwards the right answer
 * is to surface it — reordering would produce a dump that no longer matches
 * `mysqldump`'s structure, and the underlying cause would stay hidden.
 */
function validateOrder(ordered: readonly MutableEntry[]): {
  cycles: ArchiveCycle[];
  unsatisfiedDependencies: UnsatisfiedDependency[];
} {
  const positionByDumpId = new Map(ordered.map((entry, index) => [entry.dumpId, index]));
  const unsatisfiedDependencies: UnsatisfiedDependency[] = [];

  for (const entry of ordered) {
    const fromPosition = positionByDumpId.get(entry.dumpId) as number;
    for (const dependency of entry.dependsOn) {
      if (dependency.strength !== 'hard') {
        continue;
      }
      const toPosition = positionByDumpId.get(dependency.targetDumpId);
      if (toPosition !== undefined && toPosition > fromPosition) {
        unsatisfiedDependencies.push({
          fromDumpId: entry.dumpId,
          toDumpId: dependency.targetDumpId,
        });
      }
    }
  }

  return { cycles: findHardCycles(ordered), unsatisfiedDependencies };
}

/** Tarjan's strongly-connected components over hard edges only; any component of size > 1 is a cycle. */
function findHardCycles(entries: readonly MutableEntry[]): ArchiveCycle[] {
  const indexByDumpId = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const byDumpId = new Map(entries.map(entry => [entry.dumpId, entry]));
  const cycles: ArchiveCycle[] = [];
  let nextIndex = 0;

  const strongConnect = (dumpId: string): void => {
    indexByDumpId.set(dumpId, nextIndex);
    lowLink.set(dumpId, nextIndex);
    nextIndex++;
    stack.push(dumpId);
    onStack.add(dumpId);

    for (const dependency of byDumpId.get(dumpId)?.dependsOn ?? []) {
      if (dependency.strength !== 'hard' || !byDumpId.has(dependency.targetDumpId)) {
        continue;
      }
      const target = dependency.targetDumpId;
      if (!indexByDumpId.has(target)) {
        strongConnect(target);
        lowLink.set(dumpId, Math.min(lowLink.get(dumpId) as number, lowLink.get(target) as number));
      } else if (onStack.has(target)) {
        lowLink.set(
          dumpId,
          Math.min(lowLink.get(dumpId) as number, indexByDumpId.get(target) as number),
        );
      }
    }

    if (lowLink.get(dumpId) === indexByDumpId.get(dumpId)) {
      const component: string[] = [];
      for (;;) {
        const member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
        if (member === dumpId) {
          break;
        }
      }
      if (component.length > 1) {
        cycles.push({ memberDumpIds: component.sort(byCodepoint) });
      }
    }
  };

  for (const entry of entries) {
    if (!indexByDumpId.has(entry.dumpId)) {
      strongConnect(entry.dumpId);
    }
  }
  return cycles;
}
