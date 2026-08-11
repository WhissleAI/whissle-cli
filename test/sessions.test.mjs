// Unit tests for `whissle sessions` shaping (node:test, no network).
//
// The fixtures below are trimmed copies of REAL production payloads from
// `GET /api/sessions*` on aws-gateway-backend — same keys, same nesting,
// invented values. The trace renderer's whole value is that it reports a
// provider failover, an invented tool and an integrity catch when they happened
// and stays silent when they didn't, so those are what the assertions pin.
import test from "node:test";
import assert from "node:assert/strict";
import {
  traceEndpoints, groupByTurn, partitionEvents, summarize, listRow, sizeOf, ms,
  providerLabel, toolLines, llmLines, turnLines, eventLines,
} from "../src/commands/sessions.mjs";
import { EP } from "../src/endpoints.mjs";

const ev = (type, subsystem, data, seq = 0) => ({
  kind: "signal", v: 1, seq, t_ms: seq * 10, type, subsystem, derived: true, data,
});

// ── endpoint selection ───────────────────────────────────────────────────────

test("a text session only ever hits the unified trace route", () => {
  // /api/calls/{id}/trace would 404 on a conversation id and the error text
  // ("Call not found") would be actively misleading.
  assert.deepEqual(traceEndpoints("s1", "text"), ["/api/sessions/s1/trace"]);
});

test("a voice session falls back to the call-trace route", () => {
  assert.deepEqual(traceEndpoints("c1", "voice"), [
    EP.sessions.trace("c1"), EP.calls.trace("c1"),
  ]);
  // An unknown kind (no --kind given) tries both, in the same order.
  assert.deepEqual(traceEndpoints("c1", undefined), traceEndpoints("c1", "voice"));
});

// ── list rendering ───────────────────────────────────────────────────────────

test("a session's size is reported in its own units", () => {
  assert.equal(sizeOf({ duration_sec: 10, turn_count: null }), "10s");
  assert.equal(sizeOf({ duration_sec: null, turn_count: 1 }), "1 turn");
  assert.equal(sizeOf({ duration_sec: null, turn_count: 6 }), "6 turns");
  // Neither known is "—", never a fabricated 0.
  assert.equal(sizeOf({ duration_sec: null, turn_count: null }), "—");
});

test("the list row prefers `source` over `channel` for the VIA column", () => {
  // Both a CLI thread and an n8n step arrive on channel "api" with the same key;
  // `source` is the only field that tells them apart.
  const row = listRow({
    id: "abc", kind: "text", agent_name: "Tutor", channel: "api", source: "cli",
    status: "closed", duration_sec: null, turn_count: 2, created_at: "2026-08-10T22:59:56.1Z",
  });
  assert.deepEqual(row, ["abc", "text", "Tutor", "cli", "closed", "2 turns", "2026-08-10 22:59"]);
  // Voice carries no source — the channel answers instead of a blank cell.
  const voice = listRow({ id: "v", kind: "voice", channel: "web", source: null, status: "completed", duration_sec: 10, turn_count: null, created_at: "" });
  assert.equal(voice[3], "web");
});

// ── grouping ─────────────────────────────────────────────────────────────────

test("events group by turn, ascending, with pre-turn events first", () => {
  const groups = groupByTurn([
    ev("text_turn", "text_turn", { turn: 1 }, 3),
    ev("tool_call", "tools", { turn: 0, name: "a" }, 1),
    ev("flow_state", "flow", {}, 0),
    ev("llm_call", "llm", { turn: 0 }, 2),
  ]);
  assert.deepEqual(groups.map((g) => g.turn), [null, 0, 1]);
  // Order WITHIN a turn is the trace's own order, untouched.
  assert.deepEqual(groups[1].events.map((e) => e.type), ["tool_call", "llm_call"]);
});

test("the flow timeline is kept separate from the conversation timeline", () => {
  // The two carry independent clocks AND independent turn counters — a flow
  // "turn 1" and a text "turn 0" are routinely the same moment. Interleaving
  // them under one heading would assert an alignment nobody measured.
  const { main, flow } = partitionEvents([
    ev("flow_state", "flow", { turn: 1 }),
    ev("tool_call", "tools", { turn: 0 }),
    ev("text_turn", "text_turn", { turn: 0 }),
  ]);
  assert.deepEqual(main.map((e) => e.type), ["tool_call", "text_turn"]);
  assert.deepEqual(flow.map((e) => e.type), ["flow_state"]);
});

