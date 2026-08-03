// whissle calls list|get|transcript|audio|export
// The programmatic records surface: pull your calls, transcripts and recordings
// for your own evaluation, QA and logs. Requires a key with `calls:read`.
import { writeFileSync, readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, bold, brand, md, printJson, fatal } from "../ui.mjs";

// ── dynamic variables ────────────────────────────────────────────────────────
// A call's dynamic variables resolve {{placeholders}} in the agent's prompt. Two
// input styles, mergeable: --vars-file <json> (an object) and repeatable --var k=v.
function collectVariables(flags) {
  const vars = {};
  if (flags["vars-file"]) {
    try { Object.assign(vars, JSON.parse(readFileSync(flags["vars-file"], "utf8"))); }
    catch (e) { fatal(`--vars-file: ${e.message}`); }
  }
  for (const v of [].concat(flags.var || [])) {
    if (v === true) continue;
    const eq = String(v).indexOf("=");
    if (eq < 0) fatal(`--var must be key=value, got: ${v}`);
    vars[String(v).slice(0, eq)] = String(v).slice(eq + 1);
  }
  return vars;
}

// ── minimal CSV → records (RFC-4180-ish: quoted fields, "" escape, CR/LF) ──────
function csvToRecords(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// Run async fn over items with a concurrency cap, preserving order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

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
    if (!flags.agent || !flags.to) fatal("Usage: whissle calls start --agent <agent-id> --to <+1…> [--from <+1…>] [--var key=value ...] [--vars-file vars.json] [--customer <id>]");
    const variables = collectVariables(flags);
    const res = await post(EP.calls.start, {
      agent_id: flags.agent, to_number: flags.to,
      ...(flags.from ? { from_number: flags.from } : {}),
      ...(flags.customer ? { customer_id: flags.customer } : {}),
      ...(Object.keys(variables).length ? { variables } : {}),
    });
    if (flags.json) return printJson(res);
    ok(`Calling ${flags.to} from agent ${flags.agent}` + (res.call_id || res.id ? ` (call ${res.call_id || res.id})` : ""));
    if (Object.keys(variables).length) out(dim(`  variables: ${Object.keys(variables).join(", ")}`));
    out(dim("  Watch it: ") + `whissle calls get ${res.call_id || res.id || "<call-id>"}`);
    return;
  }

  if (sub === "campaign") {
    // Batch outbound: one call per CSV row. Each column becomes a dynamic variable;
    // the --to-col column (default "to_number") is the callee. Places REAL, billed
    // calls to real people — gated behind --dry-run (preview) or --yes (place).
    const agent = flags.agent || fatal("Usage: whissle calls campaign --agent <id> --file contacts.csv [--to-col to_number] [--from <+1…>] [--concurrency 3] [--delay 1000] (--dry-run | --yes)");
    const file = flags.file || fatal("--file <contacts.csv> is required");
    const toCol = flags["to-col"] || "to_number";
    const conc = Math.max(1, parseInt(flags.concurrency || "3", 10));
    const delay = Math.max(0, parseInt(flags.delay || "0", 10));
    let records;
    try { records = csvToRecords(readFileSync(file, "utf8")); }
    catch (e) { return fatal(`--file: ${e.message}`); }
    if (!records.length) return fatal(`No rows found in ${file}.`);

    const cols = Object.keys(records[0]);
    const jobs = records.map((rec) => {
      const to = rec[toCol] ?? rec.to_number ?? rec.phone ?? rec.to ?? "";
      const variables = { ...rec };
      delete variables[toCol];
      return { to: to.trim(), variables };
    });
    const missing = jobs.filter((j) => !j.to).length;
    if (missing) return fatal(`${missing} row(s) have no number in column "${toCol}". Use --to-col <col>. Columns: ${cols.join(", ")}`);

    if (flags["dry-run"]) {
      table(["TO", "VARIABLES"], jobs.map((j) => [j.to, trunc(Object.entries(j.variables).map(([k, v]) => `${k}=${v}`).join(" · "), 60)]));
      ok(`Dry run — ${jobs.length} call(s) would be placed for agent ${agent}. Re-run with --yes to place them.`);
      return;
    }
    if (!flags.yes) return fatal(`This places ${jobs.length} REAL billed call(s) to real numbers from column "${toCol}". Re-run with --dry-run to preview, or --yes to place them.`);

    out(dim(`Placing ${jobs.length} call(s) · agent ${agent} · concurrency ${conc}${delay ? ` · ${delay}ms/worker` : ""}`));
    const results = await mapLimit(jobs, conc, async (job, i) => {
      if (delay && i) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await post(EP.calls.start, {
          agent_id: agent, to_number: job.to,
          ...(flags.from ? { from_number: flags.from } : {}),
          ...(Object.keys(job.variables).length ? { variables: job.variables } : {}),
        });
        const id = res.call_id || res.id || "";
        if (!flags.json) out(`  ${brand("✓")} ${job.to}  ${dim(id)}`);
        return { to: job.to, ok: true, call_id: id };
      } catch (e) {
        if (!flags.json) out(`  ${dim("✗")} ${job.to}  ${dim(e.message || String(e))}`);
        return { to: job.to, ok: false, error: e.message || String(e) };
      }
    });
    const okN = results.filter((r) => r.ok).length;
    if (flags.json) return printJson(results);
    ok(`Campaign done — ${okN}/${jobs.length} placed${okN < jobs.length ? `, ${jobs.length - okN} failed` : ""}.`);
    if (okN) out(dim("  Pull results later: ") + `whissle calls export --agent ${agent} --format csv --out results.csv`);
    return;
  }

  if (!sub || sub === "list") {
    const calls = await get(EP.calls.list, {
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
    const call = await get(EP.calls.get(id));
    if (flags.json) return printJson(call);
    kv(call, ["id", "agent_name", "status", "direction", "duration_sec", "to_number", "created_at", "ended_at"]);
    const m = call.metadata || {};
    if (m.disposition || m.emotion || m.intent) kv({ disposition: m.disposition, emotion: m.emotion, intent: m.intent });
    if (m.session_summary || m.summary) out("\n  " + dim("summary:") + "\n  " + md(m.session_summary || m.summary).replace(/\n/g, "\n  "));
    return;
  }

  if (sub === "transcript") {
    const id = args[0] || fatal("Usage: whissle calls transcript <call-id>");
    const call = await get(EP.calls.get(id));
    if (flags.json) return printJson({ id: call.id, transcript: turnsOf(call) });
    renderTranscript(call);
    return;
  }

  if (sub === "audio") {
    const id = args[0] || fatal("Usage: whissle calls audio <call-id>");
    const r = await get(EP.calls.audioUrl(id));
    if (flags.json) return printJson(r);
    out(r.url || dim("(no recording available)"));
    return;
  }

  if (sub === "export") {
    // Bulk-pull calls + transcripts for offline evaluation. JSONL (default) or CSV.
    const fmt = (flags.format || "jsonl").toLowerCase();
    const list = await get(EP.calls.list, { query: { agent_id: flags.agent, limit: flags.limit || 1000, status: flags.status } });
    let calls = list || [];
    if (flags.since) calls = calls.filter((c) => (c.created_at || "") >= flags.since);

    let output;
    if (fmt === "csv") {
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [["id", "agent", "status", "duration_sec", "created_at", "disposition", "turns"]];
      for (const c of calls) {
        const full = await get(EP.calls.get(c.id)).catch(() => c);
        rows.push([
          c.id, c.agent_name || c.agent_id, c.status, c.duration_sec, c.created_at,
          (full.metadata || {}).disposition || "", turnsOf(full).length,
        ]);
      }
      output = rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
    } else {
      const lines = [];
      for (const c of calls) {
        const full = await get(EP.calls.get(c.id)).catch(() => c);
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

  fatal(`Unknown: calls ${sub}. Try start | campaign | list | get | transcript | audio | export.`);
}
