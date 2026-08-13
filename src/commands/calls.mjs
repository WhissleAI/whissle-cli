// whissle calls list|get|result|transcript|audio|export
// The programmatic records surface: pull your calls, transcripts and recordings
// for your own evaluation, QA and logs. Requires a key with `calls:read`.
import { writeFileSync, readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { loadConfig } from "../config.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, bold, brand, md, printJson, fatal, spinner } from "../ui.mjs";

// ── list shape + URL helpers (pure — exported for tests) ─────────────────────

/** A numeric flag, or a default. `--limit` with no value parses as `true`. */
export function numeric(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * `GET /api/calls` answers two shapes: the default view returns a bare ARRAY of
 * full call rows, and `view=summary` returns `{items, total}`. Both are current
 * — the array is the frozen back-compat contract — so a client that assumes
 * either one is broken against half of the deployments it will meet.
 */
export function normalizeCallList(r) {
  if (Array.isArray(r)) return { calls: r, total: null };
  if (r && Array.isArray(r.items)) return { calls: r.items, total: r.total ?? null };
  return { calls: [], total: null };
}

/**
 * A URL from the API, made fetchable. Cloud storage returns an absolute signed
 * URL and is passed through untouched; a local-storage install returns a
 * relative API path, which is only meaningful against the base URL we called.
 */
export function absolutizeUrl(url, baseUrl) {
  if (!url || typeof url !== "string") return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/** Does this URL carry its own authorization (a pre-signed query)? */
export function isSigned(url) {
  return /[?&](X-Amz-Signature|Signature|token|X-Goog-Signature)=/i.test(url || "");
}

// ── result polling ───────────────────────────────────────────────────────────
// A session has a final result (or never will) once `ready` flips true or the
// status is terminal — mirrors the backend's partner_result.TERMINAL_STATUSES,
// so a failed call stops the poller instead of hanging it forever.
const TERMINAL_STATUSES = new Set([
  "completed", "ended", "failed", "no-answer", "busy", "canceled", "cancelled",
]);

/** Pure poll decision: should `calls result --wait` stop polling? */
export function isTerminal(status, ready) {
  return ready === true || TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function renderResult(r) {
  kv(r, ["session_id", "status", "ready", "direction", "duration_sec", "started_at", "ended_at", "disposition"]);
  const res = r.result;
  if (res && typeof res === "object") {
    const summary = res.summary || res.session_summary || res.notes;
    if (typeof summary === "string" && summary.trim()) {
      out("\n  " + dim("summary:") + "\n  " + md(summary).replace(/\n/g, "\n  "));
    }
    if (res.scores && typeof res.scores === "object") {
      out("\n  " + dim("scores:"));
      kv(res.scores);
    }
    const shown = new Set(["summary", "session_summary", "notes", "scores", "disposition"]);
    const rest = Object.keys(res).filter((k) => !shown.has(k));
    if (rest.length) out(dim(`\n  more in the structured result (${rest.join(", ")}) — use --json`));
  } else if (!r.ready) {
    out(dim("\n  (not finalized yet — re-run with --wait to poll until it is)"));
  }
}

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
    // `view=summary` is not an optimisation, it is the only view that PAGINATES.
    // The default view of GET /api/calls is documented as byte-identical-forever
    // for its existing callers, and it ignores `limit` entirely: on a workspace
    // with 293 calls, `--limit 5` returned all 293 — 3.2 MB of full transcripts
    // and metadata — to render a five-row table. The summary view honours
    // limit/offset/since and carries every column this table shows plus
    // `disposition` and `total`, so nothing is lost by asking for it.
    // `--full` asks for the old default view: every column, including the
    // transcript, and NO pagination (the server ignores `limit` there). Kept as
    // an explicit opt-in for anyone whose script read `.transcript` straight out
    // of the list — they lose paging, which is the trade the server is making,
    // and now they choose it instead of getting it by surprise.
    const full = !!flags.full;
    const r = await get(EP.calls.list, {
      query: full
        ? { agent_id: flags.agent }
        : {
            view: "summary",
            agent_id: flags.agent,
            limit: numeric(flags.limit, 25),
            offset: numeric(flags.offset, 0),
            since: flags.since,
          },
    });
    // Tolerate both shapes: an older gateway with no summary view answers with
    // the bare array, and a client that hard-assumed `{items}` would print
    // nothing at all against it.
    const { calls, total } = normalizeCallList(r);
    // `status` has no server-side filter on this route; filtering here is honest
    // about what it is, and no longer silently returns "everything" instead.
    const rows = flags.status ? calls.filter((c) => c.status === flags.status) : calls;
    // `--json` stays an ARRAY, which is the shape it has always been and what
    // every `jq '.[].id'` in the wild expects. The count moves to the human
    // footer rather than wrapping the payload in an envelope and breaking them.
    if (flags.json) return printJson(rows);
    table(
      ["ID", "AGENT", "STATUS", "DUR", "WHEN"],
      rows.map((c) => [
        c.id,
        trunc(c.agent_name || c.agent_id || "—", 20),
        c.status || "—",
        c.duration_sec != null ? `${c.duration_sec}s` : "—",
        (c.created_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    out(
      dim(
        `\n  ${rows.length} call(s)${total != null ? ` of ${total}` : ""}  ·  ` +
          (full
            ? "--full: every field, no paging"
            : "--agent <id> --status <s> --limit N --offset N --since ISO --full"),
      ),
    );
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

  if (sub === "result") {
    // The partner "get outcome" op: the structured result envelope for one call —
    // disposition + the scorer's full evaluation once the session finalizes.
    // --wait turns it into a poller (the pull half of the results contract).
    const id = args[0] || fatal("Usage: whissle calls result <call-id> [--wait] [--interval 5] [--timeout 300]");
    const intervalMs = Math.max(1, parseInt(flags.interval || "5", 10) || 5) * 1000;
    const timeoutMs = Math.max(1, parseInt(flags.timeout || "300", 10) || 300) * 1000;

    let r = await get(EP.calls.result(id));
    if (flags.wait && !isTerminal(r.status, r.ready)) {
      const deadline = Date.now() + timeoutMs;
      const stop = spinner(`waiting for call ${id} to finalize…`);
      try {
        while (!isTerminal(r.status, r.ready)) {
          if (Date.now() >= deadline) {
            stop();
            fatal(`Timed out after ${Math.round(timeoutMs / 1000)}s — call ${id} is still "${r.status || "unknown"}". Re-run with a larger --timeout, or check it: whissle calls get ${id}`);
          }
          await new Promise((res) => setTimeout(res, Math.min(intervalMs, deadline - Date.now())));
          r = await get(EP.calls.result(id));
        }
      } finally {
        stop();
      }
    }
    if (flags.json) return printJson(r);
    renderResult(r);
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
    // On cloud storage (S3/GCS — every hosted workspace) this is a pre-signed
    // URL you can hand straight to curl. On a LOCAL-storage install the backend
    // answers with the relative `/api/calls/{id}/audio/file` path instead, which
    // printed on its own is not fetchable by anything — so absolutize it against
    // the configured base URL. It still needs your key, and we say so rather
    // than implying the signature is in the URL when it isn't.
    const url = absolutizeUrl(r?.url, loadConfig().baseUrl);
    if (flags.json) return printJson({ ...r, url });
    if (!url) return out(dim("(no recording available)"));
    out(url);
    if (!isSigned(url)) out(dim("  (not pre-signed — fetch it with: Authorization: Bearer $WHISSLE_API_KEY)"));
    return;
  }

  if (sub === "export") {
    // Bulk-pull calls + transcripts for offline evaluation. JSONL (default) or CSV.
    const fmt = (flags.format || "jsonl").toLowerCase();
    // Summary view + server-side `since`: the export fetches each call in full
    // anyway, so pulling every transcript TWICE — once in the list, once per
    // row — was pure waste, and `--limit` on the default view did nothing at all.
    const list = await get(EP.calls.list, {
      query: {
        view: "summary",
        agent_id: flags.agent,
        limit: numeric(flags.limit, 1000),
        since: flags.since,
      },
    });
    let { calls } = normalizeCallList(list);
    // Kept for the array-shaped fallback, where `since` was never applied.
    if (flags.since) calls = calls.filter((c) => (c.created_at || "") >= flags.since);
    if (flags.status) calls = calls.filter((c) => c.status === flags.status);

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

  fatal(`Unknown: calls ${sub}. Try start | campaign | list | get | result | transcript | audio | export.`);
}
