// whissle actions — the Action Inbox: human-in-the-loop approvals from the terminal.
//
// Every call can produce post-call actions (send a payment link, schedule a callback,
// create a task). Sensitive ones are held as `pending` until a human decides; auto ones
// appear read-only as `auto_executed`. This surface is the approval queue — list what's
// waiting, approve (runs it) or reject one — plus the queue of scheduled auto follow-up
// calls the engine has lined up. Key resolves the org (NOT org-prefixed, like /api/calls).
// Needs actions:read to look, actions:write to decide.
import { get, post } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const [res, count] = await Promise.all([
      get(EP.actions.list, { query: { status: flags.status, agent_id: flags.agent, limit: flags.limit } }),
      get(EP.actions.count).catch(() => null), // the nav-badge number: pending approvals
    ]);
    const rows = res?.actions || [];
    if (flags.json) return printJson(count ? { ...res, pending_count: count.count } : res);
    table(
      ["ID", "TOOL", "KIND", "DISPOSITION", "PRI", "STATUS", "WHEN"],
      rows.map((a) => [
        a.id, trunc(a.tool || "—", 24), a.kind || "tool",
        trunc(a.disposition || "—", 18), a.priority || "—", a.status || "—", when(a.created_at),
      ]),
    );
    if (count) out(dim(`\n  ${count.count} pending approval(s)`));
    out(dim("  decide: whissle actions approve <id> | reject <id> [--reason r]  ·  filter with --status pending|approved|rejected|auto_executed|all"));
    return;
  }

  if (sub === "approve") {
    // Approving a `tool` action RUNS it (sends the SMS, books the slot, …);
    // approving a `task` just marks the human to-do done.
    const id = args[0] || fatal("Usage: whissle actions approve <action-id>");
    const res = await post(EP.actions.approve(id));
    if (flags.json) return printJson(res);
    if (res && res.ok === false) fatal(`Approve failed: ${res.error || res.status || "unknown error"}`);
    ok(`Approved action ${id}` + (res?.status ? dim(`  (${res.status})`) : ""));
    if (res?.result) out(dim("  result: ") + trunc(JSON.stringify(res.result), 100));
    return;
  }

  if (sub === "reject") {
    const id = args[0] || fatal('Usage: whissle actions reject <action-id> [--reason "…"]');
    const res = await post(EP.actions.reject(id), typeof flags.reason === "string" ? { reason: flags.reason } : {});
    if (flags.json) return printJson(res);
    ok(`Rejected action ${id}`);
    return;
  }

  if (sub === "scheduled") {
    const res = await get(EP.actions.scheduled, { query: { status: flags.status, limit: flags.limit } });
    const rows = res?.scheduled || [];
    if (flags.json) return printJson(res);
    table(
      ["ID", "TO", "KIND", "DISPOSITION", "SCHEDULED FOR", "STATUS", "TRIES"],
      rows.map((s) => [
        s.id, s.to_number || "—", s.kind || "—", trunc(s.disposition || "—", 18),
        when(s.scheduled_for), s.status || "—", s.attempt_count ?? 0,
      ]),
    );
    out(dim(`\n  ${rows.length} scheduled call(s)  ·  cancel one: whissle actions cancel-scheduled <id>`));
    return;
  }

  if (sub === "cancel-scheduled") {
    const id = args[0] || fatal("Usage: whissle actions cancel-scheduled <scheduled-id>   (ids: whissle actions scheduled)");
    const res = await post(EP.actions.cancelScheduled(id));
    if (flags.json) return printJson(res);
    ok(`Canceled scheduled call ${id}`);
    return;
  }

  fatal(`Unknown: actions ${sub}. Try list | approve | reject | scheduled | cancel-scheduled.`);
}
