import { throwIfAborted } from '../utils/errors.js';
import { rewriteBinaryLiterals } from './binaryLiterals.js';
import {
  BinaryLiteralError,
  InvalidDelimiterError,
  MalformedSqlDumpError,
  StatementTooLargeError,
  UnsupportedClientCommandError,
} from './errors.js';
import type { StatementSourceLocation } from './location.js';
import type { SqlDumpSource } from './source.js';

const DEFAULT_MAX_STATEMENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_DELIMITER = ';';

/**
 * Longest run of letters that could still be a `mysql` client command name.
 *
 * The longest name this package recognizes is `delimiter` (9); the cap leaves
 * generous room while keeping the lookahead — and therefore the cross-chunk
 * carry buffer — bounded on hostile input.
 */
const MAX_CLIENT_COMMAND_LENGTH = 16;

/**
 * Longest accepted `DELIMITER` argument. Real delimiters are one to three
 * characters (`;`, `;;`, `$$`, `//`); anything approaching this cap is
 * malformed input, and refusing it keeps the lookahead bounded.
 */
const MAX_DELIMITER_LENGTH = 64;

/**
 * How the parser treats a backslash inside a quoted string.
 *
 * - `'auto'` (default) starts with backslash escapes **enabled** — MySQL's
 *   own default, and what every `mysqldump` output relies on — and then
 *   watches completed statements for a `SET ... sql_mode = ...` that adds or
 *   removes `NO_BACKSLASH_ESCAPES`, following the script the way the server
 *   itself would. A dump's own header (`SQL_MODE='NO_AUTO_VALUE_ON_ZERO'`)
 *   is such a statement, and it *clears* the flag, so the common case is
 *   handled without the caller thinking about it.
 * - `'enabled'` / `'disabled'` pin the behaviour, for a script whose mode is
 *   established outside the file.
 */
export type BackslashEscapeMode = 'auto' | 'enabled' | 'disabled';

export interface SqlStatementParserOptions {
  /**
   * Upper bound, in UTF-8 bytes, on one statement's accumulated text.
   *
   * Guards against unbounded memory growth from a truncated dump or an
   * unbalanced `DELIMITER` command. Defaults to 256 MiB — large enough for
   * any single extended `INSERT` a real dump contains (`mysqldump` caps
   * those near 1 MiB) while still bounded.
   */
  readonly maxStatementBytes?: number;
  /** Delimiter in force before the script's first `DELIMITER` command. Defaults to `';'`. */
  readonly initialDelimiter?: string;
  readonly backslashEscapes?: BackslashEscapeMode;
}

export interface ParsedStatement {
  readonly statementIndex: number;
  /** Statement text with its delimiter removed, trimmed. Never empty. */
  readonly sql: string;
  readonly location: StatementSourceLocation;
  /** The delimiter that terminated this statement (or the one in force at end of input). */
  readonly delimiter: string;
  /**
   * The section comment most recently seen before this statement, when the
   * dump carries `mysqldump`'s own `-- Dumping data for table \`t\`` banners.
   * Reported through restore progress so a long restore can say where it is.
   */
  readonly currentObject?: string;
  /**
   * UTF-8 bytes of source the parser had consumed when this statement was
   * emitted.
   *
   * Carried on the statement because a caller consuming
   * {@link streamSqlStatements} has no other handle on the parser, and
   * "bytes consumed" is the only progress measure that is meaningful for a
   * dump of unknown statement count.
   */
  readonly bytesConsumed: number;
  /**
   * How many raw `_binary '...'` literals were converted to hexadecimal so
   * the statement could be sent as text. Non-zero only for a dump taken
   * without `--hex-blob`; see `binaryLiterals.ts`.
   */
  readonly binaryLiteralsRewritten: number;
}

type LexerState =
  | 'normal'
  | 'singleQuote'
  | 'doubleQuote'
  | 'backtick'
  | 'lineComment'
  | 'blockComment'
  | 'skipToEndOfLine';

const OPEN_CONSTRUCT_NAME: Record<
  'singleQuote' | 'doubleQuote' | 'backtick' | 'blockComment',
  string
> = {
  singleQuote: "single-quoted string ('...')",
  doubleQuote: 'double-quoted string ("...")',
  backtick: 'backtick-quoted identifier (`...`)',
  blockComment: 'block comment (/* ... */)',
};

