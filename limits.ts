// Shared query-window dial: the injected LIMIT default for kb_query and
// the per-KB search `pageSize`. Lives apart from spill.ts so SQL
// certification (sqlScope) can stay a pure layer — no kernel, no pi.

/** Shared limit constant: the injected query LIMIT default and the per-KB
 * search `pageSize`. */
export const RESULT_LIMIT = 64;
