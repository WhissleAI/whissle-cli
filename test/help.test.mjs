// Unit tests for per-group help (node:test, no network).
// `whissle <group> --help` used to fall into arg parsing, so `whissle embed
// --help` tried to talk to the API instead of printing anything.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { helpFor } from "../bin/whissle.mjs";

// Every group the entry point can dispatch to. Kept as a literal list on
// purpose: if a group is added without a line in HELP, this test says so.
const GROUPS = [
  "agents", "chat", "companion", "calls", "sessions", "actions", "compliance", "kb", "tools",
  "connectors", "numbers", "integrations", "embed", "models", "keys", "team",
  "customers", "appointments", "sms", "analytics", "campaigns", "meetings",
  "memory", "usage", "config",
];

test("every dispatchable group has help of its own", () => {
  for (const g of GROUPS) {
    const help = helpFor(g);
    const own = help.split("\n").filter((l) => new RegExp(`^\\s+whissle ${g}(\\s|$)`).test(l));
    const alias = g === "config" && /whissle (login|logout|whoami)/.test(help);
    assert.ok(own.length > 0 || alias, `no help lines for group "${g}"`);
  }
});

test("a group's help contains its own commands and nobody else's", () => {
  const help = helpFor("sessions");
  assert.match(help, /whissle sessions list/);
  assert.match(help, /whissle sessions get/);
  assert.match(help, /whissle sessions trace/);
  assert.doesNotMatch(help, /whissle calls list/);
  assert.doesNotMatch(help, /whissle agents/);
});

test("a command's hanging-indent continuation comes with it", () => {
  // `calls start` wraps onto a second line; help that dropped it would hide
  // --var / --vars-file entirely.
  const help = helpFor("calls");
  assert.match(help, /whissle calls start/);
  assert.match(help, /--vars-file/);
});

test("the next section's sub-heading is not dragged in as a continuation", () => {
  // "Phone (numbers:read…)" heads the numbers commands, not the embed ones.
  const help = helpFor("embed");
  assert.match(help, /whissle embed token/);
  assert.doesNotMatch(help, /Phone/);
  assert.doesNotMatch(help, /whissle numbers/);
});

test("config help covers the three top-level identity verbs it serves", () => {
  const help = helpFor("config");
  for (const verb of ["login", "whoami", "config"]) {
    assert.match(help, new RegExp(`whissle ${verb}`));
  }
});

test("group help always states the global flags and the exit codes", () => {
  for (const g of ["sessions", "calls", "embed"]) {
    assert.match(helpFor(g), /--json/);
    assert.match(helpFor(g), /Exit codes: 0 ok/);
    assert.match(helpFor(g), /Full command map: whissle help/);
  }
});

test("an unknown group falls back to the whole command map", () => {
  const help = helpFor("definitely-not-a-group");
  assert.match(help, /whissle agents list/);
  assert.match(help, /whissle sessions list/);
});

test("the group list here matches what the entry point can actually dispatch", () => {
  // The failure this catches: a group registered in GROUPS but never given a
  // line in HELP, so `whissle <group> --help` silently prints the entire map.
  const src = readFileSync(new URL("../bin/whissle.mjs", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const GROUPS = {"), src.indexOf("};", src.indexOf("const GROUPS = {")));
  const dispatchable = [...block.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepEqual([...dispatchable].sort(), [...GROUPS].sort());
});

test("companion help names the scope and the streaming opt-out", () => {
  const help = helpFor("companion");
  assert.match(help, /companion:invoke/);
  assert.match(help, /--no-stream/);
  assert.match(help, /--session/);
});

test("kb help covers the personal knowledge base, not just an agent's", () => {
  assert.match(helpFor("kb"), /whissle kb me list/);
});