/** `mysql` client commands, in the long and backslash-prefixed forms the client accepts. */
const CLIENT_COMMANDS: readonly {
  readonly names: readonly string[];
  readonly supported: boolean;
}[] = [
  { names: ['delimiter'], supported: true },
  { names: ['source'], supported: false },
  { names: ['system'], supported: false },
  { names: ['tee'], supported: false },
  { names: ['notee'], supported: false },
  { names: ['charset'], supported: false },
  { names: ['pager'], supported: false },
  { names: ['nopager'], supported: false },
  { names: ['prompt'], supported: false },
  { names: ['connect'], supported: false },
];

/** Recognizes a `SET ... sql_mode = '...'` statement, so `'auto'` escape tracking can follow it. */
const SQL_MODE_ASSIGNMENT =
  /\bsql_mode\s*(?::=|=)\s*('(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|\S+)/i;

function isWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f' ||
    character === '\v'
  );
}

/**
 * Incrementally splits a MySQL client script into statements.
 *
 * This is a real lexer, not a `split(';')`: a delimiter only ends a
 * statement when it appears in ordinary SQL text, never inside a string, a
 * backtick-quoted identifier, a `--`/`#` line comment or a `/* &#42;/` block
 * comment — and never when a `DELIMITER` command has changed what the
 * delimiter is.
 *
 * Two MySQL-specific behaviours drive the design:
 *
 * **Executable comments are SQL, not comments.** `/*!40000 ALTER TABLE ...
 * DISABLE KEYS &#42;/` and `/*+ hint &#42;/` are scanned as ordinary statement text
 * — exactly as `mysql`'s own parser does — so their contents are sent to the
 * server, which evaluates the version gate itself. Treating them as
 * disposable comments would drop real, version-gated SQL from the restore.
 * It also means a delimiter *inside* an executable comment does end the
 * statement, which is precisely why `mysqldump` wraps stored programs in a
 * `DELIMITER ;;` region: without it, the `;` after each statement in a
 * trigger body would cut the `CREATE TRIGGER` in half.
 *
 * **`DELIMITER` is a client command, not SQL.** It is consumed here, updates
 * parser state, and is never sent to the server — which would reject it.
 * Any delimiter string is supported, not just `;;`.
 *
 * Memory is bounded on every path: only the current statement's text plus a
 * few carried characters are retained, incoming chunks are never
 * re-concatenated onto the accumulated statement, and
 * `options.maxStatementBytes` fails fast on a pathological input rather than
 * growing without limit.
 */
export class SqlStatementParser {
  private readonly maxStatementBytes: number;
  private readonly backslashEscapeMode: BackslashEscapeMode;

  private state: LexerState = 'normal';
  private delimiter: string;
  private backslashEscapes: boolean;
  /** State the parser must return to after a `--`/`#` comment or a skipped line ends. */
  private stateBeforeComment: LexerState = 'normal';
  /** Line on which the currently-open string/identifier/block comment started. */
  private openLine = 1;

  /** Text carried from the previous chunk whose meaning could not yet be decided. */
  private carry = '';
  /** Fragments of the current statement, joined only when it is emitted. */
  private statementParts: string[] = [];
  private statementByteLength = 0;
  private statementStartLine: number | null = null;
  /** True once the statement has accumulated something other than whitespace and comments. */
  private statementHasContent = false;

  private currentLine = 1;
  /**
   * Whether the next character begins a line, ignoring leading whitespace.
   * The very first character of the input qualifies. Maintained incrementally
   * in {@link scan}; see the comment there.
   */
  private atLineStart = true;
  private nextStatementIndex = 0;
  private finished = false;
  private bytesConsumedTotal = 0;
  private lastSectionComment: string | undefined;
  /** Accumulates the current `--` comment's text, to recognize a section banner. */
  private commentText = '';

  constructor(options?: SqlStatementParserOptions) {
    this.maxStatementBytes = options?.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES;
    this.delimiter = options?.initialDelimiter ?? DEFAULT_DELIMITER;
    this.backslashEscapeMode = options?.backslashEscapes ?? 'auto';
    this.backslashEscapes = this.backslashEscapeMode !== 'disabled';
  }

  /** The delimiter currently in force. */
  get currentDelimiter(): string {
    return this.delimiter;
  }

  /** UTF-8 bytes of source consumed so far. */
  get bytesConsumed(): number {
    return this.bytesConsumedTotal;
  }

