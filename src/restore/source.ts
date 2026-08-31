import type { Readable } from 'node:stream';

/**
 * Anything {@link restoreSqlDump}/{@link streamSqlStatements} can read a dump
 * from.
 *
 * `Buffer`/`Uint8Array` is accepted alongside `string` for a reason that
 * matters: a dump written with `hexBlob: false` contains raw `BLOB` bytes
 * inside `_binary '...'` literals and is therefore *not* valid UTF-8.
 * Forcing a caller to `.toString()` such a dump before restoring it would
 * replace every invalid sequence with U+FFFD and silently corrupt the data,
 * so the bytes are taken directly instead.
 *
 * `Readable` streams are consumed through their own async-iterable protocol
 * (`for await`), so `fs.createReadStream(path)` needs no adapter. Bytes are
 * decoded as UTF-8 with a persistent `StringDecoder`, so a multi-byte
 * character split across two chunks is never corrupted.
 */
export type SqlDumpSource =
  string | Buffer | Uint8Array | Readable | AsyncIterable<string | Buffer | Uint8Array>;
