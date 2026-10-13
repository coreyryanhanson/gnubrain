// Shared query-window dial between the two consumers — sqlScope (the
// injected LIMIT default for kb_query) and tools.ts (the per-KB search
// `pageSize`). A query window, not a spill budget: spill.ts owns
// inline-vs-spill shaping and does not consume it.

/** Shared limit constant: the injected query LIMIT default and the per-KB
 * search `pageSize`. */
export const RESULT_LIMIT = 64;
