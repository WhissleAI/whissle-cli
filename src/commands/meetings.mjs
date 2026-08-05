// whissle meetings — the notetaker (/api/meetings).
//
// Send an agent into a Google Meet as a notetaker: it joins, transcribes, and writes
// a summary (a bot in a meeting bills real minutes, so it needs workspace credit).
import { readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, kv, table, trunc, dim, printJson, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.meetings || []);
const meetRow = (m) => [
  m.id,
  trunc(m.title || "—", 24),
  m.status || "—",
  (m.scheduled_for || m.created_at || "").slice(0, 16).replace("T", " "),
  trunc(m.meeting_url || "", 30),
];

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.meetings.list, { query: { limit: flags.limit } });
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(["ID", "TITLE", "STATUS", "WHEN", "URL"], rows.map(meetRow));
    out(dim(`\n  ${rows.length} meeting(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle meetings get <id>");
    const m = await get(EP.meetings.get(id));
    if (flags.json) return printJson(m);
    kv(m, ["id", "title", "status", "mode", "provider", "meeting_url", "agent_id", "scheduled_for", "joined_at", "ended_at", "call_id", "created_at"]);
    return;
  }

  if (sub === "schedule") {
    if (!flags.file && !flags.url) {
      fatal(
        "Usage: whissle meetings schedule --url https://meet.google.com/… [--agent <id>] [--title T]\n" +
          '  or:  whissle meetings schedule --file meeting.json   {"meeting_url","agent_id","title","mode"}',
      );
    }
    const body = flags.file ? JSON.parse(readFileSync(flags.file, "utf8")) : {};
    if (flags.url) body.meeting_url = flags.url;
    if (flags.agent) body.agent_id = flags.agent;
    if (flags.title) body.title = flags.title;
    const m = await post(EP.meetings.create, body);
    if (flags.json) return printJson(m);
    ok(`Notetaker queued ${m.id} — ${m.title || m.meeting_url} (${m.status})`);
    return;
  }

  if (sub === "cancel") {
    const id = args[0] || fatal("Usage: whissle meetings cancel <id>");
    const res = await post(EP.meetings.cancel(id), {});
    if (flags.json) return printJson(res);
    ok(`Cancelled meeting ${id}`);
    return;
  }

  fatal(`Unknown: meetings ${sub}. Try list | get | schedule | cancel.`);
}
