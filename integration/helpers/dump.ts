import { Writable } from 'node:stream';
import { dumpMysql } from '../../src/api/dump.js';
import type { DumpMysqlOptions, DumpResult } from '../../src/api/types.js';
import type { MysqlConnection } from '../../src/connection/types.js';
import type { DumpProgressCallback } from '../../src/utils/progress.js';

/** Collects everything written to it, keeping bytes intact so binary dumps survive. */
export class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  text(): string {
    return this.buffer().toString('utf8');
  }
}

export interface DumpToBufferResult {
  readonly sql: Buffer;
  readonly text: string;
  readonly result: DumpResult;
}

/** Runs a full `dumpMysql` into memory and returns both the bytes and the structured result. */
export async function dumpToBuffer(
  connection: MysqlConnection,
  options: DumpMysqlOptions,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpToBufferResult> {
  const output = new CollectingWritable();
  const result = await dumpMysql(connection, options, output, onProgress, signal);
  const sql = output.buffer();
  return { sql, text: sql.toString('utf8'), result };
}

/**
 * Splits a dump the way a careless client would — on every `;` outside no
 * context at all.
 *
 * Used only to *demonstrate* that this package's dumps (and `mysqldump`'s)
 * contain content such a splitter tears apart: a stored program body whose
 * statements each end in `;`, and string literals containing `;`. Never used
 * to actually restore anything.
 */
export function naivelySplitOnSemicolons(sql: string): string[] {
  return sql
    .split(';')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}
