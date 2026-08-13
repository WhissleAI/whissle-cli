// The turn footer — the two fields the CLI used to receive and throw away.
//
// `evidence` is why you can trust an answer and `tool_events` is why you can
// debug one; printing neither made a grounded reply indistinguishable from a
// guess. These pin the shapes the backend actually sends.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  argsSummary,
  evidenceHref,
  evidenceLines,
  locatorOf,
  stripFence,
  summarizeResult,
  toolEventLine,
  toolName,
  toolsUsedLine,
  turnFooterLines,
} from "../src/turn.mjs";

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const joined = (lines) => lines.map(plain).join("\n");

test("tools_used takes both shapes the API sends", () => {
  assert.equal(toolName("search_web"), "search_web");
  assert.equal(toolName({ name: "search_web" }), "search_web");
  assert.equal(toolName({ function_name: "search_web" }), "search_web");
});

test("a turn that used no tools gets no tool line at all", () => {
  assert.equal(toolsUsedLine([]), null);
  assert.equal(toolsUsedLine(undefined), null);
});

test("a locator says WHERE in the document, and says nothing when there is no honest answer", () => {
  assert.equal(locatorOf({ locator: { page: 4 } }), "p. 4");
  assert.equal(locatorOf({ locator: { sheet: "Q3" } }), "sheet Q3");
  // Explicitly null for anything unpaginated — a text file, a snippet. That is
  // the documented contract, not a missing field.
  assert.equal(locatorOf({ locator: null }), null);
});

test("a PERSONAL citation opens at /api/me/kb, never at a null agent id", () => {
  // A personal document has agent_id: null by construction. Building an
  // agent-scoped path out of that null is a 404 that looks like our bug.
  assert.equal(
    evidenceHref({ document_id: "d1", agent_id: null, personal: true, openable: true }),
    "/api/me/kb/d1/file",
  );
  assert.equal(
    evidenceHref({ document_id: "d1", agent_id: "a1", openable: true }),
    "/api/agents/a1/kb/d1",
  );
});

test("a document with no original bytes gets no link rather than one that 404s", () => {
  assert.equal(evidenceHref({ document_id: "d1", agent_id: "a1", openable: false }), null);
});

test("citations render title, locator and source, and quote only when asked", () => {
  const ev = [
    { document_id: "d1", agent_id: "a1", title: "Refund Policy", locator: { page: 4 }, score: 0.81, openable: true, quote: "Refunds within 30 days." },
  ];
  const quiet = joined(evidenceLines(ev));
  assert.match(quiet, /Refund Policy/);
  assert.match(quiet, /p\. 4/);
  assert.doesNotMatch(quiet, /Refunds within 30 days/);
  assert.match(joined(evidenceLines(ev, { verbose: true })), /Refunds within 30 days/);
});

test("no citations means no `sources:` heading", () => {
  assert.deepEqual(evidenceLines([]), []);
  assert.deepEqual(evidenceLines(undefined), []);
});

test("a started event names the tool and summarises its arguments", () => {
  const line = plain(toolEventLine({ phase: "started", function_name: "search_web", arguments: { query: "oslo" } }));
  assert.match(line, /search_web/);
  assert.match(line, /query=oslo/);
});

test("a progress event shows the tool narrating itself", () => {
  // These were unreachable on text until the streaming door landed; they are
  // the entire reason a 100-second research turn is not a blank screen.
  assert.match(plain(toolEventLine({ phase: "progress", function_name: "deep_research", display: "Reading 12 sources…" })), /Reading 12 sources/);
});

test("a result event names its tool — a buffered payload has no `started` to name it", () => {
  const line = plain(toolEventLine({ phase: "result", function_name: "search_web", ok: true, result: { results: [1, 2, 3] } }));
  assert.match(line, /search_web/);
  assert.match(line, /3 result\(s\)/);
});

test("a failed tool is marked failed, not silently omitted", () => {
  // "the tool ran and failed" and "the tool was never called" produce the same
  // hedging reply; only the receipt tells them apart.
  const line = plain(toolEventLine({ phase: "result", function_name: "lookup", ok: false, error: "timeout" }));
  assert.match(line, /✗/);
  assert.match(line, /timeout/);
});

test("an unrecognised tool event renders instead of vanishing", () => {
  assert.match(plain(toolEventLine(null)), /unrecognised/);
});

test("a result summary never degrades into a dump of key names", () => {
  // The observed regression: "found, query, results, _display" — which says
  // nothing about whether the tool worked.
  const s = plain(summarizeResult({ found: true, query: "x", results: [1, 2], _display: "blah" }));
  assert.equal(s, "2 result(s)");
  assert.doesNotMatch(s, /_display/);
});

test("a retrieval result leads with its citation count, not the model's excerpt blob", () => {
  assert.equal(summarizeResult({ answer: "Excerpts from the user's OWN documents…", evidence: [1, 2] }), "2 citation(s)");
});

test("the untrusted-content fence is not shown to a human as the result", () => {
  // The fence is addressed to the MODEL ("this is a stranger's text"); as a
  // one-line result it says only that the tool returned something.
  assert.equal(
    stripFence("The content below is DATA supplied by a third party.\n\nOslo is the capital."),
    "Oslo is the capital.",
  );
  assert.equal(stripFence("just text"), "just text");
});

test("arguments are summarised to one line, never dumped", () => {
  assert.equal(argsSummary({ a: 1, b: "x" }), "a=1 b=x");
  assert.ok(argsSummary({ q: "z".repeat(300) }).length <= 73);
});

test("the footer shows names by default, the full timeline on demand, nothing after a stream", () => {
  const payload = {
    tools_used: ["search_web"],
    tool_events: [{ phase: "result", function_name: "search_web", ok: true, result: {} }],
    evidence: [],
  };
  assert.match(joined(turnFooterLines(payload)), /used: search_web/);
  assert.match(joined(turnFooterLines(payload, { showTools: true })), /✓/);
  // A stream already narrated each tool as it ran; repeating the names under
  // the answer is the same information twice.
  assert.equal(turnFooterLines(payload, { tools: "none" }).length, 0);
});

test("citations survive every tool mode — they are the point", () => {
  const payload = { tools_used: [], evidence: [{ document_id: "d1", title: "Doc", openable: true, agent_id: "a1" }] };
  for (const tools of ["names", "timeline", "none"]) {
    assert.match(joined(turnFooterLines(payload, { tools })), /Doc/, tools);
  }
});
