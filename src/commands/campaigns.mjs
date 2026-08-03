// whissle campaigns — SERVER-SIDE managed outbound campaigns (/api/campaigns).
//
// Distinct from `whissle calls campaign`, which is CLIENT-SIDE CSV batching (one call
// per row, placed from your machine). These campaigns are created on the server: the
// engine dials the agent's contacts at a paced rate inside a dial window, and can be
// paused/resumed/cancelled while it runs. Needs campaigns:read / campaigns:write.
import { readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { out, ok, kv, table, trunc, dim, printJson, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.campaigns || []);
const ACTIONS = ["pause", "resume", "cancel"];

const campRow = (c) => {
  const p = c.progress || {};
  return [c.id, trunc(c.name, 24), c.status || "—", c.channel || "voice", `${p.done ?? 0}/${p.total ?? c.total ?? 0}`];
};

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get("/api/campaigns", { query: { limit: flags.limit } });
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(["ID", "NAME", "STATUS", "CHANNEL", "PROGRESS"], rows.map(campRow));
    out(dim(`\n  ${rows.length} campaign(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle campaigns get <id>");
    const c = await get(`/api/campaigns/${id}`);
    if (flags.json) return printJson(c);
    kv(c, ["id", "name", "status", "channel", "agent_id", "calls_per_hour", "window_start", "window_end", "total", "recurrence", "next_run_at", "created_at"]);
    if (c.progress) out("\n  " + dim("progress: ") + JSON.stringify(c.progress));
    return;
  }

  if (sub === "create") {
    if (!flags.file) {
      fatal(
        "Usage: whissle campaigns create --file campaign.json\n" +
          '  campaign.json requires {"name","agent_id"}; optional: calls_per_hour, window_start,\n' +
          "  window_end (0..23), customer_ids, start_at, recurrence, timezone, channel (voice|email).",
      );
    }
    const spec = JSON.parse(readFileSync(flags.file, "utf8"));
    const c = await post("/api/campaigns", spec);
    if (flags.json) return printJson(c);
    ok(`Created campaign ${c.id} — ${c.name} (${c.status})` + (c.enqueued != null ? `, ${c.enqueued} queued` : ""));
    out(dim(`  Control it: whissle campaigns action ${c.id} pause|resume|cancel`));
    return;
  }

  if (sub === "action") {
    const id = args[0] || fatal("Usage: whissle campaigns action <id> <pause|resume|cancel>");
    const action = args[1];
    if (!ACTIONS.includes(action)) fatal(`Action must be one of: ${ACTIONS.join(" | ")}`);
    const res = await post(`/api/campaigns/${id}/${action}`, {});
    if (flags.json) return printJson(res);
    ok(`Campaign ${id} → ${res?.status || action}`);
    return;
  }

  fatal(`Unknown: campaigns ${sub}. Try list | get | create | action.`);
}
