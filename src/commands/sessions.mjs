// whissle sessions list|get|trace
//
// `calls` means "rows from the calls table". A session with an agent is no
// longer always a call: a CLI run, an embedded widget, an n8n step and a partner
// integration all persist a TEXT thread that `/api/calls` structurally cannot
// see. `/api/sessions` is the union of both, with a `kind` discriminator
// (`voice` | `text`), and it needs the same `calls:read` scope — no key has to
// be re-issued to stop losing half its history.
//
// `trace` is the interesting one. It is the only place in the product where a
// human can see WHICH PROVIDER ACTUALLY ANSWERED — and, when the primary vendor
// fell over mid-turn, that it failed over at all. Alongside it: every tool run
// with its arguments, duration and outcome, the KB citations a lookup raised,
// per-turn token cost and latency, and the two integrity findings that say the
// model claimed something no tool did (`integrity`) or invented a tool that does
// not exist (`unknown_tools`).
import { get, ApiError } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, kv, trunc, dim, bold, brand, md, printJson, fatal } from "../ui.mjs";

/** How many turns the timeline renders by default (tail). `--all` lifts it. */
export const DEFAULT_TURNS = 20;

// ── pure helpers (exported for tests) ────────────────────────────────────────

/**
 * The trace paths to try, in order, for a session of this kind.
 *
 * `/api/sessions/{id}/trace` is kind-agnostic — for a voice session the backend
 * delegates to the call-trace handler and returns its payload verbatim (verified
 * against production: the two responses are byte-identical). The direct
 * `/api/calls/{id}/trace` stays in the list for voice as a fallback, so a call id
 * the union view cannot resolve still traces instead of 404-ing.
 */
export function traceEndpoints(id, kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "text") return [EP.sessions.trace(id)];
  return [EP.sessions.trace(id), EP.calls.trace(id)];
}

/** `null` → "—"; numbers get thousands separators. */
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : v);