  /**
   * Feeds one chunk of the source, as a **byte string** - one code unit per
   * byte, as produced by `buffer.toString('latin1')`. Callers holding text
   * should use {@link parseSqlStatements} or {@link streamSqlStatements},
   * which convert for them.
   */
  push(chunk: string): ParsedStatement[] {
    if (this.finished) {
      throw new Error('SqlStatementParser.push() called after finish()');
    }
    // Chunks reaching here are byte strings (one code unit per byte), so
    // length is the byte count directly - see `toByteStringChunks`.
    this.bytesConsumedTotal += chunk.length;
    if (chunk.length === 0) {
      return [];
    }
    return this.scan(this.carry + chunk, false);
  }

  finish(): ParsedStatement[] {
    if (this.finished) {
      throw new Error('SqlStatementParser.finish() called more than once');
    }
    this.finished = true;

    const statements = this.scan(this.carry, true);
    this.carry = '';

    if (
      this.state === 'singleQuote' ||
      this.state === 'doubleQuote' ||
      this.state === 'backtick' ||
      this.state === 'blockComment'
    ) {
      throw new MalformedSqlDumpError(OPEN_CONSTRUCT_NAME[this.state], this.openLine);
    }

    const trailing = this.flushStatement();
    if (trailing) {
      statements.push(trailing);
    }
    return statements;
  }

