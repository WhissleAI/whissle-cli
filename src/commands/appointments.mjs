// whissle appointments — booking config (org-scoped /api/orgs/{org}/appointments).
//
// An agent's booking behaviour: business hours, blocked dates, and the calendar
// connection its book/reschedule tools use. Every subcommand takes an optional
// --agent (the settings are per-agent; omit for the org default agent).
//
// Note: requires the key-auth backend PR (routes are cookie-auth today).
import { readFileSync } from "node:fs";
import { get, post, put, del, resolveOrgId } from "../api.mjs";
import { out, ok, kv, table, trunc, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const base = `/api/orgs/${org}/appointments`;
  const q = { agent_id: flags.agent };

  if (!sub || sub === "list") {
    // GET "" returns the booking SETTINGS (there is no per-appointment list here).
    const res = await get(base, { query: q });
    if (flags.json) return printJson(res);
    kv(res, Object.keys(res || {}));
    return;
  }

  if (sub === "hours") {
    const rows = await get(`${base}/hours`, { query: q });
    if (flags.json) return printJson(rows);
    table(
      ["DAY", "OPEN", "CLOSE", "ENABLED"],
      (rows || []).map((h) => [
        h.day_of_week ?? h.day ?? "—",
        h.open_time || h.start || "—",
        h.close_time || h.end || "—",
        h.enabled === false ? "no" : "yes",
      ]),
    );
    return;
  }

  if (sub === "set-hours") {
    if (!flags.file) fatal('Usage: whissle appointments set-hours --file hours.json [--agent <id>]\n  hours.json: {"hours":[{"day_of_week":1,"open_time":"09:00","close_time":"17:00"}]} (or a bare array)');
    const parsed = JSON.parse(readFileSync(flags.file, "utf8"));
    const body = Array.isArray(parsed) ? { hours: parsed } : parsed;
    const res = await put(`${base}/hours`, body, { query: q });
    if (flags.json) return printJson(res);
    ok(`Set business hours (${(res || []).length} day rows)`);
    return;
  }

  if (sub === "blocked") {
    const rows = await get(`${base}/blocked-dates`, { query: q });
    if (flags.json) return printJson(rows);
    table(
      ["ID", "DATE", "REASON"],
      (rows || []).map((b) => [b.id, b.blocked_date || b.date, trunc(b.reason || "", 30)]),
    );
    out(dim(`\n  ${(rows || []).length} blocked date(s)`));
    return;
  }

  if (sub === "block") {
    if (!flags.date) fatal("Usage: whissle appointments block --date YYYY-MM-DD [--reason r] [--agent <id>]");
    const res = await post(`${base}/blocked-dates`, { blocked_date: flags.date, reason: flags.reason }, { query: q });
    if (flags.json) return printJson(res);
    ok(`Blocked ${flags.date}` + (res?.id ? ` (${res.id})` : ""));
    return;
  }

  if (sub === "unblock") {
    const id = args[0] || fatal("Usage: whissle appointments unblock <blocked-id> [--agent <id>]");
    await del(`${base}/blocked-dates/${id}`, { query: q });
    ok(`Unblocked ${id}`);
    return;
  }

  if (sub === "calendar") {
    const res = await get(`${base}/calendar`, { query: q });
    if (flags.json) return printJson(res);
    kv(res, Object.keys(res || {}));
    return;
  }

  fatal(`Unknown: appointments ${sub}. Try list | hours | set-hours | blocked | block | unblock | calendar.`);
}
