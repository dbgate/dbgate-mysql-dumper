import { executeStatement } from '../connection/acquire.js';
import type { MysqlConnection } from '../connection/types.js';

/**
 * Tracks the session variables a dump's header changes, so they can be put
 * back if the restore stops before reaching the dump's own footer.
 *
 * These are **session** state, not script state. A dump sets
 * `FOREIGN_KEY_CHECKS=0`, `UNIQUE_CHECKS=0`, `SQL_MODE='NO_AUTO_VALUE_ON_ZERO'`
 * and `TIME_ZONE='+00:00'` at the top and restores each at the bottom — but a
 * restore that stops at a failing statement (the `stopOnError` default) or is
 * cancelled never reaches the bottom. Without this, the caller's connection
 * goes back to their pool with foreign-key checking silently disabled, and
 * their next unrelated write no longer enforces referential integrity. That
 * is a data-corruption hazard the caller has no API to detect or fix, which
 * is why cleaning it up is on by default.
 *
 * Detection is on the *statement*, not on a parsed AST: these assignments
 * appear in dumps in exactly one shape, inside a `/*!40014 ... &#42;/`
 * executable comment, and matching that shape is both sufficient and immune
 * to being confused by a statement that merely mentions the variable.
 */
const GUARD_PATTERNS: readonly {
  readonly code: string;
  readonly detect: RegExp;
  readonly restore: string;
}[] = [
  {
    code: 'FOREIGN_KEY_CHECKS',
    detect: /\bSET\b[^;]*\bFOREIGN_KEY_CHECKS\s*=\s*0\b/i,
    // The dump saved the original into @OLD_FOREIGN_KEY_CHECKS; using it when
    // present is exact, and COALESCE falls back to MySQL's default of 1 when
    // the header never ran (a data-only fragment, say).
    restore: 'SET FOREIGN_KEY_CHECKS=COALESCE(@OLD_FOREIGN_KEY_CHECKS, 1)',
  },
  {
    code: 'UNIQUE_CHECKS',
    detect: /\bSET\b[^;]*\bUNIQUE_CHECKS\s*=\s*0\b/i,
    restore: 'SET UNIQUE_CHECKS=COALESCE(@OLD_UNIQUE_CHECKS, 1)',
  },
  {
    code: 'SQL_MODE',
    detect: /\bSET\b[^;]*@OLD_SQL_MODE\s*=\s*@@SQL_MODE/i,
    restore: 'SET SQL_MODE=COALESCE(@OLD_SQL_MODE, @@GLOBAL.sql_mode)',
  },
  {
    code: 'TIME_ZONE',
    detect: /\bSET\b[^;]*@OLD_TIME_ZONE\s*=\s*@@TIME_ZONE/i,
    restore: "SET TIME_ZONE=COALESCE(@OLD_TIME_ZONE, 'SYSTEM')",
  },
  {
    code: 'SQL_NOTES',
    detect: /\bSET\b[^;]*\bSQL_NOTES\s*=\s*0\b/i,
    restore: 'SET SQL_NOTES=COALESCE(@OLD_SQL_NOTES, 1)',
  },
  {
    code: 'CHARACTER_SET_CLIENT',
    detect: /\bSET\s+NAMES\b|\bCHARACTER_SET_CLIENT\s*=/i,
    restore:
      'SET CHARACTER_SET_CLIENT=COALESCE(@OLD_CHARACTER_SET_CLIENT, @@GLOBAL.character_set_client)',
  },
  {
    code: 'CHARACTER_SET_RESULTS',
    detect: /\bSET\s+NAMES\b|\bCHARACTER_SET_RESULTS\s*=/i,
    // NULL is a meaningful saved value here (`character_set_results=binary`),
    // so COALESCE would be lossy. A native dump always initializes this user
    // variable before SET NAMES; an absent variable also evaluates to NULL,
    // which is the safest fallback for a hand-written fragment.
    restore: 'SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS',
  },
  {
    code: 'COLLATION_CONNECTION',
    detect: /\bSET\s+NAMES\b|\bCOLLATION_CONNECTION\s*=/i,
    restore:
      'SET COLLATION_CONNECTION=COALESCE(@OLD_COLLATION_CONNECTION, @@GLOBAL.collation_connection)',
  },
];

/** A statement that already put a guarded variable back; nothing left to clean up for it. */
const RESTORED_PATTERNS: readonly { readonly code: string; readonly detect: RegExp }[] = [
  {
    code: 'FOREIGN_KEY_CHECKS',
    detect: /\bSET\s+FOREIGN_KEY_CHECKS\s*=\s*@OLD_FOREIGN_KEY_CHECKS/i,
  },
  { code: 'UNIQUE_CHECKS', detect: /\bSET\s+UNIQUE_CHECKS\s*=\s*@OLD_UNIQUE_CHECKS/i },
  { code: 'SQL_MODE', detect: /\bSET\s+SQL_MODE\s*=\s*@OLD_SQL_MODE/i },
  { code: 'TIME_ZONE', detect: /\bSET\s+TIME_ZONE\s*=\s*@OLD_TIME_ZONE/i },
  { code: 'SQL_NOTES', detect: /\bSET\s+SQL_NOTES\s*=\s*@OLD_SQL_NOTES/i },
  {
    code: 'CHARACTER_SET_CLIENT',
    detect: /\bSET\s+CHARACTER_SET_CLIENT\s*=\s*@OLD_CHARACTER_SET_CLIENT/i,
  },
  {
    code: 'CHARACTER_SET_RESULTS',
    detect: /\bSET\s+CHARACTER_SET_RESULTS\s*=\s*@OLD_CHARACTER_SET_RESULTS/i,
  },
  {
    code: 'COLLATION_CONNECTION',
    detect: /\bSET\s+COLLATION_CONNECTION\s*=\s*@OLD_COLLATION_CONNECTION/i,
  },
];

