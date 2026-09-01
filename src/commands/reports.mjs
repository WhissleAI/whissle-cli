// whissle reports — the AI reads a window of your transcripts and reports back.
//
// `generate` queues a background analyst run (agent or all, N days, optionally
// your own questions); the run goes queued → done/error and is POLLED from the
// list — there is no per-report GET on the backend, so `show <id>` reads the
// list and picks the row. `corpus` hands the SAME transcript window back as
// plain text: your data, portable to any AI you like.
// The key resolves the org (like /api/calls), so no org id in the paths.
import { writeFileSync } from "node:fs";
import { get, post, raw } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { EXIT } from "../exit.mjs";
import { out, ok, table, kv, trunc, dim, md, printJson, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

/** The generate body from flags. `--question` may repeat. Pure — exported for tests. */
export function generateBody(flags) {
  const body = {};
  if (typeof flags.agent === "string") body.agent_id = flags.agent;
  if (flags.days !== undefined) body.days = parseInt(flags.days, 10);
  const questions = [].concat(flags.question || []).filter((q) => typeof q === "string" && q.trim());
  if (questions.length) body.questions = questions;
  return body;
}

const reportRow = (r) => [
  r.id,
  r.status || "—",
  r.agent_id ? trunc(r.agent_id, 12) : "all",
  `${r.period_days}d`,
  r.sessions_analyzed ?? "—",
  (r.questions || []).length || "—",
  when(r.created_at),
];

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.reports.list, { query: { agent_id: flags.agent } });
    if (flags.json) return printJson(res);
    const reports = res?.reports || [];
    table(["ID", "STATUS", "AGENT", "PERIOD", "SESSIONS", "QS", "CREATED"], reports.map(reportRow));
    out(dim(`\n  ${reports.length} report(s)  ·  read one: whissle reports show <id>`));
    return;
  }

  if (sub === "generate") {
    const body = generateBody(flags);
    const r = await post(EP.reports.generate, body);
    if (flags.json) return printJson(r);
    ok(`Queued report ${r.id} — ${r.agent_id ? `agent ${r.agent_id}` : "all agents"}, last ${r.period_days} day(s)` +
      ((r.questions || []).length ? `, ${r.questions.length} question(s)` : ""));
    out(dim(`  It runs in the background. Read it when done: whissle reports show ${r.id}`));
    return;
  }

  if (sub === "show") {
    const id = args[0] || fatal("Usage: whissle reports show <report-id>   (ids: whissle reports)");
    // No per-report GET on the backend — the list carries report_md in full.
    const res = await get(EP.reports.list);
    const r = (res?.reports || []).find((x) => x.id === id);
    // Exit 3 (not found) — the id isn't there, exactly like a 404 would be.
    if (!r) fatal(`No report ${id} in this workspace's last 20 — list them: whissle reports`, EXIT.NOT_FOUND);
    if (flags.json) return printJson(r);
    kv(r, ["id", "status", "agent_id", "period_days", "sessions_analyzed", "created_at", "finished_at"]);
    if ((r.questions || []).length) {
      out("\n  " + dim("questions:"));
      for (const q of r.questions) out("    " + dim("· ") + q);
    }
    if (r.status === "done" && r.report_md) {
      out("\n" + md(r.report_md));
    } else if (r.status === "error") {
      out("\n  " + dim("failed: ") + (r.report_md || "unknown error"));
    } else {
      out("\n  " + dim("Still running — re-run this command in a moment."));
    }
    return;
  }

  if (sub === "corpus") {
    // The raw transcript window as plain text (take it to your own AI).
    const res = await raw("GET", EP.reports.corpus, {
      query: { agent_id: flags.agent, days: flags.days },
    });
    const text = await res.text();
    if (flags.out) {
      writeFileSync(flags.out, text);
      if (flags.json) return printJson({ out: flags.out, bytes: Buffer.byteLength(text) });
      ok(`Wrote ${Buffer.byteLength(text)} bytes → ${flags.out}`);
      return;
    }
    // The payload IS text; under --json it goes out as a JSON string.
    if (flags.json) return printJson(text);
    out(text);
    return;
  }

  fatal(`Unknown: reports ${sub}. Try list | generate | show | corpus.`);
}
