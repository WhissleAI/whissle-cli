// Process exit codes — the CLI's contract with a shell script.
//
// Everything used to exit 1, which meant a caller could tell "it failed" but
// never "why", and the three failures a script actually wants to branch on —
// the key is bad, the thing isn't there, the wallet is empty — were
// indistinguishable from a typo. These codes are stable and documented in
// `whissle help`; treat them as API.
//
// Deliberately NOT sysexits.h: 64/65/69 mean nothing to anyone reading a CI log,
// and small integers leave room to grow without colliding with the shell's own
// reserved range (126/127/128+n).

export const EXIT = {
  /** Success. */
  OK: 0,
  /** Anything we could not classify — a 4xx we don't map, a 5xx, a network error. */
  GENERIC: 1,
  /** Authentication or authorization: no key, rejected key, missing scope. */
  AUTH: 2,
  /** The addressed resource does not exist (or isn't visible to this key). */
  NOT_FOUND: 3,
  /** The workspace is out of credit (HTTP 402) — retrying will not help. */
  NO_CREDIT: 4,
};

/**
 * Map a thrown error to an exit code. Pure — exported for tests.
 *
 * 403 lands on AUTH with 401 on purpose: from a script's point of view "this key
 * is not allowed to do that" is the same class of problem as "this key is not
 * valid", and both are fixed by changing the key, not by retrying.
 */
export function exitCodeFor(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 402) return EXIT.NO_CREDIT;
  if (status === 404) return EXIT.NOT_FOUND;
  // Client-side auth failures never reach the network, so they carry no status.
  if (err && (err.code === "no_key" || err.code === "no_org")) return EXIT.AUTH;
  return EXIT.GENERIC;
}

/** The one-line summary printed in `whissle help`. */
export const EXIT_CODES_HELP =
  "Exit codes: 0 ok · 1 error · 2 auth (no/invalid key, missing scope) · 3 not found · 4 out of credit";