/**
 * `LOCK TABLES` opens a lock that survives until `UNLOCK TABLES` or the end
 * of the session — a `ROLLBACK` does not release it, and neither does any
 * `SET`.
 *
 * Every dump wraps each table's data in `LOCK TABLES t WRITE; … UNLOCK
 * TABLES;`, so a restore that stops in between (the `stopOnError` default, or
 * a cancellation) hands the caller's connection back to their pool **still
 * holding a write lock**. Every other session that touches that table then
 * blocks indefinitely, and the holding session itself can no longer touch any
 * *other* table (`ER_TABLE_NOT_LOCKED`). That is a worse outage than the
 * variable leaks above, and the caller has no API to detect or clear it.
 *
 * `LOCK TABLES` also implicitly releases any previous lock, so tracking a
 * single boolean is sufficient — there is never more than one lock set open.
 */
const LOCK_TABLES = /^\s*LOCK\s+TABLES\b/i;
const UNLOCK_TABLES = /^\s*UNLOCK\s+TABLES\b/i;

/** Pseudo-code used in the `changed` set and in the `session-state-restored` warning. */
const TABLE_LOCKS = 'TABLE LOCKS';

/**
 * True only when the statement itself is a top-level SET (possibly wrapped
 * in a MySQL executable comment), after ordinary leading comments.
 *
 * Session-variable names may occur verbatim inside INSERT values, routine
 * bodies and comments. Searching an entire successful statement for `SET`
 * would treat that inert text as a session mutation and could "clean it up"
 * by changing caller-owned state that the restore never touched.
 */
function isRootSetStatement(sql: string): boolean {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith('#')) {
      const newline = rest.search(/[\r\n]/);
      if (newline < 0) return false;
      rest = rest.slice(newline + 1).trimStart();
      continue;
    }
    const third = rest[2];
    if (rest.startsWith('--') && (third === undefined || third <= ' ')) {
      const newline = rest.search(/[\r\n]/);
      if (newline < 0) return false;
      rest = rest.slice(newline + 1).trimStart();
      continue;
    }
    if (rest.startsWith('/*') && !rest.startsWith('/*!') && !rest.startsWith('/*+')) {
      const close = rest.indexOf('*/', 2);
      if (close < 0) return false;
      rest = rest.slice(close + 2).trimStart();
      continue;
    }
    break;
  }
  return /^SET\b/i.test(rest) || /^\/\*!\d{0,6}\s*SET\b/i.test(rest);
}

export class RestoreSessionState {
  private readonly changed = new Set<string>();

  /** Records the session effects of a statement that executed successfully. */
  observe(sql: string): void {
    if (isRootSetStatement(sql)) {
      for (const guard of GUARD_PATTERNS) {
        if (guard.detect.test(sql)) {
          this.changed.add(guard.code);
        }
      }
      for (const restored of RESTORED_PATTERNS) {
        if (restored.detect.test(sql)) {
          this.changed.delete(restored.code);
        }
      }
    }
    // Anchored at the start of the statement: a `LOCK TABLES` mentioned inside
    // a routine body or a string is not one this session executed.
    if (LOCK_TABLES.test(sql)) {
      this.changed.add(TABLE_LOCKS);
    } else if (UNLOCK_TABLES.test(sql)) {
      this.changed.delete(TABLE_LOCKS);
    }
  }

  get pendingCount(): number {
    return this.changed.size;
  }

  /**
   * Best-effort restoration of the variables this restore changed but never
   * put back.
   *
   * Deliberately issued **without** the caller's `AbortSignal`: the usual
   * reason for being here is that the signal was just aborted, and reusing
   * it would make the cleanup throw before doing anything — guaranteeing the
   * leak it exists to prevent. Secondary failures are swallowed so they can
   * never mask the original outcome.
   */
  async restore(connection: MysqlConnection): Promise<readonly string[]> {
    const restored: string[] = [];

    // Released first: while a lock set is held, the session may only touch the
    // locked tables, so an `UNLOCK TABLES` that ran *after* the variable
    // restores would be fine — but doing it first also unblocks any session
    // waiting on those tables as early as possible.
    if (this.changed.has(TABLE_LOCKS)) {
      try {
        await executeStatement(connection, 'UNLOCK TABLES');
        restored.push(TABLE_LOCKS);
      } catch {
        // ignored: cleanup must never replace the real result or error
      }
    }

    for (const guard of GUARD_PATTERNS) {
      if (!this.changed.has(guard.code)) {
        continue;
      }
      try {
        await executeStatement(connection, guard.restore);
        restored.push(guard.code);
      } catch {
        // ignored: cleanup must never replace the real result or error
      }
    }
    this.changed.clear();
    return restored;
  }
}
