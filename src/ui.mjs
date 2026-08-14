// Terminal rendering helpers. Kept tiny + dependency-light (chalk for colour,
// marked + marked-terminal for the agent's markdown replies).

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { EXIT } from "./exit.mjs";

marked.use(markedTerminal({ reflowText: true, width: Math.min(process.stdout.columns || 80, 100) }));

export const c = chalk;
export const brand = chalk.hex("#e5484d"); // Whissle red accent
export const dim = chalk.dim;
export const bold = chalk.bold;

export const out = (s = "") => process.stdout.write(s + "\n");
export const err = (s = "") => process.stderr.write(s + "\n");

export function printJson(obj) {
  out(JSON.stringify(obj, null, 2));
}

/**
 * `--json` for a MUTATION: the server's payload when there is one, an explicit
 * acknowledgement when there isn't.
 *
 * Half the write routes on this API answer `204 No Content` — every DELETE, and
 * the attach/detach POSTs. Those commands used to print a green `✓` line and
 * nothing else under `--json`, so a script that piped them into `jq` got an
 * empty stream and failed at EOF, and one that captured stdout got a prose
 * sentence where JSON was promised. A route with nothing to say still has to say
 * it in the documented shape.
 */
export function printMutation(payload, ack) {
  printJson(payload && typeof payload === "object" ? payload : ack);
}

/** Render markdown (agent replies, transcripts) to the terminal. */
export function md(text) {
  try {
    return marked.parse(String(text ?? "")).trimEnd();
  } catch {
    return String(text ?? "");
  }
}

/** A compact key → value block. */
export function kv(obj, keys = Object.keys(obj)) {
  const w = Math.max(...keys.map((k) => k.length));
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    const v = obj[k] === null ? dim("—") : typeof obj[k] === "object" ? JSON.stringify(obj[k]) : String(obj[k]);
    out(`  ${dim(k.padEnd(w))}  ${v}`);
  }
}

/** A simple fixed-width table. rows = array of arrays; head = column labels. */
export function table(head, rows) {
  if (!rows.length) return out(dim("  (none)"));
  const cols = head.length;
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells, style = (x) => x) =>
    out("  " + cells.map((cell, i) => style(String(cell ?? "").padEnd(widths[i]))).join("  "));
  line(head, bold);
  line(widths.map((w) => "─".repeat(w)), dim);
  for (const r of rows) line(r.slice(0, cols));
}

/** Truncate for table cells. */
export const trunc = (s, n = 40) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function ok(msg) {
  out(chalk.green("✓ ") + msg);
}
export function warn(msg) {
  err(chalk.yellow("! ") + msg);
}
/**
 * Print a message and stop, with an exit code a script can branch on.
 *
 * The code is a PARAMETER because the commands that catch an ApiError to say
 * something kinder about it — "no such connector (already removed?)" — used to
 * throw the status away with it: a 404 that would have exited 3 through the
 * top-level handler exited 1 the moment a command improved its wording. Pass
 * `exitCodeFor(e)` whenever you are re-reporting a caught API failure.
 */
export function fatal(msg, code = EXIT.GENERIC) {
  err(chalk.red("✗ ") + msg);
  process.exit(code);
}

/** A minimal spinner for slow calls. Returns a stop() fn. */
export function spinner(label) {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stderr.write(`\r${brand(frames[i++ % frames.length])} ${dim(label)}`);
  }, 80);
  return () => {
    clearInterval(t);
    process.stderr.write("\r\x1b[K");
  };
}
