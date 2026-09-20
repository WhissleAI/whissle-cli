// The documents, asserted rather than trusted.
//
// A stale example is a bug. Two shipped in 1.5.0 and neither test nor reader
// caught them: the README offered `whissle analytics query --start/--end` (the
// command reads `--since`/`--until` and maps them onto the query's `start`/`end`
// — so the documented flags parsed fine and did nothing), and `whissle keys
// create --type secret|publishable` (the command reads `--publishable`). Both
// are the same failure: a flag that exists in prose and nowhere in the source.
//
// So: every `--flag` this repo's documents show on a `whissle <group> …` line
// must be a flag that `src/commands/<group>.mjs` — or a module it imports —
// actually reads. Source-level, no network, no fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const commandsDir = new URL("src/commands/", root);

const read = (u) => readFile(u, "utf8");

/** Every local module a command file pulls in, so a helper's flags count too. */
async function corpusFor(group) {
  const self = await read(new URL(`${group}.mjs`, commandsDir));
  let text = self;
  for (const m of self.matchAll(/from\s+"\.\.\/([\w./-]+\.mjs)"/g)) {
    try {
      text += "\n" + (await read(new URL(`src/${m[1]}`, root)));
    } catch {
      /* not a local module we can read — skip */
    }
  }
  return text;
}

/**
 * The flag names a source actually reads. Deliberately generous about HOW a
 * flag is read — `flags.x`, `flags["x"]`, a quoted literal handed to a helper
 * (`str("context")`), or a key of a `*FLAGS` lookup table (`timezone: [...]`) —
 * and deliberately strict about WHAT counts: a bare object key like
 * `start: flags.since` is the REQUEST field, not the flag, so it does not.
 */
export function flagsRead(src) {
  const found = new Set();
  for (const m of src.matchAll(/flags\.([A-Za-z_$][\w$]*)/g)) found.add(m[1]);
  for (const m of src.matchAll(/flags\[\s*["']([^"']+)["']\s*\]/g)) found.add(m[1]);
  // A quoted literal anywhere: `str("context")`, `["name", "display_name"]`.
  for (const m of src.matchAll(/["']([a-z][a-z0-9-]*)["']/g)) found.add(m[1]);
  // Keys of a flag lookup table (`const RULE_FLAGS = { name: [...], … }`).
  for (const t of src.matchAll(/const\s+[A-Z_]*FLAGS\s*=\s*\{([\s\S]*?)\n\};/g)) {
    for (const k of t[1].matchAll(/^\s*["']?([a-z][a-z0-9-]*)["']?\s*:/gm)) found.add(k[1]);
  }
  return found;
}

/** `--flag` tokens on a documented `whissle <group> …` line. */
export function documentedFlags(line) {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /whissle ([a-z]+)\b(.*)$/.exec(plain);
  if (!m) return null;
  return { group: m[1], flags: [...m[2].matchAll(/--([a-z][a-z0-9-]*)/g)].map((f) => f[1]) };
}

// Parsed in bin/whissle.mjs before any group sees them.
const GLOBAL = new Set(["json", "base-url", "key", "help"]);

const groups = new Set(
  (await readdir(commandsDir)).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, "")),
);
// The three identity verbs config.mjs also serves.
const ALIAS = { login: "config", logout: "config", whoami: "config" };

const DOCS = [
  "README.md",
  "bin/whissle.mjs", // the HELP string — the same promise, made at the prompt
  "examples/README.md",
  "examples/onboarding/README.md",
  "examples/campaigns/README.md",
  "examples/tests/README.md",
];

test("every flag the documents show is a flag the command reads", async () => {
  const corpus = new Map();
  const offenders = [];
  for (const doc of DOCS) {
    let text;
    try {
      text = await read(new URL(doc, root));
    } catch {
      continue; // a document this repo no longer owns
    }
    text.split("\n").forEach((line, i) => {
      const d = documentedFlags(line);
      if (!d) return;
      const group = ALIAS[d.group] || d.group;
      if (!groups.has(group)) return; // `whissle help`, `whissle version`
      for (const flag of d.flags) {
        if (GLOBAL.has(flag)) continue;
        offenders.push({ doc, line: i + 1, group, flag });
      }
    });
  }
  const unread = [];
  for (const o of offenders) {
    if (!corpus.has(o.group)) corpus.set(o.group, flagsRead(await corpusFor(o.group)));
    if (!corpus.get(o.group).has(o.flag)) {
      unread.push(`${o.doc}:${o.line}  whissle ${o.group} … --${o.flag}`);
    }
  }
  assert.deepEqual(
    [...new Set(unread)],
    [],
    `documented flags that src/commands/<group>.mjs never reads:\n${[...new Set(unread)].join("\n")}`,
  );
});

test("the flag reader sees each way a command reads a flag, and no more", () => {
  const src = `
    const RULE_FLAGS = { name: ["name", "str"], "window-hours": ["window_hours", "int"] };
    const a = flags.diarize;
    const b = flags["cost-center"];
    const c = str("context");
    const query = { start: flags.since };
  `;
  const read = flagsRead(src);
  for (const f of ["name", "window-hours", "diarize", "cost-center", "context", "since"]) {
    assert.ok(read.has(f), `should see --${f}`);
  }
  // `start:` is the REQUEST field the command maps --since onto. Counting it
  // would have let `whissle analytics query --start` pass review, which is the
  // exact bug this file exists to stop.
  assert.ok(!read.has("start"), "a bare request-field key is not a flag");
});

test("a documented line yields its group and its flags", () => {
  assert.deepEqual(documentedFlags("  whissle models transcribe call.wav --language en --diarize"), {
    group: "models",
    flags: ["language", "diarize"],
  });
  assert.equal(documentedFlags("nothing to see here"), null);
});
