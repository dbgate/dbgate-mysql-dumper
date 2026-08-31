import { describe, expect, it } from 'vitest';
import { inspectDumpArchive } from '../src/archive/planner.js';
import type { ArchiveEntry } from '../src/archive/types.js';
import { normalizeDumpSelection } from '../src/selection/normalize.js';
import {
  makeDatabase,
  makeEvent,
  makeForeignKey,
  makeRoutine,
  makeTable,
  makeTrigger,
  makeView,
} from './fixtures.js';

/** A compact `type:name` view of the plan, for readable order assertions. */
function plan(entries: readonly ArchiveEntry[]): string[] {
  return entries.map(entry => `${entry.objectType}:${entry.name}`);
}

const database = makeDatabase({
  tables: [makeTable({ pureName: 'mt' }), makeTable({ pureName: 'zt' })],
  views: [makeView({ pureName: 'aview' }), makeView({ pureName: 'nview' })],
  routines: [
    makeRoutine({ pureName: 'sp_b', kind: 'PROCEDURE' }),
    makeRoutine({ pureName: 'fn_a', kind: 'FUNCTION' }),
  ],
  triggers: [makeTrigger({ triggerName: 'trg_mt', tableName: 'mt' })],
  events: [makeEvent({ eventName: 'ev_one' })],
});

describe('inspectDumpArchive: emission order', () => {
  it('interleaves tables and view stubs in one name-ordered pass', () => {
    // This is `mysqldump`'s own behaviour: it iterates SHOW TABLES, which
    // lists tables and views together in name order. Verified against a real
    // server in `integration/`.
    const archive = inspectDumpArchive(database);
    expect(plan(archive.entries).slice(0, 6)).toEqual([
      'viewStub:aview',
      'table:mt',
      'tableData:mt',
      'trigger:trg_mt',
      'viewStub:nview',
      'table:zt',
    ]);
  });

  it('puts a table, its data and its triggers in one contiguous group', () => {
    const archive = inspectDumpArchive(database);
    const names = plan(archive.entries);
    const table = names.indexOf('table:mt');
    expect(names.slice(table, table + 3)).toEqual(['table:mt', 'tableData:mt', 'trigger:trg_mt']);
  });

  it('orders sections: main, events, routines, then real views', () => {
    const archive = inspectDumpArchive(database);
    const sections: string[] = archive.entries.map(entry => entry.section);
    const firstIndex = (section: string): number => sections.indexOf(section);
    expect(firstIndex('main')).toBeLessThan(firstIndex('events'));
    expect(firstIndex('events')).toBeLessThan(firstIndex('routines'));
    expect(firstIndex('routines')).toBeLessThan(firstIndex('views'));
  });

  it('orders functions before procedures, as mysqldump does', () => {
    const archive = inspectDumpArchive(database);
    const names = plan(archive.entries);
    expect(names.indexOf('function:fn_a')).toBeLessThan(names.indexOf('procedure:sp_b'));
  });

  it('is valid and deterministic', () => {
    const first = inspectDumpArchive(database);
    const second = inspectDumpArchive(database);
    expect(first.valid).toBe(true);
    expect(first.cycles).toEqual([]);
    expect(first.unsatisfiedDependencies).toEqual([]);
    expect(plan(first.entries)).toEqual(plan(second.entries));
    expect(first.entries.map(entry => entry.dumpId)).toEqual(
      second.entries.map(entry => entry.dumpId),
    );
  });

  it('numbers entries by their position in the plan', () => {
    const archive = inspectDumpArchive(database);
    expect(archive.entries.map(entry => entry.sequenceNumber)).toEqual(
      archive.entries.map((_, index) => index),
    );
  });
});

describe('inspectDumpArchive: view stubs', () => {
  it('emits every stub before any real view definition', () => {
    // This is what makes plain name ordering safe for views: by the time any
    // real definition runs, every referenced view already exists with the
    // right column list.
    const archive = inspectDumpArchive(database);
    const names = plan(archive.entries);
    const lastStub = Math.max(names.indexOf('viewStub:aview'), names.indexOf('viewStub:nview'));
    const firstView = Math.min(names.indexOf('view:aview'), names.indexOf('view:nview'));
    expect(lastStub).toBeLessThan(firstView);
  });

  it('records the stub dependency as hard, and the plan satisfies it', () => {
    const archive = inspectDumpArchive(database);
    const view = archive.entries.find(
      entry => entry.objectType === 'view' && entry.name === 'aview',
    );
    const stub = archive.entries.find(
      entry => entry.objectType === 'viewStub' && entry.name === 'aview',
    );
    expect(
      view?.dependsOn.some(d => d.targetDumpId === stub?.dumpId && d.strength === 'hard'),
    ).toBe(true);
    expect(archive.unsatisfiedDependencies).toEqual([]);
  });
});

