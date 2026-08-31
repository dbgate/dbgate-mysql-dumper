import { quoteDefiner } from '../security/identifiers.js';
import type { DefinerPolicy } from './types.js';

/**
 * Matches a `DEFINER=` clause in `SHOW CREATE ...` output.
 *
 * MySQL always renders the clause in exactly one shape — the keyword, `=`,
 * a backtick-quoted user, `@`, a backtick-quoted host — so this matches the
 * server's own output rather than trying to parse arbitrary user SQL. Both
 * parts are matched with the doubled-backtick escape MySQL uses, so an
 * account whose name contains a backtick is handled.
 */
const DEFINER_CLAUSE = /\bDEFINER\s*=\s*`(?:[^`]|``)*`@`(?:[^`]|``)*`\s*/i;

/**
 * Applies the caller's {@link DefinerPolicy} to one `SHOW CREATE ...`
 * statement.
 *
 * Rewriting is done on the server's own rendered text rather than by
 * reassembling the statement from catalog fields: the text is authoritative,
 * and every alternative risks losing a clause this package does not model.
 *
 * `'best-effort'` renders identically to `'preserve'` — it only changes what
 * *restore* does when the definer account is missing, which is a runtime
 * decision the rendered SQL cannot express.
 */
export function applyDefinerPolicy(createSql: string, policy: DefinerPolicy): string {
  if (policy === 'preserve' || policy === 'best-effort') {
    return createSql;
  }
  if (policy === 'strip') {
    return createSql.replace(DEFINER_CLAUSE, '');
  }
  return createSql.replace(DEFINER_CLAUSE, 'DEFINER=CURRENT_USER ');
}

/** True when `createSql` carries a `DEFINER` clause, for diagnostics. */
export function hasDefinerClause(createSql: string): boolean {
  return DEFINER_CLAUSE.test(createSql);
}

/** Renders a `DEFINER=` clause from a catalog `user@host` value. */
export function renderDefinerClause(definer: string): string {
  return `DEFINER=${quoteDefiner(definer)}`;
}