  /**
   * Scans `text`, emitting completed statements.
   *
   * When `atEnd` is false, a trailing run of characters whose meaning
   * depends on what comes next — a partial delimiter, a lone `-` that might
   * begin `--`, a `/` that might begin `/*` — is moved to {@link carry}
   * instead of being appended, so a construct split across two chunks is
   * never mis-lexed. This is what makes the parser correct for *every*
   * possible chunk boundary, which `tests/statementParser.test.ts` verifies
   * exhaustively.
   */
  private scan(text: string, atEnd: boolean): ParsedStatement[] {
    const statements: ParsedStatement[] = [];
    let index = 0;
    let appendFrom = 0;

    const appendUpTo = (end: number): void => {
      if (end > appendFrom) {
        this.appendToStatement(text.slice(appendFrom, end));
      }
      appendFrom = end;
    };

    /**
     * The value {@link atLineStart} had before the current character was
     * accounted for, so {@link holdBack} can undo that accounting when the
     * character is carried over to the next chunk instead of consumed.
     */
    let atLineStartBeforeCharacter = this.atLineStart;

    const holdBack = (from: number): void => {
      appendUpTo(from);
      this.carry = text.slice(from);
      appendFrom = text.length;
      // The held-back character will be re-scanned from the start of the next
      // chunk, so its effect on the line-start flag must be rolled back.
      // Without this, a `DELIMITER` whose first letter lands at a chunk
      // boundary is no longer seen as line-initial and is executed as SQL —
      // which silently splits every stored program in the dump.
      this.atLineStart = atLineStartBeforeCharacter;
    };

    while (index < text.length) {
      const character = text[index] as string;

      // "Is this character at the start of its line?" is tracked incrementally
      // rather than by scanning backwards for the previous newline: the
      // backward scan was O(line length) per character, so a single very long
      // line of leading whitespace made the parse quadratic. The pre-update
      // value is what the command check below must see — updating first would
      // clear the flag on the very character being tested.
      const atLineStartHere = this.atLineStart;
      atLineStartBeforeCharacter = atLineStartHere;
      if (character === '\n') {
        this.atLineStart = true;
      } else if (!isWhitespace(character)) {
        this.atLineStart = false;
      }

      switch (this.state) {
        case 'normal': {
          // A client command is only recognized at the start of a line with
          // nothing but whitespace accumulated in the current statement —
          // the same rule the `mysql` client applies, and what keeps
          // `SELECT delimiter FROM t` from being mistaken for one.
          if (!this.statementHasContent && atLineStartHere) {
            const command = this.tryReadClientCommand(text, index, atEnd);
            if (command === 'incomplete') {
              holdBack(index);
              return statements;
            }
            if (command !== null) {
              appendUpTo(index);
              // The command replaces whatever whitespace preceded it; nothing
              // of it is ever sent to the server.
              this.discardPendingWhitespace();
              index = command.nextIndex;
              appendFrom = index;
              continue;
            }
          }

          if (this.matchesDelimiterAt(text, index)) {
            appendUpTo(index);
            index += this.delimiter.length;
            appendFrom = index;
            const statement = this.flushStatement();
            if (statement) {
              statements.push(statement);
            }
            continue;
          }
          if (!atEnd && this.couldStartDelimiterAt(text, index)) {
            holdBack(index);
            return statements;
          }

          if (character === "'") {
            this.state = 'singleQuote';
            this.openLine = this.currentLine;
            this.markContent();
            index++;
            continue;
          }
          if (character === '"') {
            this.state = 'doubleQuote';
            this.openLine = this.currentLine;
            this.markContent();
            index++;
            continue;
          }
          if (character === '`') {
            this.state = 'backtick';
            this.openLine = this.currentLine;
            this.markContent();
            index++;
            continue;
          }
          if (character === '#') {
            this.stateBeforeComment = 'normal';
            this.state = 'lineComment';
            this.commentText = '';
            index++;
            continue;
          }
          if (character === '-') {
            const next = text[index + 1];
            if (next === undefined) {
              if (!atEnd) {
                holdBack(index);
                return statements;
              }
              index++;
              continue;
            }
            if (next === '-') {
              const following = text[index + 2];
              if (following === undefined && !atEnd) {
                holdBack(index);
                return statements;
              }
              // MySQL requires whitespace (or end of line) after `--` for it
              // to be a comment; `5--3` is arithmetic, not a comment.
              if (following === undefined || isWhitespace(following) || following < ' ') {
                this.stateBeforeComment = 'normal';
                this.state = 'lineComment';
                this.commentText = '';
                index += 2;
                continue;
              }
            }
            this.markContent();
            index++;
            continue;
          }
          if (character === '/') {
            const next = text[index + 1];
            if (next === undefined) {
              if (!atEnd) {
                holdBack(index);
                return statements;
              }
              this.markContent();
              index++;
              continue;
            }
            if (next === '*') {
              const marker = text[index + 2];
              if (marker === undefined && !atEnd) {
                holdBack(index);
                return statements;
              }
              // `/*!` (version-gated SQL) and `/*+` (optimizer hint) are
              // statement text, not comments — see the class doc.
              if (marker === '!' || marker === '+') {
                this.markContent();
                index += 2;
                continue;
              }
              this.state = 'blockComment';
              this.openLine = this.currentLine;
              index += 2;
              continue;
            }
            this.markContent();
            index++;
            continue;
          }

          if (!isWhitespace(character)) {
            this.markContent();
          }
          if (character === '\n') {
            this.currentLine++;
          }
          index++;
          continue;
        }

        case 'singleQuote':
        case 'doubleQuote': {
          const quote = this.state === 'singleQuote' ? "'" : '"';
          if (this.backslashEscapes && character === '\\') {
            if (text[index + 1] === undefined) {
              if (!atEnd) {
                holdBack(index);
                return statements;
              }
              index++;
              continue;
            }
            if (text[index + 1] === '\n') {
              this.currentLine++;
            }
            index += 2;
            continue;
          }
          if (character === quote) {
            if (text[index + 1] === undefined && !atEnd) {
              holdBack(index);
              return statements;
            }
            if (text[index + 1] === quote) {
              index += 2;
              continue;
            }
            this.state = 'normal';
            index++;
            continue;
          }
          if (character === '\n') {
            this.currentLine++;
          }
          index++;
          continue;
        }

        case 'backtick': {
          // Backslash is *not* an escape inside a quoted identifier; MySQL
          // only recognizes a doubled backtick there.
          if (character === '`') {
            if (text[index + 1] === undefined && !atEnd) {
              holdBack(index);
              return statements;
            }
            if (text[index + 1] === '`') {
              index += 2;
              continue;
            }
            this.state = 'normal';
            index++;
            continue;
          }
          if (character === '\n') {
            this.currentLine++;
          }
          index++;
          continue;
        }

        case 'lineComment': {
          if (character === '\n') {
            this.noteSectionComment();
            this.state = this.stateBeforeComment;
            this.currentLine++;
            index++;
            continue;
          }
          if (character !== '\r') {
            this.commentText += character;
          }
          index++;
          continue;
        }

        case 'skipToEndOfLine': {
          // Everything after a `DELIMITER` command's argument is discarded,
          // the way the `mysql` client discards it. The characters are
          // dropped rather than appended, so they never reach the server.
          appendUpTo(index);
          appendFrom = index + 1;
          if (character === '\n') {
            this.state = 'normal';
            this.currentLine++;
          }
          index++;
          continue;
        }

        case 'blockComment': {
          if (character === '*') {
            if (text[index + 1] === undefined && !atEnd) {
              holdBack(index);
              return statements;
            }
            if (text[index + 1] === '/') {
              this.state = 'normal';
              index += 2;
              continue;
            }
          }
          if (character === '\n') {
            this.currentLine++;
          }
          index++;
          continue;
        }
      }
    }

    appendUpTo(text.length);
    this.carry = '';
    return statements;
  }