/** ms → a human duration ("820ms", "4.1s", "2m 03s"). */
export function ms(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const s = Math.round(value / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The size of a session in its own units: seconds for voice, turns for text. */
export function sizeOf(item) {
  if (item.duration_sec != null) return `${item.duration_sec}s`;
  if (item.turn_count != null) return `${item.turn_count} turn${item.turn_count === 1 ? "" : "s"}`;
  return "—";
}

/** One list row. Exported so the column contract is testable without a network. */
export function listRow(item) {
  return [
    item.id,
    item.kind || "—",
    trunc(item.agent_name || item.agent_id || "—", 20),
    // How it reached the agent. `source` is the finer answer for text (it is the
    // only thing that tells a CLI thread from an n8n one — both arrive on the
    // `api` channel with the same key), `channel` is all voice has.
    trunc(item.source || item.channel || "—", 10),
    item.status || "—",
    sizeOf(item),
    String(item.created_at || "").slice(0, 16).replace("T", " "),
  ];
}

/**
 * Split a trace's events into the two families that keep INDEPENDENT clocks.
 *
 * The backend merges the conversation record (message wall-clock) with the flow
 * state machine's own monotonic `ts_ms`, and says in as many words that the
 * cross-source alignment is approximate. Their turn counters are separate
 * enumerations too — a flow "turn 1" and a text "turn 0" can be the same moment.
 * So they are rendered as two timelines rather than interleaved under one turn
 * heading, which would assert an alignment nobody measured.
 */
export function partitionEvents(events) {
  const main = [], flow = [];
  for (const ev of Array.isArray(events) ? events : []) {
    (ev && ev.subsystem === "flow" ? flow : main).push(ev);
  }
  return { main, flow };
}

/**
 * Group a flat event list into per-turn buckets, ascending by turn.
 *
 * Events with no turn (a pre-turn flow entry) bucket under `turn: null` and sort
 * FIRST — they happened before any turn — rather than being dropped. Order
 * within a bucket is the trace's own order, untouched.
 */
export function groupByTurn(events) {
  const groups = [];
  const byTurn = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const t = ev && ev.data && Number.isInteger(ev.data.turn) ? ev.data.turn : null;
    const key = t === null ? "_none" : t;
    let g = byTurn.get(key);
    if (!g) {
      g = { turn: t, events: [] };
      byTurn.set(key, g);
      groups.push(g);
    }
    g.events.push(ev);
  }
  return groups.sort((a, b) => (a.turn ?? -Infinity) - (b.turn ?? -Infinity));
}

/** `provider/model`, or whichever half exists. */
export function providerLabel(d) {
  const p = d && d.provider;
  const m = d && d.model;
  if (p && m) return `${p}/${m}`;
  return p || m || null;
}

/**
 * Roll the whole trace up into the numbers worth printing under it.
 *
 * Token accounting prefers the TURN snapshot over per-hop `llm_call` events:
 * both are present on a modern thread and adding them would double-count. Only
 * when no turn reported usage do the hops get summed.
 */
export function summarize(trace) {
  const events = ((trace && trace.events) || {}).events || [];
  const sum = {
    turns: 0,
    tools: 0,
    tools_failed: 0,
    unknown_tools: [],
    failovers: [],
    providers: [],
    integrity: [],
    citations: 0,
    tokens: { input: 0, output: 0, cached: 0 },
    llm_hops: 0,
  };
  const providers = new Set();
  const turnTokens = { input: 0, output: 0, cached: 0, seen: false };
  const hopTokens = { input: 0, output: 0, cached: 0, seen: false };
  const failoverTurns = new Set();

  const addUnknown = (name) => {
    if (name && !sum.unknown_tools.includes(name)) sum.unknown_tools.push(name);
  };
  const addUsage = (bucket, u) => {
    if (!u || typeof u !== "object") return;
    const i = u.input_tokens, o = u.output_tokens, ca = u.cache_read_input_tokens;
    if (typeof i === "number") { bucket.input += i; bucket.seen = true; }
    if (typeof o === "number") { bucket.output += o; bucket.seen = true; }
    if (typeof ca === "number") { bucket.cached += ca; bucket.seen = true; }
  };

  for (const ev of events) {
    const d = (ev && ev.data) || {};
    const label = providerLabel(d);
    if (ev.type === "tool_call") {
      sum.tools++;
      if (d.ok === false) sum.tools_failed++;
      if (d.unknown_tool === true) addUnknown(d.name);
      if (Array.isArray(d.citations)) sum.citations += d.citations.length;
    } else if (ev.type === "llm_call") {
      sum.llm_hops++;
      if (label) providers.add(label);
      addUsage(hopTokens, d.usage);
      if (d.failed_over) {
        failoverTurns.add(d.turn ?? null);
        sum.failovers.push({
          turn: d.turn ?? null, hop: d.hop ?? null, answered: label,
          cause: d.cause || null, attempts: d.attempts || null,
        });
      }
    } else if (ev.type === "text_turn") {
      sum.turns++;
      if (label) providers.add(label);
      if (typeof d.input_tokens === "number") { turnTokens.input += d.input_tokens; turnTokens.seen = true; }
      if (typeof d.output_tokens === "number") { turnTokens.output += d.output_tokens; turnTokens.seen = true; }
      if (typeof d.cached_input_tokens === "number") { turnTokens.cached += d.cached_input_tokens; turnTokens.seen = true; }
      if (Array.isArray(d.unknown_tools)) d.unknown_tools.forEach(addUnknown);
      if (d.integrity) sum.integrity.push({ turn: d.turn ?? null, detail: d.integrity });
      // A turn can report a failover the hop events don't (an older thread keeps
      // the snapshot but not the per-hop list). Don't report the same one twice.
      if (d.failed_over && !failoverTurns.has(d.turn ?? null)) {
        failoverTurns.add(d.turn ?? null);
        sum.failovers.push({ turn: d.turn ?? null, hop: null, answered: label, cause: null, attempts: null });
      }
    }
  }
  sum.providers = [...providers];
  sum.tokens = turnTokens.seen ? turnTokens : hopTokens;
  return sum;
}

// ── event rendering ──────────────────────────────────────────────────────────

const TOKENS = (d) => {
  const bits = [];
  if (typeof d.input_tokens === "number") bits.push(`in ${n(d.input_tokens)}`);
  if (typeof d.output_tokens === "number") bits.push(`out ${n(d.output_tokens)}`);
  if (typeof d.cached_input_tokens === "number") bits.push(`cached ${n(d.cached_input_tokens)}`);
  if (typeof d.thinking_tokens === "number") bits.push(`thinking ${n(d.thinking_tokens)}`);
  return bits.join(" · ");
};

function usageBits(u) {
  if (!u || typeof u !== "object") return "";
  return TOKENS({
    input_tokens: u.input_tokens, output_tokens: u.output_tokens,
    cached_input_tokens: u.cache_read_input_tokens, thinking_tokens: u.thinking_tokens,
  });
}

/** A `tool_call` event → its lines. Exported for tests (colour-free content). */
export function toolLines(d) {
  const lines = [];
  const invented = d.unknown_tool === true;
  const mark = invented ? "✗" : d.ok === false ? "✗" : d.ok === true ? "✓" : "·";
  const bits = [];
  if (ms(d.duration_ms)) bits.push(ms(d.duration_ms));
  if (Number.isInteger(d.hop)) bits.push(`hop ${d.hop}`);
  lines.push(`🔧 ${d.name || "(unnamed tool)"}  ${mark}${bits.length ? "  " + bits.join(" · ") : ""}`);
  if (invented) {
    // The finding, not a number: "it invented book_appointment" is a fact about
    // the agent; "1 unknown tool" is trivia. `ok:false` cannot carry this — a
    // tool that ran and failed says exactly the same thing.
    lines.push(`   INVENTED — no such tool is registered; nothing ran, and it is not in tools_used`);
  }
  if (d.sensitive) lines.push(`   sensitive tool — arguments and result are redacted`);
  if (d.args != null) lines.push(`   args  ${trunc(typeof d.args === "string" ? d.args : JSON.stringify(d.args), 120)}`);
  if (d.display) lines.push(`   →     ${trunc(String(d.display), 120)}`);
  for (const cite of Array.isArray(d.citations) ? d.citations : []) {
    const t = cite && typeof cite === "object" ? (cite.title || cite.doc_title || cite.source || cite.id) : cite;
    const u = cite && typeof cite === "object" ? (cite.url || cite.uri || cite.source_url) : null;
    lines.push(`   cite  ${trunc(String(t ?? "(untitled)"), 80)}${u ? dim(`  ${u}`) : ""}`);
  }
  return lines;
}

/** An `llm_call` event → its lines. The failover marker lives here. */
export function llmLines(d) {
  const lines = [];
  const bits = [];
  if (ms(d.latency_ms)) bits.push(ms(d.latency_ms));
  if (Number.isInteger(d.hop)) bits.push(`hop ${d.hop}`);
  const u = usageBits(d.usage);
  if (u) bits.push(u);
  if (d.stop_reason) bits.push(String(d.stop_reason));
  const mark = d.ok === false ? "✗" : d.ok === true ? "✓" : "·";
  lines.push(`🧠 ${providerLabel(d) || "(provider unknown)"}  ${mark}${bits.length ? "  " + bits.join(" · ") : ""}`);
  if (d.failed_over) {
    const why = [];
    if (d.attempts) why.push(`after ${Array.isArray(d.attempts) ? d.attempts.join(", ") : d.attempts}`);
    if (d.cause) why.push(`cause: ${d.cause}`);
    lines.push(`   ⚑ FAILED OVER — ${providerLabel(d) || "the fallback provider"} answered${why.length ? ` (${why.join("; ")})` : ""}`);
  }
  return lines;
}

/** A `text_turn` snapshot → the turn's outcome line(s). */
export function turnLines(d) {
  const lines = [];
  const bits = [];
  if (ms(d.latency_ms)) bits.push(ms(d.latency_ms));
  if (Number.isInteger(d.hops)) bits.push(`${d.hops} hop${d.hops === 1 ? "" : "s"}`);
  const label = providerLabel(d);
  if (label) bits.push(label);
  const tok = TOKENS(d);
  if (tok) bits.push(tok);
  if (Number.isInteger(d.tool_count)) bits.push(`${d.tool_count} tool${d.tool_count === 1 ? "" : "s"}${d.tools_failed ? `, ${d.tools_failed} failed` : ""}`);
  if (d.flow_state) bits.push(`state ${d.flow_state}`);
  lines.push(`⏱ turn${bits.length ? "  " + bits.join(" · ") : ""}`);
  if (d.failed_over) lines.push(`   ⚑ FAILED OVER — this turn was answered by ${label || "the fallback provider"}, not the primary`);
  if (d.max_hops_hit) lines.push(`   ! hit the hop ceiling — the reply may be truncated mid-plan`);
  if (d.empty_reply) lines.push(`   ! the model returned an empty reply`);
  if (d.failed) lines.push(`   ! the turn failed${d.error ? `: ${trunc(String(d.error), 100)}` : ""}`);
  if (d.integrity) lines.push(`   ⚠ INTEGRITY — ${trunc(typeof d.integrity === "string" ? d.integrity : JSON.stringify(d.integrity), 160)}`);
  if (Array.isArray(d.unknown_tools) && d.unknown_tools.length) {
    lines.push(`   ⚠ INVENTED TOOLS — ${d.unknown_tools.join(", ")}`);
  }
  if (d.flow_ended) lines.push(`   flow ended`);
  return lines;
}

/** Voice-side event types + the generic fallback for anything new. */
function voiceLines(ev, d) {
  switch (ev.type) {
    case "flow_state":
      return [`▸ state  ${d.state || "?"}${d.state_type ? dim(` (${d.state_type})`) : ""}${d.guard ? `  guard ${d.guard}` : ""}${d.reason ? dim(`  ${d.reason}`) : ""}`];
    case "flow_transition":
      return [`→ ${d.result === "fired" ? bold("fired") : d.result || "checked"}  ${d.from || "?"} → ${d.to || "?"}${d.transition_id ? dim(`  ${d.transition_id}`) : ""}`];
    case "endpoint":
      return [`⏸ endpoint  p=${d.completeness_p}${d.bucket ? ` (${d.bucket})` : ""}${d.stop_secs != null ? ` · stop ${d.stop_secs}s` : ""}`];
    case "barge_in":
      return [`✋ barge-in${d.mode ? `  ${d.mode}` : ""}`];
    case "shadow_draft":
      return [`👻 shadow draft  ${d.drafted ? "drafted" : "no draft"}${Array.isArray(d.predicted_tools) && d.predicted_tools.length ? ` · predicted ${d.predicted_tools.join(", ")}` : ""}`];
    case "emotion":
    case "intent": {
      const top = d.top_label ? `${d.top_label}${d.top_p != null ? ` ${Math.round(d.top_p * 100)}%` : ""}` : "?";
      return [`🎚 ${ev.type}  ${top}${d.changed ? `  (was ${d.prev_label})` : ""}${d.flips ? dim(`  flips ${d.flips}`) : ""}`];
    }
    case "hesitation":
      return [`… hesitation  ${trunc(JSON.stringify(d), 100)}`];
    default:
      return [`· ${ev.type}  ${dim(trunc(JSON.stringify(d), 100))}`];
  }
}

/** One event → the lines that render it. */
export function eventLines(ev) {
  const d = (ev && ev.data) || {};
  if (ev.type === "tool_call") return toolLines(d);
  if (ev.type === "llm_call") return llmLines(d);
  if (ev.type === "text_turn") return turnLines(d);
  return voiceLines(ev, d);
}

// ── renderers ────────────────────────────────────────────────────────────────

function renderTimeline(events, { turns: maxTurns, label = "turn" }) {
  const groups = groupByTurn(events);
  const shown = maxTurns > 0 && groups.length > maxTurns ? groups.slice(-maxTurns) : groups;
  if (shown.length < groups.length) {
    out(dim(`  (showing the last ${shown.length} of ${groups.length} turns — --all for every turn)`));
  }
  for (const g of shown) {
    const head = g.turn === null ? "before the first turn" : `${label} ${g.turn}`;
    out("");
    out("  " + bold(head) + dim(" " + "─".repeat(Math.max(4, 46 - head.length))));
    for (const ev of g.events) {
      for (const [i, line] of eventLines(ev).entries()) {
        out("    " + (i === 0 ? colourize(ev, line) : dim(line)));
      }
    }
  }
}

/** Colour the headline of an event by what it means. Content is unchanged. */
function colourize(ev, line) {
  const d = (ev && ev.data) || {};
  if (ev.type === "tool_call") return d.unknown_tool === true || d.ok === false ? brand(line) : line;
  if (ev.type === "llm_call" || ev.type === "text_turn") return d.failed_over ? brand(line) : line;
  return line;
}

function renderSignalsOnly(trace) {
  // A voice session predating the event stream still has per-turn snapshots, and
  // they are the whole record — render them rather than reporting "nothing".
  const turns = (trace.signals || {}).turns || [];
  out("");
  out("  " + bold("per-turn signals") + dim(`  (${(trace.signals || {}).turns_total ?? turns.length} turns)`));
  for (const [i, t] of turns.entries()) {
    const bits = Object.entries(t)
      .filter(([k, v]) => k !== "ts" && k !== "at" && v !== null && v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
    out("    " + dim(String(i).padStart(3)) + "  " + trunc(bits.join(" · "), 150));
  }
}

function renderSummary(trace, sum) {
  const rows = {};
  if (sum.turns) rows.turns = String(sum.turns);
  if (sum.tools) rows["tool runs"] = `${sum.tools}${sum.tools_failed ? `  (${sum.tools_failed} failed)` : ""}`;
  if (sum.citations) rows.citations = String(sum.citations);
  if (sum.llm_hops) rows["llm hops"] = String(sum.llm_hops);
  if (sum.providers.length) rows.providers = sum.providers.join(", ");
  if (sum.tokens.input || sum.tokens.output || sum.tokens.cached) {
    rows.tokens = [
      sum.tokens.input ? `in ${n(sum.tokens.input)}` : null,
      sum.tokens.output ? `out ${n(sum.tokens.output)}` : null,
      sum.tokens.cached ? `cached ${n(sum.tokens.cached)}` : null,
    ].filter(Boolean).join(" · ");
  }
  if (Object.keys(rows).length) {
    out("\n" + bold("Summary"));
    kv(rows);
  }
  // The three findings that are worth interrupting someone for.
  if (sum.failovers.length) {
    out("\n" + brand("⚑ provider failover") + dim(`  ${sum.failovers.length}×`));
    for (const f of sum.failovers) {
      out(`  turn ${f.turn ?? "—"}${f.hop != null ? ` hop ${f.hop}` : ""}  answered by ${f.answered || "the fallback provider"}${f.cause ? dim(`  (${f.cause})`) : ""}`);
    }
    out(dim("  Nothing else in the product shows this — the reply looked normal to the caller."));
  }
  if (sum.unknown_tools.length) {
    out("\n" + brand("⚠ tools the model invented") + `  ${sum.unknown_tools.join(", ")}`);
    out(dim("  No such tool is registered. Nothing ran — and it never entered tools_used."));
  }
  if (sum.integrity.length) {
    out("\n" + brand("⚠ action-integrity catches") + dim(`  ${sum.integrity.length}`));
    for (const i of sum.integrity) {
      out(`  turn ${i.turn ?? "—"}  ${trunc(typeof i.detail === "string" ? i.detail : JSON.stringify(i.detail), 140)}`);
    }
  }
}

function renderDetail(s) {
  out(bold(s.id || "") + dim(`  ${s.kind || ""}`));
  kv({
    kind: s.kind,
    agent: s.agent_name || s.agent_id || null,
    agent_type: s.agent_type,
    channel: s.channel,
    source: s.source,
    status: s.status,
    disposition: s.disposition,
    duration_sec: s.duration_sec,
    turn_count: s.turn_count,
    to_number: s.to_number,
    direction: s.direction,
    created_at: s.created_at,
    ended_at: s.ended_at || s.last_activity_at,
  }, ["kind", "agent", "agent_type", "channel", "source", "status", "disposition",
      "duration_sec", "turn_count", "to_number", "direction", "created_at", "ended_at"]);

  const meta = s.metadata || {};
  const ss = meta.session_summary || (typeof meta.summary === "string" ? { summary: meta.summary } : null);
  if (ss && typeof ss === "object") {
    out("\n" + bold("Summary"));
    if (ss.summary) out("  " + md(ss.summary).replace(/\n/g, "\n  "));
    kv({
      outcome: ss.outcome, disposition: ss.disposition, sub_disposition: ss.sub_disposition,
      next_action: ss.next_action, recommended_action: ss.recommended_action,
      confidence: ss.confidence,
      language: Array.isArray(ss.language_used) ? ss.language_used.join(", ") : ss.language_used,
      tags: Array.isArray(ss.tags) ? ss.tags.join(", ") : ss.tags,
    }, ["outcome", "disposition", "sub_disposition", "next_action", "recommended_action", "confidence", "language", "tags"]);
    if (Array.isArray(ss.key_points) && ss.key_points.length) {
      out("\n  " + dim("key points:"));
      for (const p of ss.key_points) out("    • " + p);
    }
  }

  const tools = Array.isArray(meta.in_call_tools) ? meta.in_call_tools : [];
  if (tools.length) {
    out("\n" + bold("Tool runs") + dim(`  (${tools.length})`));
    table(["TOOL", "OK", "RESULT"], tools.map((t) => [
      t.name || t.tool || "—",
      t.ok === false ? "✗" : t.ok === true ? "✓" : "·",
      trunc(t.display ?? "", 70),
    ]));
  }

  const transcript = Array.isArray(s.transcript) ? s.transcript : [];
  if (transcript.length) {
    out("\n" + bold("Transcript") + dim(`  (${transcript.length} turns)`));
    for (const turn of transcript) {
      const role = turn.role || turn.speaker || "?";
      const text = typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content);
      const tag = role === "user" ? brand("user") : role === "assistant" || role === "bot" ? "agent" : dim(role);
      out(`  ${tag}: ${text}`);
    }
  } else {
    out("\n" + dim("  (no transcript on this session)"));
  }
  out(dim(`\n  Turn-by-turn observability: whissle sessions trace ${s.id}`));
}

// ── the command ──────────────────────────────────────────────────────────────

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.sessions.list, {
      query: {
        agent_id: flags.agent, kind: flags.kind,
        limit: flags.limit || 25, offset: flags.offset, since: flags.since,
      },
    });
    if (flags.json) return printJson(res);
    const items = (res && res.items) || [];
    table(["ID", "KIND", "AGENT", "VIA", "STATUS", "SIZE", "WHEN"], items.map(listRow));
    const totals = (res && res.totals) || {};
    out(dim(
      `\n  ${items.length} of ${res?.total ?? items.length} session(s)` +
      (totals.voice != null || totals.text != null ? `  ·  ${totals.voice ?? 0} voice / ${totals.text ?? 0} text` : "") +
      `\n  filter with --agent <id|companion> --kind voice|text --since <ISO> --limit N --offset N`,
    ));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle sessions get <session-id>");
    const s = await get(EP.sessions.get(id));
    if (flags.json) return printJson(s);
    return renderDetail(s);
  }

  if (sub === "trace") {
    const id = args[0] || fatal("Usage: whissle sessions trace <session-id> [--all] [--turns N]");
    // `kind` is what picks the endpoint order. Take it from the flag when given
    // (one fewer round trip), otherwise let the unified route discriminate.
    const paths = traceEndpoints(id, flags.kind);
    let trace = null, firstErr = null;
    for (const p of paths) {
      try { trace = await get(p); break; }
      catch (e) {
        // Report the UNIFIED route's error, not the fallback's: "Call not found"
        // is a confusing thing to tell someone who asked about a text session.
        firstErr = firstErr || e;
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
    }
    if (!trace) throw firstErr;
    if (flags.json) return printJson(trace);

    const kind = trace.kind || (flags.kind ? String(flags.kind) : "voice");
    const flow = trace.flow || {}, signals = trace.signals || {}, events = trace.events || {};
    out(bold("Session trace") + dim(`  ${trace.call_id || id}`));
    kv({
      kind,
      flow: flow.available ? `${flow.current_state || "?"}  (${flow.turns_total ?? (flow.turns || []).length} turns)` : "none",
      signals: signals.available ? `${signals.channel || kind}  (${signals.turns_total ?? (signals.turns || []).length} turns)` : "none",
      events: events.available ? `${events.events_total ?? (events.events || []).length}  (${events.source || "?"})` : "none",
    }, ["kind", "flow", "signals", "events"]);

    const maxTurns = flags.all ? 0 : Math.max(1, parseInt(flags.turns || DEFAULT_TURNS, 10) || DEFAULT_TURNS);
    if (events.available) {
      const { main, flow: flowEvents } = partitionEvents(events.events || []);
      if (main.length) {
        out("\n" + bold("Timeline"));
        renderTimeline(main, { turns: maxTurns });
      }
      if (flowEvents.length) {
        out("\n" + bold("Flow") + dim("  — the state machine's own record; its turn counter and clock are separate"));
        renderTimeline(flowEvents, { turns: maxTurns, label: "flow turn" });
      }
    } else if (signals.available) {
      renderSignalsOnly(trace);
    } else {
      out("\n" + dim("  No per-turn record for this session — it predates trace capture, or it never got past setup."));
    }

    renderSummary(trace, summarize(trace));

    // Say what is missing and why. "This session has no barge-in" and "we failed
    // to load the barge-in" must never look the same.
    const unavailable = signals.unavailable;
    if (unavailable && typeof unavailable === "object") {
      const names = Object.keys(unavailable);
      if (names.length) {
        out("\n" + dim(`  Voice-only signals do not apply to a text session (${names.join(", ")}) — --json for the reason on each.`));
      }
    }
    if (events.note) out(dim(`\n  ${events.note}`));
    return;
  }

  fatal(`Unknown: sessions ${sub}. Try list | get | trace.`);
}