// ── the summary roll-up ──────────────────────────────────────────────────────

const TRACE = {
  call_id: "s1",
  kind: "text",
  flow: { available: false, turns: [] },
  signals: { available: true, channel: "text", turns: [], unavailable: { barge_in: "…" } },
  events: {
    available: true, source: "derived", events_total: 5,
    events: [
      ev("tool_call", "tools", { turn: 0, name: "search_knowledge_base", ok: true, duration_ms: 14, hop: 0, citations: [{ title: "Safety module" }] }, 0),
      ev("llm_call", "llm", { turn: 0, hop: 0, provider: "google", model: "gemini-2.5-flash", ok: false, failed_over: false, usage: { input_tokens: 10, output_tokens: 2 } }, 1),
      ev("llm_call", "llm", { turn: 0, hop: 1, provider: "claude", model: "claude-haiku-4-5", ok: true, failed_over: true, cause: "overloaded_error", attempts: ["google"], usage: { input_tokens: 100, output_tokens: 20 } }, 2),
      ev("tool_call", "tools", { turn: 1, name: "book_appointment", ok: false, unknown_tool: true }, 3),
      ev("text_turn", "text_turn", { turn: 0, latency_ms: 3800, hops: 2, provider: "claude", model: "claude-haiku-4-5", failed_over: true, input_tokens: 9997, output_tokens: 213, cached_input_tokens: 0, integrity: "claimed a booking no tool made", unknown_tools: ["book_appointment"] }, 4),
    ],
  },
};

test("summarize counts tool runs, failures and citations", () => {
  const s = summarize(TRACE);
  assert.equal(s.tools, 2);
  assert.equal(s.tools_failed, 1);
  assert.equal(s.citations, 1);
  assert.equal(s.llm_hops, 2);
  assert.equal(s.turns, 1);
});

test("a provider failover is reported once, not once per record", () => {
  // Both the llm_call hop AND the turn snapshot say `failed_over` for the same
  // turn. Reporting it twice would overstate how often the primary fell over.
  const s = summarize(TRACE);
  assert.equal(s.failovers.length, 1);
  assert.equal(s.failovers[0].answered, "claude/claude-haiku-4-5");
  assert.equal(s.failovers[0].cause, "overloaded_error");
  assert.deepEqual(s.providers, ["google/gemini-2.5-flash", "claude/claude-haiku-4-5"]);
});

test("an older thread with only the turn snapshot still reports its failover", () => {
  // Pre-migration-152 threads keep the snapshot but no per-hop llm_call list.
  const s = summarize({
    events: { events: [ev("text_turn", "text_turn", { turn: 0, provider: "claude", model: "m", failed_over: true })] },
  });
  assert.equal(s.failovers.length, 1);
  assert.equal(s.failovers[0].answered, "claude/m");
});

test("an invented tool is named once, from either source", () => {
  const s = summarize(TRACE);
  assert.deepEqual(s.unknown_tools, ["book_appointment"]);
});

test("an action-integrity catch is carried with its turn", () => {
  const s = summarize(TRACE);
  assert.equal(s.integrity.length, 1);
  assert.equal(s.integrity[0].turn, 0);
});

test("tokens come from the turn snapshot, never double-counted with the hops", () => {
  const s = summarize(TRACE);
  assert.deepEqual(s.tokens, { input: 9997, output: 213, cached: 0, seen: true });
});

test("tokens fall back to per-hop usage when no turn reported any", () => {
  const s = summarize({ events: { events: TRACE.events.events.slice(0, 3) } });
  assert.equal(s.tokens.input, 110);
  assert.equal(s.tokens.output, 22);
});

test("a clean trace claims no failover, no invented tool, no integrity catch", () => {
  const s = summarize({
    events: { events: [ev("text_turn", "text_turn", { turn: 0, provider: "google", model: "gemini-2.5-flash", latency_ms: 900 })] },
  });
  assert.deepEqual(s.failovers, []);
  assert.deepEqual(s.unknown_tools, []);
  assert.deepEqual(s.integrity, []);
});

