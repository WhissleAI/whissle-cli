// whissle meetings — the notetaker (/api/meetings).
//
// Send an agent into a Google Meet as a notetaker: it joins, transcribes, and writes
// a summary (a bot in a meeting bills real minutes, so it needs workspace credit).
import { readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, kv, table, trunc, dim, md, printJson, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.meetings || []);
// List rows carry a SLIM notes ({summary} only) — full notes are detail-only
// (routes/meetings.py list_meetings). Exported for tests.
export const meetRow = (m) => [
  m.id,
  trunc(m.title || "—", 24),
  m.status || "—",
  (m.scheduled_for || m.created_at || "").slice(0, 16).replace("T", " "),
  trunc(m.notes?.summary || "—", 40),
  trunc(m.meeting_url || "", 30),
];

/** Render the notes block of `meetings get` (summary, decisions, action items). */
function renderNotes(notes) {
  if (!notes) {
    out(dim("\n  (no notes yet — they are written when the meeting finalizes)"));
    return;
  }
  if (notes.summary) {
    out("\n  " + dim("summary:") + "\n  " + md(notes.summary).replace(/\n/g, "\n  "));
  }
  for (const key of ["key_points", "decisions", "open_questions"]) {
    const items = notes[key];
    if (Array.isArray(items) && items.length) {
      out("\n  " + dim(key.replace("_", " ") + ":"));
      for (const it of items) out("    " + dim("· ") + it);
    }
  }
  if (Array.isArray(notes.action_items) && notes.action_items.length) {
    out("\n  " + dim("action items:"));
    for (const a of notes.action_items) {
      out("    " + dim("· ") + a.task + (a.owner ? dim(`  — ${a.owner}`) : "") + (a.due ? dim(` (due ${a.due})`) : ""));
    }
  }
}

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.meetings.list, { query: { limit: flags.limit } });
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(["ID", "TITLE", "STATUS", "WHEN", "SUMMARY", "URL"], rows.map(meetRow));
    out(dim(`\n  ${rows.length} meeting(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle meetings get <id>");
    const m = await get(EP.meetings.get(id));
    if (flags.json) return printJson(m);
    kv(m, ["id", "title", "status", "mode", "provider", "meeting_url", "agent_id", "scheduled_for", "joined_at", "ended_at", "call_id", "created_at"]);
    renderNotes(m.notes);
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
