// whissle listen start|tail — a LISTEN session: the agent's ear with no mouth.
//
// `start` opens a room the caller streams audio into (from a browser via
// @whissle/agents `listen()`, or any LiveKit client) and gets back
// `{url, token, room, session_id}`. Nothing speaks back: the product is the
// transcript plus the signals the pipeline computes on every final
// `user-transcription` — emotion/intent with the same `turn_id`,
// `words_per_minute`, `speech_ms`, and `entity_disagreements` when the metadata
// head tagged an entity the transcript lacks. Scope `sessions:write`.
//
// `tail` follows one from the terminal. There is no server-sent stream for a
// session's transcript, so it POLLS `GET /api/sessions/{id}` and prints only
// what is new since the last poll — transcript lines and signal events — until
// the row reports an `end_reason`. `--once` is one poll, for scripts.
import { get, post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, kv, dim, bold, brand, printJson, fatal } from "../ui.mjs";

/** The request body from flags. Pure — exported for tests. */
export function startBody(flags) {
  return {
    ...(typeof flags.language === "string" && flags.language ? { language: flags.language } : {}),
    // Ask for the metadata head (emotion/intent/entities) explicitly; the
    // server default is on, so a bare flag or true both say the same thing.
    ...(flags.metadata === true || String(flags.metadata).toLowerCase() === "true" ? { metadata: true } : {}),
  };
}

/** `end_reason` set, or a status that means it is over. Pure — exported for tests. */
export function isEnded(session) {
  if (!session || typeof session !== "object") return false;
  if (session.end_reason) return true;
  return ["ended", "completed", "closed", "failed", "cancelled", "canceled"].includes(String(session.status || "").toLowerCase());
}

/** The transcript rows of a session row, whichever key it used. */
function transcriptOf(s) {
  const t = s?.transcript ?? s?.turns ?? [];
  return Array.isArray(t) ? t : [];
}

/** The signal rows of a session row (turn signals, or metadata.signals). */
function signalsOf(s) {
  const sig = s?.signals ?? s?.metadata?.signals ?? s?.metadata?.turn_signals ?? [];
  if (Array.isArray(sig)) return sig;
  if (sig && Array.isArray(sig.turns)) return sig.turns;
  return [];
}

/**
 * What is NEW in `next` relative to `prev`: the transcript rows and signal rows
 * past the counts already seen. Pure — exported for tests.
 *
 * Counting rather than diffing by content is deliberate: a transcript only
 * ever grows, and a partial line that is later finalised is a new ROW on this
 * API (finals are appended), so "everything past index N" is exact.
 */
export function diffTail(prev, next) {
  const pt = transcriptOf(prev).length, ps = signalsOf(prev).length;
  return {
    transcript: transcriptOf(next).slice(pt),
    signals: signalsOf(next).slice(ps),
    ended: isEnded(next),
  };
}

/** A transcript row → one line. Exported for tests (colour-free content). */
export function transcriptLine(row) {
  const role = row.role || row.speaker || "user";
  const text = typeof row.content === "string" ? row.content : row.text ?? JSON.stringify(row.content ?? row);
  const turn = row.turn_id ? `[${row.turn_id}] ` : "";
  return `${turn}${role}: ${text}`;
}

/** A signal row → one line: the reading plus its delivery numbers. */
export function signalLine(sig) {
  const d = sig.data && typeof sig.data === "object" ? sig.data : sig;
  const bits = [];
  const turn = d.turn_id || sig.turn_id;
  if (d.emotion) bits.push(`emotion ${typeof d.emotion === "object" ? d.emotion.label ?? d.emotion.top_label : d.emotion}`);
  if (d.intent) bits.push(`intent ${typeof d.intent === "object" ? d.intent.label ?? d.intent.top_label : d.intent}`);
  if (d.words_per_minute != null) bits.push(`${Math.round(d.words_per_minute)} wpm`);
  if (d.speech_ms != null) bits.push(`${d.speech_ms}ms speech`);
  const dis = Array.isArray(d.entity_disagreements) ? d.entity_disagreements : [];
  if (dis.length) bits.push(`entity mismatch: ${dis.map((e) => `${e.label}${e.kind ? ` (${e.kind})` : ""}`).join(", ")}`);
  if (!bits.length) bits.push(sig.type || "signal");
  return `${turn ? `[${turn}] ` : ""}⚡ ${bits.join(" · ")}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(sub, args, flags) {
  if (sub === "start") {
    const agentId = args[0] || fatal("Usage: whissle listen start <agent-id> [--language en] [--metadata]");
    const r = await post(EP.agents.listenStart(agentId), startBody(flags));
    if (flags.json) return printJson(r);
    out(brand("● ") + bold("listen session open") + dim(`  ${r.session_id || ""}`));
    kv({ url: r.url, token: r.token, room: r.room, session_id: r.session_id }, ["url", "token", "room", "session_id"]);
    out(dim(`\n  Join it from a browser with @whissle/agents listen({ url, token }); follow it here with:`));
    out(dim(`  whissle listen tail ${r.session_id || "<session-id>"}`));
    return;
  }

  if (sub === "tail") {
    const id = args[0] || fatal("Usage: whissle listen tail <session-id> [--interval 2] [--once]");
    const interval = Math.max(0.5, parseFloat(flags.interval) || 2) * 1000;
    let prev = null;
    for (;;) {
      const next = await get(EP.sessions.get(id));
      const delta = diffTail(prev, next);
      if (flags.json) {
        for (const row of delta.transcript) out(JSON.stringify({ kind: "transcript", ...row }));
        for (const row of delta.signals) out(JSON.stringify({ kind: "signal", ...row }));
        if (delta.ended) out(JSON.stringify({ kind: "ended", end_reason: next.end_reason || null, delivery: next.delivery || null }));
      } else {
        for (const row of delta.transcript) out("  " + transcriptLine(row));
        for (const row of delta.signals) out("  " + dim(signalLine(row)));
        if (delta.ended) {
          out(dim(`\n  ended${next.end_reason ? ` (${next.end_reason})` : ""}` +
            (next.delivery?.style?.label ? ` · delivery: ${next.delivery.style.label}` : "") +
            (next.delivery?.pace_wpm != null ? ` · ${Math.round(next.delivery.pace_wpm)} wpm` : "")));
        }
      }
      if (delta.ended || flags.once) return;
      prev = next;
      await sleep(interval);
    }
  }

  fatal(`Unknown: listen ${sub || ""}. Try start <agent-id> | tail <session-id>.`);
}