test("summarize never throws on an empty or malformed trace", () => {
  for (const t of [null, {}, { events: null }, { events: { events: "nope" } }]) {
    assert.equal(summarize(t).tools, 0);
  }
});

// ── line rendering ───────────────────────────────────────────────────────────

test("a tool line carries name, outcome, duration and its citations", () => {
  const lines = toolLines({ name: "search_knowledge_base", ok: true, duration_ms: 14, hop: 0, args: "query=x", citations: [{ title: "Safety module" }] }).join("\n");
  assert.match(lines, /search_knowledge_base/);
  assert.match(lines, /✓/);
  assert.match(lines, /14ms/);
  assert.match(lines, /query=x/);
  assert.match(lines, /Safety module/);
});

test("an invented tool says so in words — ✗ alone means 'it failed'", () => {
  const lines = toolLines({ name: "book_appointment", ok: false, unknown_tool: true }).join("\n");
  assert.match(lines, /INVENTED/);
  assert.match(lines, /no such tool is registered/i);
});

test("a sensitive tool's redaction is stated, not silently empty", () => {
  assert.match(toolLines({ name: "charge_card", ok: true, sensitive: true }).join("\n"), /redacted/);
});

test("the LLM line names the provider that answered and flags a failover", () => {
  const clean = llmLines({ provider: "google", model: "gemini-2.5-flash", ok: true, latency_ms: 820, hop: 0 }).join("\n");
  assert.match(clean, /google\/gemini-2\.5-flash/);
  assert.doesNotMatch(clean, /FAILED OVER/);

  const over = llmLines({ provider: "claude", model: "claude-haiku-4-5", ok: true, failed_over: true, cause: "overloaded_error", attempts: ["google"] }).join("\n");
  assert.match(over, /FAILED OVER/);
  assert.match(over, /claude\/claude-haiku-4-5/);
  assert.match(over, /overloaded_error/);
});

test("the turn line reports latency, hops, provider, tokens and every flag", () => {
  const lines = turnLines({
    latency_ms: 3800, hops: 2, provider: "claude", model: "m", input_tokens: 9997,
    output_tokens: 213, tool_count: 1, max_hops_hit: true, empty_reply: true,
    integrity: "claimed a booking no tool made", unknown_tools: ["book_appointment"],
    failed_over: true,
  }).join("\n");
  assert.match(lines, /3\.8s/);
  assert.match(lines, /2 hops/);
  assert.match(lines, /claude\/m/);
  assert.match(lines, /in 9,997/);
  assert.match(lines, /FAILED OVER/);
  assert.match(lines, /hop ceiling/);
  assert.match(lines, /empty reply/);
  assert.match(lines, /INTEGRITY/);
  assert.match(lines, /INVENTED TOOLS.*book_appointment/);
});

test("an unrecognised event type still renders instead of vanishing", () => {
  // The signal schema is additive — a type this CLI has never heard of must
  // still appear on the timeline.
  const lines = eventLines(ev("some_future_signal", "whatever", { turn: 0, p: 0.5 }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /some_future_signal/);
});

test("voice event types render their own vocabulary", () => {
  assert.match(eventLines(ev("endpoint", "turn_completeness", { completeness_p: 0.7, bucket: "complete", stop_secs: 0.6 }))[0], /endpoint.*0\.7.*complete/);
  assert.match(eventLines(ev("barge_in", "voice_signals", { mode: "observed" }))[0], /barge-in/);
  assert.match(eventLines(ev("emotion", "whissle_metadata", { top_label: "calm", top_p: 0.82 }))[0], /calm 82%/);
});

test("providerLabel degrades to whichever half exists", () => {
  assert.equal(providerLabel({ provider: "claude", model: "m" }), "claude/m");
  assert.equal(providerLabel({ provider: "claude" }), "claude");
  assert.equal(providerLabel({ model: "m" }), "m");
  assert.equal(providerLabel({}), null);
});

test("durations render in human units", () => {
  assert.equal(ms(14), "14ms");
  assert.equal(ms(3800), "3.8s");
  assert.equal(ms(125000), "2m 05s");
  assert.equal(ms(null), null);
  assert.equal(ms("nope"), null);
});