  /**
   * Attempts to read a `mysql` client command at `index`.
   *
   * Returns `null` when there is no command here, `'incomplete'` when the
   * decision needs more input, and `{ nextIndex }` once a command has been
   * fully consumed.
   *
   * Both scans below are **length-bounded**, and that bound is what keeps the
   * parser safe on hostile input. `'incomplete'` makes the caller carry the
   * whole remaining chunk over to the next `push()`, so an unbounded scan
   * would let a pathological input — one long run of letters at the start of
   * a statement — grow the carry buffer without limit and re-scan it every
   * time, turning the parse quadratic. No client command name, and no
   * plausible delimiter, comes anywhere near these caps.
   */
  private tryReadClientCommand(
    text: string,
    index: number,
    atEnd: boolean,
  ): { nextIndex: number } | 'incomplete' | null {
    let scan = index;
    const backslashForm = text[scan] === '\\';
    if (backslashForm) {
      scan++;
    }

    const wordLimit = Math.min(text.length, scan + MAX_CLIENT_COMMAND_LENGTH);
    let wordEnd = scan;
    while (wordEnd < wordLimit && /[A-Za-z.]/.test(text[wordEnd] as string)) {
      wordEnd++;
    }
    if (wordEnd === scan) {
      return null;
    }
    // A run of letters longer than any command name cannot be one, so there is
    // nothing to wait for — decide now rather than carrying the chunk over.
    if (wordEnd === wordLimit && wordEnd - scan >= MAX_CLIENT_COMMAND_LENGTH) {
      return null;
    }
    if (wordEnd === text.length && !atEnd) {
      return 'incomplete';
    }

    const word = text.slice(scan, wordEnd).toLowerCase();
    const command = CLIENT_COMMANDS.find(candidate => candidate.names.includes(word));
    if (!command) {
      return null;
    }
    // `DELIMITER` must be followed by whitespace and an argument; a bare word
    // at the start of a statement that merely looks like a command (a column
    // named `source` beginning a `source = 1` fragment) is left as SQL.
    const separator = text[wordEnd];
    if (separator !== undefined && !isWhitespace(separator)) {
      return null;
    }
    if (!command.supported) {
      throw new UnsupportedClientCommandError(word, this.currentLine);
    }
    return this.readDelimiterCommand(text, wordEnd, atEnd);
  }

  /**
   * Consumes a `DELIMITER <token>` command and installs the new delimiter.
   *
   * The argument is the first whitespace-delimited token, with surrounding
   * quotes stripped — matching the `mysql` client, which also accepts
   * `DELIMITER '||'`. The remainder of the line is discarded via the
   * `skipToEndOfLine` state, again as the client does.
   */
  private readDelimiterCommand(
    text: string,
    afterKeyword: number,
    atEnd: boolean,
  ): { nextIndex: number } | 'incomplete' {
    let scan = afterKeyword;
    const spaceLimit = Math.min(text.length, scan + MAX_DELIMITER_LENGTH);
    while (scan < spaceLimit && (text[scan] === ' ' || text[scan] === '\t')) {
      scan++;
    }
    if (scan === text.length && !atEnd) {
      return 'incomplete';
    }

    const start = scan;
    // Bounded for the same reason as the command word: an unterminated run of
    // non-whitespace must not make the parser buffer the rest of the input
    // waiting for a delimiter that is already far too long to be one.
    const argumentLimit = Math.min(text.length, start + MAX_DELIMITER_LENGTH);
    while (scan < argumentLimit && !isWhitespace(text[scan] as string)) {
      scan++;
    }
    if (scan === argumentLimit && scan - start >= MAX_DELIMITER_LENGTH) {
      throw new InvalidDelimiterError(
        text.slice(start, Math.min(scan, start + 32)),
        this.currentLine,
        `a delimiter must be shorter than ${MAX_DELIMITER_LENGTH} characters`,
      );
    }
    if (scan === text.length && !atEnd) {
      return 'incomplete';
    }

    const rawArgument = text.slice(start, scan);
    if (rawArgument.length === 0) {
      throw new InvalidDelimiterError(rawArgument, this.currentLine, 'a delimiter is required');
    }
    const argument = stripQuotes(rawArgument);
    if (argument.length === 0) {
      throw new InvalidDelimiterError(rawArgument, this.currentLine, 'a delimiter is required');
    }
    if (argument.includes('\\')) {
      // The `mysql` client refuses this for the same reason: a backslash is
      // the escape character inside string literals, so a delimiter
      // containing one could never be recognized reliably.
      throw new InvalidDelimiterError(
        rawArgument,
        this.currentLine,
        'a delimiter must not contain a backslash',
      );
    }

    this.delimiter = argument;
    this.state = 'skipToEndOfLine';
    return { nextIndex: scan };
  }

