import type { MysqlCheckConstraint, MysqlForeignKey } from '../src/model/constraint.js';
import type { MysqlDatabase } from '../src/model/database.js';
import type { MysqlIndex } from '../src/model/indexes.js';
import type {
  MysqlCreationContext,
  MysqlEvent,
  MysqlRoutine,
  MysqlTrigger,
  MysqlView,
} from '../src/model/programmable.js';
import type { MysqlColumn, MysqlTable } from '../src/model/table.js';

/**
 * Hand-built model objects for unit tests.
 *
 * Deliberately separate from the Docker fixture in `integration/fixture/`:
 * these exist so the planner and renderer can be tested as pure functions,
 * with no server involved and no introspection in the way.
 */

export const CREATION_CONTEXT: MysqlCreationContext = {
  characterSetClient: 'utf8mb4',
  collationConnection: 'utf8mb4_0900_ai_ci',
  sqlMode: 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
};

export function makeColumn(overrides: Partial<MysqlColumn> & { columnName: string }): MysqlColumn {
  return {
    ordinalPosition: 1,
    dataType: 'int',
    columnType: 'int',
    isNullable: true,
    isUnsigned: false,
    defaultValue: null,
    isDefaultExpression: false,
    isAutoIncrement: false,
    generation: 'none',
    generationExpression: null,
    isInvisible: false,
    onUpdate: null,
    characterSetName: null,
    collationName: null,
    characterMaximumLength: null,
    numericPrecision: 10,
    numericScale: 0,
    datetimePrecision: null,
    srsId: null,
    comment: '',
    ...overrides,
  };
}

export function makeTable(overrides: Partial<MysqlTable> & { pureName: string }): MysqlTable {
  return {
    databaseName: 'testdb',
    engine: 'InnoDB',
    autoIncrement: null,
    tableCollation: 'utf8mb4_0900_ai_ci',
    tableCharacterSet: 'utf8mb4',
    rowFormat: 'Dynamic',
    createOptions: '',
    comment: '',
    createSql: `CREATE TABLE \`${overrides.pureName}\` (\n  \`id\` int NOT NULL\n) ENGINE=InnoDB`,
    columns: [makeColumn({ columnName: 'id', isNullable: false })],
    isTransactional: true,
    ...overrides,
  };
}

export function makeView(overrides: Partial<MysqlView> & { pureName: string }): MysqlView {
  return {
    databaseName: 'testdb',
    definition: 'select 1 AS `x`',
    createSql: `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW \`${overrides.pureName}\` AS select 1 AS \`x\``,
    definer: 'root@localhost',
    securityType: 'DEFINER',
    checkOption: 'NONE',
    isUpdatable: false,
    algorithm: 'UNDEFINED',
    creationContext: CREATION_CONTEXT,
    columnNames: ['x'],
    ...overrides,
  };
}

export function makeRoutine(
  overrides: Partial<MysqlRoutine> & { pureName: string; kind: MysqlRoutine['kind'] },
): MysqlRoutine {
  return {
    databaseName: 'testdb',
    createSql: `CREATE DEFINER=\`root\`@\`localhost\` ${overrides.kind} \`${overrides.pureName}\`()\nBEGIN\n  SELECT 1;\nEND`,
    definer: 'root@localhost',
    securityType: 'DEFINER',
    isDeterministic: false,
    dataAccess: 'CONTAINS SQL',
    comment: '',
    parameterList: null,
    returnType: null,
    creationContext: CREATION_CONTEXT,
    ...overrides,
  };
}

export function makeTrigger(
  overrides: Partial<MysqlTrigger> & { triggerName: string; tableName: string },
): MysqlTrigger {
  return {
    databaseName: 'testdb',
    timing: 'AFTER',
    event: 'INSERT',
    createSql: `CREATE DEFINER=\`root\`@\`localhost\` TRIGGER \`${overrides.triggerName}\` AFTER INSERT ON \`${overrides.tableName}\` FOR EACH ROW BEGIN\n  INSERT INTO \`log\` VALUES (1);\n  INSERT INTO \`log\` VALUES (2);\nEND`,
    actionStatement: 'BEGIN\n  INSERT INTO `log` VALUES (1);\nEND',
    actionOrientation: 'ROW',
    actionOrder: 1,
    definer: 'root@localhost',
    creationContext: CREATION_CONTEXT,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<MysqlEvent> & { eventName: string }): MysqlEvent {
  return {
    databaseName: 'testdb',
    createSql: `CREATE DEFINER=\`root\`@\`localhost\` EVENT \`${overrides.eventName}\` ON SCHEDULE EVERY 1 DAY ON COMPLETION PRESERVE DISABLE DO BEGIN\n  DELETE FROM \`log\`;\nEND`,
    definer: 'root@localhost',
    eventType: 'RECURRING',
    intervalValue: '1',
    intervalField: 'DAY',
    executeAt: null,
    startsAt: '2030-01-01 00:00:00',
    endsAt: null,
    status: 'DISABLED',
    onCompletion: 'PRESERVE',
    comment: '',
    timeZone: 'SYSTEM',
    creationContext: CREATION_CONTEXT,
    ...overrides,
  };
}

export function makeIndex(
  overrides: Partial<MysqlIndex> & { tableName: string; indexName: string },
): MysqlIndex {
  return {
    databaseName: 'testdb',
    isPrimary: overrides.indexName === 'PRIMARY',
    isUnique: overrides.indexName === 'PRIMARY',
    indexType: 'BTREE',
    comment: '',
    isVisible: true,
    columns: [
      {
        columnName: 'id',
        ordinalPosition: 1,
        prefixLength: null,
        direction: 'ASC',
        expression: null,
      },
    ],
    ...overrides,
  };
}

export function makeForeignKey(
  overrides: Partial<MysqlForeignKey> & { tableName: string; referencedTableName: string },
): MysqlForeignKey {
  return {
    databaseName: 'testdb',
    constraintName: `fk_${overrides.tableName}_${overrides.referencedTableName}`,
    referencedDatabaseName: 'testdb',
    updateAction: 'NO ACTION',
    deleteAction: 'NO ACTION',
    columns: [{ columnName: 'ref_id', referencedColumnName: 'id', ordinalPosition: 1 }],
    ...overrides,
  };
}

export function makeCheckConstraint(
  overrides: Partial<MysqlCheckConstraint> & { tableName: string; constraintName: string },
): MysqlCheckConstraint {
  return {
    databaseName: 'testdb',
    checkClause: '(`id` > 0)',
    isEnforced: true,
    ...overrides,
  };
}

export function makeDatabase(overrides: Partial<MysqlDatabase> = {}): MysqlDatabase {
  return {
    databaseName: 'testdb',
    characterSetName: 'utf8mb4',
    collationName: 'utf8mb4_0900_ai_ci',
    defaultEncryption: 'N',
    tables: [],
    views: [],
    indexes: [],
    foreignKeys: [],
    checkConstraints: [],
    routines: [],
    triggers: [],
    events: [],
    ...overrides,
  };
}
