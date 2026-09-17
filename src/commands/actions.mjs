// whissle actions — the Action Inbox: human-in-the-loop approvals from the terminal.
//
// Every call can produce post-call actions (send a payment link, schedule a callback,
// create a task). Sensitive ones are held as `pending` until a human decides; auto ones
// appear read-only as `auto_executed`. This surface is the approval queue — list what's
// waiting, approve (runs it) or reject one — plus the queue of scheduled auto follow-up
// calls the engine has lined up. Key resolves the org (NOT org-prefixed, like /api/calls).
// Needs actions:read to look, actions:write to decide.
import { get, post, ApiError } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { exitCodeFor } from "../exit.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

/**
 * `Idempotency-Key` for approve/reject: a repeat with the same key returns the
 * FIRST result, so a retried script cannot run a tool twice. Pure — exported.
 */
export function decisionHeaders(flags) {
  return { "Idempotency-Key": typeof flags["idempotency-key"] === "string" ? flags["idempotency-key"] : undefined };
}

/**
 * Which ids `bulk-approve` sends: `--ids a,b,c` (or repeated), else with
 * `--all-pending` every id in the pending list handed in. Pure — exported.
 */
export function bulkIds(flags, pending) {
  const explicit = [].concat(flags.ids || []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  if (flags["all-pending"]) return (pending || []).filter((a) => !a.status || a.status === "pending").map((a) => a.id).filter(Boolean);
  return [];
}

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
    const id = args[0] || fatal("Usage: whissle actions approve <action-id> [--idempotency-key k]");
    const res = await post(EP.actions.approve(id), undefined, { headers: decisionHeaders(flags) });
    if (flags.json) return printJson(res);
    if (res && res.ok === false) fatal(`Approve failed: ${res.error || res.status || "unknown error"}`);
    ok(`Approved action ${id}` + (res?.status ? dim(`  (${res.status})`) : ""));
    if (res?.result) out(dim("  result: ") + trunc(JSON.stringify(res.result), 100));
    return;
  }

  if (sub === "reject") {
    const id = args[0] || fatal('Usage: whissle actions reject <action-id> [--reason "…"]');
    const res = await post(EP.actions.reject(id), typeof flags.reason === "string" ? { reason: flags.reason } : {}, { headers: decisionHeaders(flags) });
    if (flags.json) return printJson(res);
    ok(`Rejected action ${id}`);
    return;
  }

  if (sub === "bulk-approve") {
    // Many held actions at once. `--all-pending` reads the queue first; either
    // way the list is shown and needs `--yes` off a TTY, because approving RUNS
    // each tool (sends the SMS, books the slot).
    let pending = [];
    if (flags["all-pending"]) {
      const res = await get(EP.actions.list, { query: { status: "pending", agent_id: flags.agent, limit: flags.limit || 200 } });
      pending = res?.actions || [];
    }
    const ids = bulkIds(flags, pending);
    if (!ids.length) fatal("Usage: whissle actions bulk-approve (--ids a,b,c | --all-pending [--agent <id>]) [--yes]");
    if (!flags.yes) {
      if (!process.stdin.isTTY) fatal(`This approves ${ids.length} action(s) and runs each one. Re-run with --yes.`);
      out(dim(`  about to approve ${ids.length} action(s): ${ids.join(", ")}`));
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question("Approve all? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (a !== "y" && a !== "yes") return out(dim("Cancelled."));
    }
    const res = await post(EP.actions.bulkApprove, { ids }, { headers: decisionHeaders(flags) });
    if (flags.json) return printJson(res ?? { approved: ids });
    const results = res?.results || [];
    const failed = results.filter((r) => r.ok === false);
    ok(`Approved ${results.length ? results.length - failed.length : ids.length} action(s)` + (failed.length ? dim(`  (${failed.length} failed)`) : ""));
    for (const f of failed) out(dim(`  ✗ ${f.id}: ${f.error || f.status || "failed"}`));
    return;
  }

  if (sub === "undo") {
    // Runs the tool's `compensate(args, result)`. A tool with none is 409
    // "not undoable" — said plainly, with the code a script can branch on.
    const id = args[0] || fatal("Usage: whissle actions undo <action-id>");
    let res;
    try {
      res = await post(EP.actions.undo(id), {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        fatal(`Action ${id} cannot be undone — its tool declares no compensate() step.`, exitCodeFor(e));
      }
      throw e;
    }
    if (flags.json) return printJson(res ?? { undone: id });
    ok(`Undid action ${id}` + (res?.status ? dim(`  (${res.status})`) : ""));
    if (res?.result) out(dim("  result: ") + trunc(JSON.stringify(res.result), 100));
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

  fatal(`Unknown: actions ${sub}. Try list | approve | reject | bulk-approve | undo | scheduled | cancel-scheduled.`);
}
