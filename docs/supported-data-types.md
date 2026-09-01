# Supported data types

Every value takes the same path: MySQL's own bytes → the column's introspected
type decides the literal form → the dump. No JavaScript `Number`, `Date` or
`JSON.parse` sits anywhere in it. That is what makes the table below say "exact"
so often.

See [architecture.md](architecture.md#why-values-arrive-as-raw-bytes) for why the
value mode is designed that way.

The matrix is exercised on both supported flavors. MariaDB's `JSON` declaration
round-trips as its canonical `LONGTEXT` plus `json_valid(...)` CHECK constraint;
the stored JSON text is not converted to MySQL's binary JSON model.

## Type matrix

| Type family                            | Literal form          | Fidelity                                    |          In fixture          |
| -------------------------------------- | --------------------- | ------------------------------------------- | :--------------------------: |
| `NULL`                                 | `NULL`                | exact                                       |              ✅              |
| `TINYINT`…`BIGINT`, signed/unsigned    | unquoted digits       | exact                                       |              ✅              |
| `BIGINT` at both bounds                | unquoted digits       | **exact** — never through a JS number       |              ✅              |
| `BIGINT UNSIGNED` 18446744073709551615 | unquoted digits       | **exact**                                   |              ✅              |
| `DECIMAL` / `NUMERIC`                  | unquoted digits       | **exact**, trailing zeros and all           |     ✅ `DECIMAL(30,10)`      |
| `FLOAT`                                | server's own text     | exact                                       |    ✅ at the type maximum    |
| `DOUBLE`                               | server's own text     | exact                                       | ✅ `1.7976931348623157e308`  |
| `BIT(n)`                               | `0x…` / `_binary '…'` | exact                                       |         ✅ `BIT(11)`         |
| `BOOL` / `BOOLEAN` (`TINYINT(1)`)      | unquoted `0`/`1`      | exact                                       |              ✅              |
| `CHAR`, `VARCHAR`                      | quoted, escaped       | exact                                       |              ✅              |
| `TINYTEXT`…`LONGTEXT`                  | quoted, escaped       | exact                                       |              ✅              |
| `BINARY`, `VARBINARY`                  | `0x…` / `_binary '…'` | exact                                       |   ✅ incl. all-zero bytes    |
| `TINYBLOB`…`LONGBLOB`                  | `0x…` / `_binary '…'` | exact                                       |   ✅ incl. NUL and `0xFF`    |
| `ENUM`                                 | quoted                | exact                                       |              ✅              |
| `SET`                                  | quoted, comma-joined  | exact                                       |    ✅ incl. the empty set    |
| `JSON`                                 | quoted, escaped       | **exact text** — key order and spacing kept |              ✅              |
| `DATE`                                 | quoted                | exact                                       | ✅ `1000-01-01`…`9999-12-31` |
| `DATETIME(0-6)`                        | quoted                | exact, full fractional precision            |       ✅ `datetime(6)`       |
| `TIMESTAMP`                            | quoted                | exact under the dump's `TIME_ZONE` guard    |      ✅ to `2038-01-18`      |
| `TIME(0-6)`                            | quoted                | exact, incl. `±838:59:59`                   |        ✅ both bounds        |
| `YEAR`                                 | unquoted              | exact                                       |      ✅ `1901`, `2155`       |
| Zero dates (`'0000-00-00'`)            | quoted, verbatim      | exact where the server permits them         |         unit-tested          |
| `GEOMETRY` and the spatial family      | `0x…` / `_binary '…'` | exact, SRID preserved                       |     ⚠️ unit-tested only      |
| `VECTOR` (9.0+)                        | `0x…`                 | treated as binary; untested                 |              ❌              |

`hexBlob: true` (the default) produces `0x…`; `hexBlob: false` produces
`_binary '…'` with raw bytes, matching `mysqldump`'s default. Both are
round-trip tested.

## Why each hard case works

### `BIGINT` and `DECIMAL`

The server's text reaches the dump unchanged. `9223372036854775807`,
`-9223372036854775808`, `18446744073709551615` and
`DECIMAL(30,10)` at full precision all round-trip byte-exactly. A driver-native
read would round these through IEEE-754 — which is why the raw value mode exists
and why `lossy-value-mode` is warned about when a connection cannot provide it.

### `FLOAT` and `DOUBLE`

Emitted as the server formatted them, exponent included. Expanding
`1.7976931348623157e308` into plain digits would produce a 309-digit literal
MySQL parses as `DECIMAL` — maximum precision 65 — and rejects.

### Zero dates and out-of-range `TIME`

`'0000-00-00'` and `'-838:59:59'` are legal MySQL values that **cannot** be
represented as a JavaScript `Date`. Because the value never becomes one, they
pass through verbatim. A driver returning `Date` objects would have already lost
them before this package saw them.

### `TIMESTAMP` and time zones

`TIMESTAMP` is stored in UTC and converted using the session zone on read. The
dump reads under `'+00:00'` (matching `mysqldump --tz-utc`) **and** writes
`/*!40103 SET TIME_ZONE='+00:00' */` into its own header, so both ends agree and
the value survives a move between servers in different zones. The two are set
from the same option, so they cannot drift apart.

Set `timeZone: null` for `--skip-tz-utc` behaviour: the session zone is left
alone and no guard is written.

### `JSON`

MySQL normalizes JSON on storage and returns its own canonical text. That text is
what is dumped, so key order and inner spacing survive. A driver that parsed the
column and this package re-serialized it would not reproduce either — hence no
`JSON.parse` in the value path.

### `BLOB` and binary

`hexBlob: true` renders `0xDEADBEEF`, and zero-length input renders `''` rather
than `0x` (MySQL's hexadecimal grammar needs at least one digit pair;
`mysqldump` has the same special case).

`hexBlob: false` renders `_binary '…'` with byte-wise escaping. The `_binary`
introducer is required: without it a `SET NAMES utf8mb4` connection would make
the server try to interpret the bytes as UTF-8. The bytes never pass through a
JavaScript string — the writer accepts `Buffer` for exactly this — so a value
containing `0xFF`, a lone surrogate byte or an unpaired UTF-8 lead byte survives.

Restoring such a dump is also handled: see
[native-compatibility.md](native-compatibility.md#restoring-a-mysqldump-default-raw-binary-dump).

### Spatial types

Rendered as byte literals, not `ST_GeomFromText(...)` constructors. MySQL sends a
spatial value as its internal representation — a 4-byte SRID followed by WKB —
and accepts exactly that form back. `mysqldump` does the same, and it is what
keeps the SRID intact, which a WKT constructor would drop.

Modelled and unit-tested, but not in the Docker fixture, so listed as ⚠️ rather
than ✅.

## Escaping

`escapeMysqlString` reproduces `mysql_real_escape_string_quote` exactly — the
same function `mysqldump` uses:

| Code point   | Escape |
| ------------ | ------ |
| `U+0000` NUL | `\0`   |
| `U+000A` LF  | `\n`   |
| `U+000D` CR  | `\r`   |
| `U+001A` SUB | `\Z`   |
| `U+0022` `"` | `\"`   |
| `U+0027` `'` | `\'`   |
| `U+005C` `\` | `\\`   |

Two absences are deliberate:

- **TAB is not escaped.** A literal tab inside a quoted string is valid MySQL and
  needs no escape; `mysql_real_escape_string` leaves it alone, so escaping it
  would make output differ from `mysqldump` for no benefit. The native fixtures
  contain a raw tab in a value, and it round-trips.
- **Ctrl+Z _is_ escaped**, as `\Z`, even though MySQL accepts the raw byte —
  because a raw `0x1A` terminates input on Windows when a dump is piped through
  `cmd`'s redirection. This is why `mysql_real_escape_string` escapes it, and it
  is why a dump produced here stays restorable via `mysql < dump.sql` on Windows.

Multi-byte text passes through untouched: every escaped code point is ASCII, and
no UTF-16 code unit of an astral character (a surrogate) or of any non-ASCII BMP
character can collide with one. Emoji, CJK and combining marks are byte-identical
after UTF-8 encoding.

## `NO_BACKSLASH_ESCAPES`

Backslash escapes only mean anything when the _restoring_ session does not have
`NO_BACKSLASH_ESCAPES` set. Every dump therefore opens with:

```sql
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
```

Assigning the whole variable **replaces** the restoring session's `sql_mode`,
clearing the flag if it was set — and the footer restores the original. That line
is the reason this escaping is safe, which is why disabling
`includeSessionGuards` produces a warning naming the consequence.

On the _reading_ side the same concern is handled in the dump session:
`ANSI_QUOTES`, `NO_BACKSLASH_ESCAPES` and `ANSI` are subtracted from the
connection's `sql_mode` for the duration (and restored afterwards), so
`SHOW CREATE TABLE` cannot come back with double-quoted identifiers that no
restore session would accept.

The restore parser tracks the mode too: `backslashEscapes: 'auto'` follows a
`SET ... sql_mode` in the script the way the server would, so a file that
genuinely sets `NO_BACKSLASH_ESCAPES` is lexed correctly from that point on.

## Numeric safety

A numeric column's value is emitted **unquoted and verbatim** only when it
matches MySQL's numeric-literal grammar. Anything else — unexpected text from a
non-conforming driver, say — is quoted defensively, so it can never break
statement syntax. MySQL coerces a quoted numeric on the way in, so the value is
still correct.

`formatNumberLiteral`, the fallback for driver-native numbers, refuses `NaN` and
`Infinity` outright rather than emitting invalid SQL: MySQL has no literal for
either, and a caller reaching that point has already lost the original value.
