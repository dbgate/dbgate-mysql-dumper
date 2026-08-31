import type { DumpSelection, NormalizedDumpSelection } from './types.js';

export interface NormalizeSelectionOptions {
  /**
   * The server's `lower_case_table_names != 0`. When true, table and view
   * names are compared case-insensitively, matching how the server itself
   * resolves them.
   */
  readonly caseInsensitiveTableNames?: boolean;
}

function toSet(
  names: readonly string[] | undefined,
  fold: (name: string) => string,
): ReadonlySet<string> | undefined {
  return names ? new Set(names.map(fold)) : undefined;
}

export function normalizeDumpSelection(
  selection?: DumpSelection,
  options?: NormalizeSelectionOptions,
): NormalizedDumpSelection {
  const caseInsensitiveTableNames = options?.caseInsensitiveTableNames ?? false;
  const foldTable = (name: string): string =>
    caseInsensitiveTableNames ? name.toLowerCase() : name;
  // Routine, trigger and event names are case-insensitive in MySQL
  // independently of `lower_case_table_names`, so these always fold.
  const foldProgram = (name: string): string => name.toLowerCase();

  return {
    tables: toSet(selection?.tables, foldTable),
    excludeTables: new Set((selection?.excludeTables ?? []).map(foldTable)),
    views: toSet(selection?.views, foldTable),
    excludeViews: new Set((selection?.excludeViews ?? []).map(foldTable)),
    routines: toSet(selection?.routines, foldProgram),
    excludeRoutines: new Set((selection?.excludeRoutines ?? []).map(foldProgram)),
    triggers: toSet(selection?.triggers, foldProgram),
    excludeTriggers: new Set((selection?.excludeTriggers ?? []).map(foldProgram)),
    events: toSet(selection?.events, foldProgram),
    excludeEvents: new Set((selection?.excludeEvents ?? []).map(foldProgram)),
    dataExcludedTables: new Set((selection?.dataExcludedTables ?? []).map(foldTable)),
    caseInsensitiveTableNames,
  };
}

function isSelected(
  name: string,
  include: ReadonlySet<string> | undefined,
  exclude: ReadonlySet<string>,
): boolean {
  if (exclude.has(name)) {
    return false;
  }
  return include ? include.has(name) : true;
}

export function isTableSelected(name: string, selection: NormalizedDumpSelection): boolean {
  const key = selection.caseInsensitiveTableNames ? name.toLowerCase() : name;
  return isSelected(key, selection.tables, selection.excludeTables);
}

export function isViewSelected(name: string, selection: NormalizedDumpSelection): boolean {
  const key = selection.caseInsensitiveTableNames ? name.toLowerCase() : name;
  return isSelected(key, selection.views, selection.excludeViews);
}

export function isRoutineSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name.toLowerCase(), selection.routines, selection.excludeRoutines);
}

export function isTriggerSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name.toLowerCase(), selection.triggers, selection.excludeTriggers);
}

export function isEventSelected(name: string, selection: NormalizedDumpSelection): boolean {
  return isSelected(name.toLowerCase(), selection.events, selection.excludeEvents);
}

/** True when the table's *rows* should be skipped while its structure is still dumped. */
export function isTableDataExcluded(name: string, selection: NormalizedDumpSelection): boolean {
  const key = selection.caseInsensitiveTableNames ? name.toLowerCase() : name;
  return selection.dataExcludedTables.has(key);
}
