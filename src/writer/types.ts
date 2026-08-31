/**
 * Incremental output sink for rendered dump text.
 *
 * `write` accepts a `Buffer` as well as a `string` because a MySQL dump is
 * not necessarily valid UTF-8: with `hexBlob: false` (matching
 * `mysqldump`'s own default) a `BLOB`/`VARBINARY` value is written as
 * `_binary '...'` containing the column's raw bytes, exactly as `mysqldump`
 * writes it. Routing those bytes through a JavaScript string would replace
 * every invalid UTF-8 sequence with U+FFFD and silently corrupt the data, so
 * the binary path hands the writer a `Buffer` instead.
 *
 * Implementations never close the underlying resource; callers own its
 * lifecycle.
 */
export interface DumpWriter {
  /** Writes one chunk, resolving once it is safe to write again (respects backpressure). */
  write(chunk: string | Buffer, signal?: AbortSignal): Promise<void>;
  /** Total bytes written so far. */
  readonly bytesWritten: number;
}
