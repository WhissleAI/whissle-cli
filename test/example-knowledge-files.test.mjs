// An agent package that names a knowledge file it does not ship is broken in the
// worst way: `agents create --file` uploads what it can and the agent goes live
// missing most of its grounding, with nothing failing loudly. That is not
// hypothetical — the ApplianceCare package spent several commits pointing at five
// invented manuals (northwind-*, larkfield-*, vantis-*) long after the real Bosch,
// LG and Miele extracts had replaced them on disk.
//
// This walks every example agent.json, so a new package gets the same guarantee.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "agents");

function agentPackages() {
  if (!existsSync(EXAMPLES)) return [];
  return readdirSync(EXAMPLES)
    .map((name) => join(EXAMPLES, name, "agent.json"))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

test("every example agent.json exists and parses", () => {
  const packages = agentPackages();
  assert.ok(packages.length > 0, "no example agent packages found");
  for (const path of packages) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(path, "utf8")),
      `${path} is not valid JSON`,
    );
  }
});

test("every knowledge file an example references exists on disk", () => {
  const missing = [];
  for (const path of agentPackages()) {
    const spec = JSON.parse(readFileSync(path, "utf8"));
    const base = dirname(path);
    for (const entry of spec.knowledge || []) {
      // A knowledge entry is a file, a --text body, or a --url; only files resolve.
      if (!entry.file) continue;
      if (!existsSync(resolve(base, entry.file))) {
        missing.push(`${spec.name || path}: ${entry.file}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `agent.json references knowledge file(s) that do not exist:\n  ${missing.join("\n  ")}`,
  );
});

test("every knowledge file shipped is referenced by its agent.json", () => {
  // The reverse direction: an orphan file is a manual the agent will never be
  // grounded in, which reads as a missing answer rather than a missing file.
  const orphans = [];
  for (const path of agentPackages()) {
    const spec = JSON.parse(readFileSync(path, "utf8"));
    const dir = join(dirname(path), "knowledge");
    if (!existsSync(dir)) continue;
    const referenced = new Set(
      (spec.knowledge || [])
        .filter((e) => e.file)
        .map((e) => resolve(dirname(path), e.file)),
    );
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (!statSync(full).isFile()) continue;
      if (!referenced.has(full)) orphans.push(`${spec.name || path}: ${name}`);
    }
  }
  assert.deepEqual(
    orphans,
    [],
    `knowledge file(s) shipped but never referenced:\n  ${orphans.join("\n  ")}`,
  );
});

test("the ApplianceCare package names its real manufacturers, not the retired invented ones", () => {
  const path = join(EXAMPLES, "appliance-care", "agent.json");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const retired of ["Northwind", "Larkfield", "Vantis", "NW-2200", "NW-2400", "LF-W70", "VT-500"]) {
    assert.ok(!raw.includes(retired), `agent.json still mentions the retired ${retired}`);
  }
  for (const real of ["Bosch", "LG", "Miele"]) {
    assert.ok(raw.includes(real), `agent.json no longer mentions ${real}`);
  }
});
