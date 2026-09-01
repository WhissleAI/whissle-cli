// whissle usage — two views of consumption, deliberately separate:
//
//   whissle usage                     the MONEY view: wallet balance + ledger
//                                     (/api/orgs/{org}/wallet, billing:read)
//   whissle usage summary|events|sessions|export
//                                     the METERING view: what was consumed —
//                                     stt/llm/tts/telephony/tool events from the
//                                     append-only usage_events table
//                                     (/api/orgs/{org}/usage/*, usage:read)
import { writeFileSync } from "node:fs";
import { get, raw, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, warn, printJson, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

async function runWallet(flags) {
  const org = await resolveOrgId();
  const wallet = await get(EP.wallet.base(org));
  // The ledger is its own endpoint (GET /wallet/ledger) — the wallet body carries
  // only the balance. Fetch it separately; a failure never blocks the balance.
  let ledger = [];
  let ledgerError = null;
  try {
    ledger = (await get(EP.wallet.ledger(org))) || [];
  } catch (e) {
    // Still show the balance — but SAY the ledger is missing. Swallowing this
    // made "your key lacks billing:read" and "you have never spent anything"
    // the same output: `ledger: []`, exit 0.
    ledgerError = { error: e?.message || String(e), status: e?.status ?? null };
  }

  if (flags.json) return printJson({ ...wallet, ledger, ...(ledgerError ? { ledger_error: ledgerError } : {}) });
  if (ledgerError) warn(`Could not read the ledger (${ledgerError.error}) — the balance below is still current.`);

  const bal = wallet.balance_usd ?? wallet.balance ?? wallet.credits ?? null;
  kv({ balance: bal != null ? `$${bal}` : dim("—"), currency: wallet.currency || "USD" }, ["balance", "currency"]);

  if (ledger.length) {
    out("\n  " + dim("recent activity:"));
    table(
      ["WHEN", "TYPE", "AMOUNT", "BALANCE"],
      ledger.slice(0, 20).map((e) => [
        (e.created_at || e.at || "").slice(0, 16).replace("T", " "),
        trunc(e.kind || e.type || e.reason || e.description || "—", 18),
        e.amount_usd != null ? `$${e.amount_usd}` : e.amount != null ? `$${e.amount}` : "—",
        e.balance_after != null ? `$${e.balance_after}` : e.balance_usd != null ? `$${e.balance_usd}` : e.balance != null ? `$${e.balance}` : "—",
      ]),
    );
  }
  out(dim("\n  What was consumed (not the money): whissle usage summary | events | sessions | export"));
}

export async function run(sub, args, flags) {
  // Bare `whissle usage` stays exactly what it always was: the wallet.
  if (!sub || sub === "wallet") return runWallet(flags);

  const org = await resolveOrgId();

  if (sub === "summary") {
    // Totals per service + a per-day breakdown for the window.
    const res = await get(EP.usage.summary(org), {
      query: { days: flags.days, channel: flags.channel },
    });
    if (flags.json) return printJson(res);
    out(dim(`  last ${res.days} day(s)` + (flags.channel ? ` · channel ${flags.channel}` : "") + ":"));
    table(
      ["SERVICE", "QUANTITY", "UNIT", "EVENTS", "TOKENS IN→OUT"],
      (res.totals || []).map((t) => [
        t.service, t.quantity, t.unit || "—", t.events,
        t.prompt_tokens != null || t.completion_tokens != null
          ? `${t.prompt_tokens ?? 0}→${t.completion_tokens ?? 0}` : "—",
      ]),
    );
    const days = new Set((res.daily || []).map((d) => d.day));
    out(dim(`\n  ${days.size} active day(s) in the window — per-day rows in --json (.daily)`));
    return;
  }

  if (sub === "events") {
    // Raw metering events, newest first.
    const rows = await get(EP.usage.events(org), {
      query: {
        days: flags.days, service: flags.service, channel: flags.channel,
        limit: flags.limit, offset: flags.offset,
      },
    });
    if (flags.json) return printJson(rows);
    table(
      ["WHEN", "SERVICE", "MODEL", "QUANTITY", "UNIT", "CHANNEL", "SESSION"],
      (rows || []).map((e) => [
        when(e.created_at), e.service, trunc(e.model || "—", 24),
        e.quantity, e.unit || "—", e.channel || "—", trunc(e.session_id || e.call_id || "—", 16),
      ]),
    );
    out(dim(`\n  ${(rows || []).length} event(s)  ·  filter with --service stt|llm|tts|telephony|tool, --channel, --days; page with --limit/--offset`));
    return;
  }

  if (sub === "sessions") {
    // Per-session breakdown for ONE day (the backend requires it).
    const day = flags.day || fatal("Usage: whissle usage sessions --day 2026-08-30 [--channel voice] [--limit 20] [--offset 0]");
    const res = await get(EP.usage.sessions(org), {
      query: { day, channel: flags.channel, limit: flags.limit, offset: flags.offset },
    });
    if (flags.json) return printJson(res);
    table(
      ["SESSION", "CHANNEL", "STARTED", "AGENT", "SERVICES"],
      (res.sessions || []).map((s) => [
        trunc(s.session_id || "—", 24), s.channel || "—", when(s.started_at),
        s.agent_id ? trunc(s.agent_id, 12) : "—",
        trunc((s.services || []).map((x) => `${x.service}:${x.quantity}${x.unit ? " " + x.unit : ""}`).join(", "), 44),
      ]),
    );
    out(dim(`\n  ${(res.sessions || []).length} session(s) on ${day}` + (res.has_more ? "  ·  more: --offset" : "")));
    return;
  }

  if (sub === "export") {
    // The whole window as CSV, streamed by the server. Written to a file (or
    // stdout with --out -) — the payload is CSV, not JSON, and we say so.
    const days = flags.days || 30;
    const res = await raw("GET", EP.usage.export(org), {
      query: { days, channel: flags.channel },
    });
    const text = await res.text();
    if (flags.out === "-" ) return process.stdout.write(text);
    const outPath = typeof flags.out === "string" ? flags.out : `usage-${days}d.csv`;
    writeFileSync(outPath, text);
    const rows = Math.max(0, text.split("\n").filter(Boolean).length - 1); // minus header
    if (flags.json) return printJson({ out: outPath, rows, bytes: Buffer.byteLength(text) });
    ok(`Exported ${rows} usage event(s) → ${outPath}`);
    return;
  }

  fatal(`Unknown: usage ${sub}. Try (no sub = wallet) | summary | events | sessions | export.`);
}