  private matchesDelimiterAt(text: string, index: number): boolean {
    return text.startsWith(this.delimiter, index);
  }

  /**
   * True when the text from `index` to the end of the chunk is a proper
   * prefix of the delimiter — so whether a delimiter starts here cannot be
   * decided until more input arrives.
   */
  private couldStartDelimiterAt(text: string, index: number): boolean {
    const remaining = text.length - index;
    return remaining < this.delimiter.length && this.delimiter.startsWith(text.slice(index));
  }

  private appendToStatement(fragment: string): void {
    if (fragment.length === 0) {
      return;
    }
    this.statementParts.push(fragment);
    this.statementByteLength += fragment.length;
    if (this.statementByteLength > this.maxStatementBytes) {
      throw new StatementTooLargeError(
        this.maxStatementBytes,
        this.statementStartLine ?? this.currentLine,
      );
    }
  }

  /**
   * Records that the statement has real content starting on the current
   * line.
   *
   * The start line is captured here, while scanning, rather than when text
   * is appended: fragments are appended in batches once a boundary is found,
   * by which point {@link currentLine} has already advanced past every
   * newline in the batch, and the reported location would point at the end
   * of the statement instead of its beginning.
   */
  private markContent(): void {
    this.statementHasContent = true;
    if (this.statementStartLine === null) {
      this.statementStartLine = this.currentLine;
    }
  }

  /** Drops accumulated whitespace ahead of a client command, so none of it is emitted. */
  private discardPendingWhitespace(): void {
    if (this.statementParts.every(part => part.trim().length === 0)) {
      this.statementParts = [];
      this.statementByteLength = 0;
      this.statementStartLine = null;
    }
  }

  /** Records a `mysqldump` section banner, so restore progress can report where it is. */
  private noteSectionComment(): void {
    // The comment was accumulated as bytes; a section banner naming a
    // non-ASCII table would otherwise be reported as mojibake.
    const text = Buffer.from(this.commentText, 'latin1').toString('utf8').trim();
    this.commentText = '';
    const match =
      /^(?:Table structure for table|Dumping data for table|Temporary view structure for view|Final view structure for view)\s+(.+)$/.exec(
        text,
      ) ?? /^Dumping (routines|events) for database\s+(.+)$/.exec(text);
    if (match) {
      this.lastSectionComment = text;
    }
  }

  private flushStatement(): ParsedStatement | null {
    const byteString = this.statementParts.join('').trim();
    const startLine = this.statementStartLine ?? this.currentLine;
    const hadContent = this.statementHasContent;

    this.statementParts = [];
    this.statementByteLength = 0;
    this.statementStartLine = null;
    this.statementHasContent = false;

    // A "statement" made only of comments and whitespace is not sent: the
    // `mysql` client does not send one either, and the server would reject
    // an empty query. Note that an *executable* comment counts as content,
    // because it is real SQL.
    if (byteString.length === 0 || !hadContent) {
      return null;
    }

    // The lexer works on bytes; the statement becomes text only here. A
    // statement carrying raw binary - `mysqldump`'s default for BLOB columns
    // - is not valid UTF-8 and would be destroyed by the decode, so those
    // literals are converted to the equivalent hexadecimal form first.
    const rewrite = rewriteBinaryLiterals(Buffer.from(byteString, 'latin1'));
    if (rewrite.failed) {
      throw new BinaryLiteralError(rewrite.failed, startLine);
    }
    const sql = rewrite.bytes.toString('utf8');

    this.trackSqlMode(sql);

    return {
      statementIndex: this.nextStatementIndex++,
      sql,
      location: { startLine, endLine: this.currentLine },
      delimiter: this.delimiter,
      bytesConsumed: this.bytesConsumedTotal,
      binaryLiteralsRewritten: rewrite.rewrittenLiterals,
      ...(this.lastSectionComment === undefined ? {} : { currentObject: this.lastSectionComment }),
    };
  }

