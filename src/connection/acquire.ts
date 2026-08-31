import type { AcquiredMysqlConnection, MysqlConnection, MysqlConnectionInput } from './types.js';
import { isMysqlConnectionSource } from './types.js';

/**
 * Normalizes a {@link MysqlConnectionInput} into an acquired connection with
 * a release callback. A direct connection resolves immediately with a no-op
 * release and `dedicated: false` (the caller may be sharing it); a source —
 * typically a pool — is asked for one physical connection through its own
 * `acquire()`, which is what snapshot consistency requires.
 */
export async function acquireMysqlConnection(
  input: MysqlConnectionInput,
  signal?: AbortSignal,
): Promise<AcquiredMysqlConnection> {
  if (isMysqlConnectionSource(input)) {
    return input.acquire(signal);
  }
  return {
    connection: input as MysqlConnection,
    dedicated: false,
    release: async () => {},
  };
}

/** Runs one statement through `execute()` when the adapter has it, else through `query()`. */
export async function executeStatement(
  connection: MysqlConnection,
  sql: string,
  signal?: AbortSignal,
): Promise<{ affectedRows: number; warningCount?: number }> {
  if (connection.execute) {
    return connection.execute(sql, signal);
  }
  const result = await connection.query({ sql }, signal, 'native');
  return { affectedRows: result.affectedRows, warningCount: result.warningCount };
}
