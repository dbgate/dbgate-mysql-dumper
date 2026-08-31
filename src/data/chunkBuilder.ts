/**
 * Accumulates SQL fragments that may be text *or* raw bytes.
 *
 * With `hexBlob: false` a `BLOB` value is written as `_binary '...'`
 * containing bytes that are not valid UTF-8, so a statement cannot always be
 * assembled as a JavaScript string. Joining through a string would replace
 * every invalid sequence with U+FFFD and corrupt the data silently.
 *
 * The all-text case — which `hexBlob: true`, the default, always produces —
 * stays on the fast path: parts are joined with `String.prototype.join` and
 * no `Buffer` is allocated at all. Only a builder that has actually been
 * handed bytes falls back to `Buffer.concat`.
 */
export class SqlChunkBuilder {
  private readonly parts: (string | Buffer)[] = [];
  private byteLength = 0;
  private hasBytes = false;

  /** UTF-8 byte length of everything appended so far. */
  get length(): number {
    return this.byteLength;
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  append(part: string | Buffer): this {
    if (typeof part === 'string') {
      if (part.length === 0) {
        return this;
      }
      this.parts.push(part);
      this.byteLength += Buffer.byteLength(part, 'utf8');
      return this;
    }
    if (part.length === 0) {
      return this;
    }
    this.parts.push(part);
    this.byteLength += part.length;
    this.hasBytes = true;
    return this;
  }

  /** Appends everything from `other`, leaving `other` untouched. */
  appendBuilder(other: SqlChunkBuilder): this {
    for (const part of other.parts) {
      this.append(part);
    }
    return this;
  }

  /** The accumulated content, as a `string` when it is all text and a `Buffer` otherwise. */
  build(): string | Buffer {
    if (!this.hasBytes) {
      return this.parts.join('');
    }
    return Buffer.concat(
      this.parts.map(part => (typeof part === 'string' ? Buffer.from(part, 'utf8') : part)),
    );
  }
}