  /**
   * Follows a `SET ... sql_mode = ...` in the script, so subsequent string
   * literals are lexed the way the server will read them.
   *
   * Only meaningful in `'auto'` mode. The check is on the assignment's
   * *value*, not on the statement as a whole, so a statement that merely
   * mentions the flag in a comment or a string does not flip the parser.
   */
  private trackSqlMode(sql: string): void {
    if (this.backslashEscapeMode !== 'auto') {
      return;
    }
    const match = SQL_MODE_ASSIGNMENT.exec(sql);
    if (!match) {
      return;
    }
    const value = match[1] as string;
    if (/@OLD_SQL_MODE|@saved_sql_mode|@@/i.test(value)) {
      // Restoring a saved mode: the saved value is not knowable from the
      // script text, so the safest assumption is MySQL's default, which is
      // the state the parser started in.
      this.backslashEscapes = true;
      return;
    }
    this.backslashEscapes = !/NO_BACKSLASH_ESCAPES/i.test(value);
  }
}

function stripQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length >= 2 && (first === "'" || first === '"' || first === '`') && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

/** Parses a complete, already-in-memory script. A convenience wrapper over {@link SqlStatementParser}. */
export function parseSqlStatements(
  sql: string | Buffer,
  options?: SqlStatementParserOptions,
): ParsedStatement[] {
  const parser = new SqlStatementParser(options);
  const byteString = (typeof sql === 'string' ? Buffer.from(sql, 'utf8') : sql).toString('latin1');
  return [...parser.push(byteString), ...parser.finish()];
}

/**
 * Normalizes any {@link SqlDumpSource} into *byte strings*: one JavaScript
 * code unit per input byte, via `latin1`.
 *
 * The lexer runs on bytes rather than characters for two reasons. First, a
 * dump is not necessarily valid UTF-8 - `mysqldump` writes raw `BLOB` bytes
 * by default - and decoding as UTF-8 up front would replace them with
 * U+FFFD before the parser ever saw them. Second, `latin1` is a bijection
 * between bytes and code points, so nothing is lost and
 * `Buffer.from(text, 'latin1')` reconstructs the exact bytes when a
 * statement is emitted.
 *
 * Scanning bytes is safe for multi-byte text: every character the lexer
 * reacts to is ASCII, and no UTF-8 continuation byte (>= 0x80) can be
 * mistaken for one. It also removes the need for a `StringDecoder`, since a
 * `latin1` decode can never split a character across chunks, and makes
 * `maxStatementBytes` exact rather than an estimate.
 */
async function* toByteStringChunks(source: SqlDumpSource): AsyncGenerator<string> {
  if (typeof source === 'string') {
    yield Buffer.from(source, 'utf8').toString('latin1');
    return;
  }
  if (source instanceof Uint8Array) {
    // Covers `Buffer` too, which extends `Uint8Array`.
    yield (Buffer.isBuffer(source) ? source : Buffer.from(source)).toString('latin1');
    return;
  }
  for await (const chunk of source as AsyncIterable<string | Buffer | Uint8Array>) {
    if (typeof chunk === 'string') {
      yield Buffer.from(chunk, 'utf8').toString('latin1');
    } else {
      yield (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('latin1');
    }
  }
}

/**
 * Streams `source` into {@link ParsedStatement}s without ever buffering the
 * whole input: at most the current statement's text, plus a few carried
 * characters, is held at a time.
 */
export async function* streamSqlStatements(
  source: SqlDumpSource,
  options?: SqlStatementParserOptions,
  signal?: AbortSignal,
): AsyncGenerator<ParsedStatement> {
  const parser = new SqlStatementParser(options);
  for await (const chunk of toByteStringChunks(source)) {
    throwIfAborted(signal);
    for (const statement of parser.push(chunk)) {
      yield statement;
    }
  }
  throwIfAborted(signal);
  for (const statement of parser.finish()) {
    yield statement;
  }
}