describe('inspectDumpArchive: foreign keys', () => {
  it('accepts circular foreign keys without reporting a cycle', () => {
    // FOREIGN_KEY_CHECKS=0 in the dump header makes any table order valid,
    // which is exactly why FK edges are recorded as preferences.
    const circular = makeDatabase({
      tables: [makeTable({ pureName: 'a' }), makeTable({ pureName: 'b' })],
      foreignKeys: [
        makeForeignKey({ tableName: 'a', referencedTableName: 'b' }),
        makeForeignKey({ tableName: 'b', referencedTableName: 'a' }),
      ],
    });
    const archive = inspectDumpArchive(circular);
    expect(archive.valid).toBe(true);
    expect(archive.cycles).toEqual([]);
    expect(plan(archive.entries)).toEqual(['table:a', 'tableData:a', 'table:b', 'tableData:b']);
  });

  it('records the foreign key as a preference edge', () => {
    const linked = makeDatabase({
      tables: [makeTable({ pureName: 'a' }), makeTable({ pureName: 'b' })],
      foreignKeys: [makeForeignKey({ tableName: 'a', referencedTableName: 'b' })],
    });
    const archive = inspectDumpArchive(linked);
    const tableA = archive.entries.find(
      entry => entry.objectType === 'table' && entry.name === 'a',
    );
    expect(tableA?.dependsOn.some(dependency => dependency.strength === 'preference')).toBe(true);
  });
});

describe('inspectDumpArchive: modes', () => {
  it('schema-only omits data entries', () => {
    const archive = inspectDumpArchive(database, { mode: 'schema-only' });
    expect(plan(archive.entries).some(name => name.startsWith('tableData:'))).toBe(false);
    expect(plan(archive.entries)).toContain('table:mt');
  });

  it('data-only keeps only table data', () => {
    const archive = inspectDumpArchive(database, { mode: 'data-only' });
    expect(plan(archive.entries)).toEqual(['tableData:mt', 'tableData:zt']);
  });
});

describe('inspectDumpArchive: selection and object kinds', () => {
  it('honors a table selection', () => {
    const archive = inspectDumpArchive(database, {
      selection: normalizeDumpSelection({ tables: ['mt'] }),
    });
    expect(plan(archive.entries).filter(name => name.startsWith('table'))).toEqual([
      'table:mt',
      'tableData:mt',
    ]);
  });

  it('drops a trigger whose table is not selected, and says so', () => {
    const archive = inspectDumpArchive(database, {
      selection: normalizeDumpSelection({ tables: ['zt'] }),
    });
    expect(plan(archive.entries).some(name => name.startsWith('trigger:'))).toBe(false);
    expect(archive.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'trigger-table-not-selected',
    );
  });

  it('excludes data for a table listed in dataExcludedTables but keeps its structure', () => {
    const archive = inspectDumpArchive(database, {
      selection: normalizeDumpSelection({ dataExcludedTables: ['mt'] }),
    });
    const names = plan(archive.entries);
    expect(names).toContain('table:mt');
    expect(names).not.toContain('tableData:mt');
    expect(names).toContain('tableData:zt');
  });

  it('honors object-kind toggles', () => {
    const archive = inspectDumpArchive(database, {
      objectKinds: { includeRoutines: false, includeEvents: false, includeTriggers: false },
    });
    const names = plan(archive.entries);
    expect(names.some(name => name.startsWith('function:'))).toBe(false);
    expect(names.some(name => name.startsWith('procedure:'))).toBe(false);
    expect(names.some(name => name.startsWith('event:'))).toBe(false);
    expect(names.some(name => name.startsWith('trigger:'))).toBe(false);
  });

  it('emits a database entry only when asked', () => {
    expect(plan(inspectDumpArchive(database).entries)).not.toContain('database:testdb');
    const withDatabase = inspectDumpArchive(database, { includeDatabaseEntry: true });
    expect(plan(withDatabase.entries)[0]).toBe('database:testdb');
  });
});

describe('inspectDumpArchive: identity', () => {
  it('gives distinct ids to same-named objects of different kinds', () => {
    const shared = makeDatabase({
      tables: [makeTable({ pureName: 'x' })],
      views: [makeView({ pureName: 'x' })],
    });
    const archive = inspectDumpArchive(shared);
    const ids = archive.entries.map(entry => entry.dumpId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces stable ids across runs', () => {
    const first = inspectDumpArchive(database).entries.map(entry => entry.dumpId);
    const second = inspectDumpArchive(database).entries.map(entry => entry.dumpId);
    expect(first).toEqual(second);
  });
});
