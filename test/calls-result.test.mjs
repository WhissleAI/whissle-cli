// Unit tests for the `calls result --wait` poll decision (node:test, no network).
// isTerminal() mirrors the backend's partner_result.TERMINAL_STATUSES contract:
// stop polling once `ready` flips true OR the status is terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { isTerminal } from "../src/commands/calls.mjs";

test("ready:true stops polling regardless of status", () => {
  assert.equal(isTerminal("in_progress", true), true);
  assert.equal(isTerminal(null, true), true);
  assert.equal(isTerminal(undefined, true), true);
});

test("terminal statuses stop polling even before ready flips", () => {
  for (const s of ["completed", "ended", "failed", "no-answer", "busy", "canceled", "cancelled"]) {
    assert.equal(isTerminal(s, false), true, `expected terminal: ${s}`);
  }
});

test("status matching is case-insensitive", () => {
  assert.equal(isTerminal("Completed", false), true);
  assert.equal(isTerminal("NO-ANSWER", false), true);
});

test("in-flight statuses keep polling", () => {
  for (const s of ["queued", "ringing", "in_progress", "in-progress", "", null, undefined]) {
    assert.equal(isTerminal(s, false), false, `expected non-terminal: ${s}`);
  }
});

test("only a real boolean true counts as ready", () => {
  assert.equal(isTerminal("in_progress", "true"), false); // string, not boolean
  assert.equal(isTerminal("in_progress", 1), false);
  assert.equal(isTerminal("in_progress", undefined), false);
});
