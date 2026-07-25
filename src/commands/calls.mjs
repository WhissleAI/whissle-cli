// whissle calls list|get|transcript|audio|export
// The programmatic records surface: pull your calls, transcripts and recordings
// for your own evaluation, QA and logs. Requires a key with `calls:read`.
import { writeFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { out, ok, table, kv, trunc, dim, bold, brand, md, printJson, fatal } from "../ui.mjs";

function turnsOf(call) {
  const t = call.transcript;
  if (Array.isArray(t)) return t;
  return [];
}

function renderTranscript(call) {
  out(bold(call.id) + dim(`  ${call.status || ""}  ${call.created_at || ""}`));
  for (const turn of turnsOf(call)) {
    const role = turn.role || turn.speaker || "?";
    const text = typeof turn.content === "string" ? turn.content : turn.text ?? JSON.stringify(turn.content);
    const tag = role === "user" ? brand("user") : role === "assistant" || role === "bot" ? "agent" : dim(role);
    out(`  ${tag}: ${text}`);
  }
}

export async function run(sub, args, flags) {
  if (sub === "start") {
    // Place an OUTBOUND call from an agent to a phone number (deducts credits).
    if (!flags.agent || !flags.to) fatal("Usage: whissle calls start --agent <agent-id> --to <+1…> [--from <+1…>] [--customer <id>]");
    const res = await post("/api/calls/start", {
      agent_id: flags.agent, to_number: flags.to,
      ...(flags.from ? { from_number: flags.from } : {}),
      ...(flags.customer ? { customer_id: flags.customer } : {}),
    });
    if (flags.json) return printJson(res);
    ok(`Calling ${flags.to} from agent ${flags.agent}` + (res.call_id || res.id ? ` (call ${res.call_id || res.id})` : ""));
    out(dim("  Watch it: ") + `whissle calls get ${res.call_id || res.id || "<call-id>"}`);
    return;
  }

  if (!sub || sub === "list") {
    const calls = await get("/api/calls", {
      query: { agent_id: flags.agent, limit: flags.limit || 25, status: flags.status },
    });
    if (flags.json) return printJson(calls);
    table(
      ["ID", "AGENT", "STATUS", "DUR", "WHEN"],
      (calls || []).map((c) => [
        c.id,
        trunc(c.agent_name || c.agent_id || "—", 20),
        c.status || "—",
        c.duration_sec != null ? `${c.duration_sec}s` : "—",
        (c.created_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    out(dim(`\n  ${(calls || []).length} call(s)  ·  filter with --agent <id> --status <s> --limit N`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle calls get <call-id>");
    const call = await get(`/api/calls/${id}`);
    if (flags.json) return printJson(call);
    kv(call, ["id", "agent_name", "status", "direction", "duration_sec", "to_number", "created_at", "ended_at"]);
    const m = call.metadata || {};
    if (m.disposition || m.emotion || m.intent) kv({ disposition: m.disposition, emotion: m.emotion, intent: m.intent });
    if (m.session_summary || m.summary) out("\n  " + dim("summary:") + "\n  " + md(m.session_summary || m.summary).replace(/\n/g, "\n  "));
    return;
  }

  if (sub === "transcript") {
    const id = args[0] || fatal("Usage: whissle calls transcript <call-id>");
    const call = await get(`/api/calls/${id}`);
    if (flags.json) return printJson({ id: call.id, transcript: turnsOf(call) });
    renderTranscript(call);
    return;
  }

  if (sub === "audio") {
    const id = args[0] || fatal("Usage: whissle calls audio <call-id>");
    const r = await get(`/api/calls/${id}/audio/url`);
    if (flags.json) return printJson(r);
    out(r.url || dim("(no recording available)"));
    return;
  }

  if (sub === "export") {
    // Bulk-pull calls + transcripts for offline evaluation. JSONL (default) or CSV.
    const fmt = (flags.format || "jsonl").toLowerCase();
    const list = await get("/api/calls", { query: { agent_id: flags.agent, limit: flags.limit || 1000, status: flags.status } });
    let calls = list || [];
    if (flags.since) calls = calls.filter((c) => (c.created_at || "") >= flags.since);

    let output;
    if (fmt === "csv") {
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [["id", "agent", "status", "duration_sec", "created_at", "disposition", "turns"]];
      for (const c of calls) {
        const full = await get(`/api/calls/${c.id}`).catch(() => c);
        rows.push([
          c.id, c.agent_name || c.agent_id, c.status, c.duration_sec, c.created_at,
          (full.metadata || {}).disposition || "", turnsOf(full).length,
        ]);
      }
      output = rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
    } else {
      const lines = [];
      for (const c of calls) {
        const full = await get(`/api/calls/${c.id}`).catch(() => c);
        lines.push(JSON.stringify({
          id: c.id, agent: c.agent_name || c.agent_id, status: c.status,
          duration_sec: c.duration_sec, created_at: c.created_at,
          metadata: full.metadata || null, transcript: turnsOf(full),
        }));
      }
      output = lines.join("\n") + "\n";
    }

    if (flags.out) {
      writeFileSync(flags.out, output);
      ok(`Exported ${calls.length} call(s) → ${flags.out}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  fatal(`Unknown: calls ${sub}. Try list | get | transcript | audio | export.`);
}
