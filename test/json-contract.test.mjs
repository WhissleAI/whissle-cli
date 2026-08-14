// The scripting contract, asserted rather than asserted-in-a-README.
//
// `whissle help` promises three things to anyone piping this CLI into anything:
//
//   1. `--json` on EVERY command prints JSON to stdout and nothing else.
//   2. Per-group `--help` is network-free — it must work with no key, no config
//      and no route to the gateway.
//   3. Exit codes are stable: 0 ok · 1 error · 2 auth · 3 not found · 4 no credit.
//
// The existing suites cover the pure helpers behind (2) and (3). Nothing covered
// the part that actually broke: a COMMAND that prints prose under `--json`, or
// that catches an ApiError to reword it and drops the status on the floor. Both
// are source-level properties, so they are checked at source level — no network,
// no fixtures, no gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const commandsDir = new URL("../src/commands/", import.meta.url);
const files = (await readdir(commandsDir)).filter((f) => f.endsWith(".mjs")).sort();
const sources = new Map(
  await Promise.all(files.map(async (f) => [f, await readFile(new URL(f, commandsDir), "utf8")])),
);

test("every command group can answer --json", () => {
  // `config` is the one group whose subcommands are local state (login, logout,
  // set); it still handles --json where it talks to the API (`whoami`).
  for (const [file, src] of sources) {
    assert.ok(
      /flags\.json/.test(src),
      `${file} never looks at --json; the contract says every command honours it`,
    );
  }
});

test("no mutation finishes with prose only under --json", () => {
  // The shape that broke it: `await del(...)` then a bare `ok(...)`. A route
  // that answers 204 still has to answer in JSON — `printMutation` is that.
  const offenders = [];
  for (const [file, src] of sources) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const write = /^\s*(?:const \w+ = )?await (del|post|put|patch)\(/.exec(line);
      if (!write) return;
      // Look at the handful of lines that follow: either the payload is printed
      // under --json, or this write is not the end of the subcommand.
      const after = lines.slice(i + 1, i + 6).join("\n");
      const before = lines.slice(Math.max(0, i - 6), i).join("\n");
      const ends = /^\s*ok\(/m.test(after);
      const speaks = /flags\.json/.test(after) || /flags\.json/.test(before);
      if (ends && !speaks) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `these mutations print only prose under --json:\n${offenders.join("\n")}`);
});

test("a caught API error keeps its exit code", () => {
  // `fatal()` defaults to 1. A command that catches an ApiError to say something
  // kinder must pass the mapped code through, or a 404 rephrased as
  // "already removed?" silently becomes exit 1 and a script can no longer tell
  // it from a bad key.
  const offenders = [];
  for (const [file, src] of sources) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!/e\.status === (401|402|403|404|409)/.test(line)) return;
      const stanza = lines.slice(i, i + 4).join("\n");
      if (/fatal\(/.test(stanza) && !/exitCodeFor\(e\)/.test(stanza)) {
        offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `these rephrase an API failure and lose its code:\n${offenders.join("\n")}`);
});

test("--json output is machine-readable before it is human-readable", () => {
  // `ok(...)` before `printJson(...)` in the same branch puts a ✓ line on
  // stdout ahead of the payload, and `jq` dies on line 1. Guard the ordering.
  const offenders = [];
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/^\s*ok\([^\n]*\n(?:[^\n]*\n){0,2}\s*if \(flags\.json\)/gm)) {
      offenders.push(`${file}: ok(...) printed before the --json payload`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ── the network-free half, exercised for real ────────────────────────────────

const bin = fileURLToPath(new URL("../bin/whissle.mjs", import.meta.url));

/** Run the CLI with no key, no config file and a base URL that cannot connect. */
function runOffline(args) {
  return execFileSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: "/nonexistent-whissle-test-home",
      WHISSLE_API_KEY: "",
      // If any of these opened a socket it would fail here rather than pass.
      WHISSLE_BASE_URL: "http://127.0.0.1:1",
      FORCE_COLOR: "0",
    },
  });
}

test("every group's --help works with no key, no config and no gateway", () => {
  const groups = [
    "agents", "chat", "companion", "calls", "sessions", "actions", "compliance",
    "kb", "tools", "connectors", "numbers", "integrations", "embed", "models",
    "keys", "team", "customers", "appointments", "sms", "analytics", "campaigns",
    "meetings", "memory", "usage", "config",
  ];
  for (const g of groups) {
    const help = runOffline([g, "--help"]);
    assert.match(help, new RegExp(`whissle ${g}`), `${g} --help did not describe ${g}`);
    // A group whose slice came out empty falls back to the whole map; that is a
    // silent failure, so check it did not.
    assert.ok(help.split("\n").length < 90, `${g} --help printed the entire command map`);
  }
});
