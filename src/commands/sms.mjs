// whissle sms — send one message, plus the delivery log + consent paper trail
// (org-scoped /api/orgs/{org}/sms).
//
// `send` posts a real text message and bills for it; the rest is auditing and
// opt-out control — the delivery log, suppressed numbers, and consent records.
// Agents still send most SMS themselves (post-call automation, reminders).
import { get, del, post, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

/** The send body from flags. Pure — exported for tests. */
export function sendBody(flags) {
  const to = typeof flags.to === "string" ? flags.to : "";
  const body = typeof flags.body === "string" ? flags.body : typeof flags.message === "string" ? flags.message : "";
  if (!to || !body) fatal('Usage: whissle sms send --to <+1…> --body "…" [--from <+1…>] [--agent <agent-id>]');
  return {
    to_number: to,
    body,
    ...(typeof flags.from === "string" && flags.from ? { from_number: flags.from } : {}),
    ...(typeof flags.agent === "string" && flags.agent ? { agent_id: flags.agent } : {}),
  };
}

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (sub === "send") {
    const body = sendBody(flags);
    const r = await post(EP.sms.send(org), body);
    if (flags.json) return printMutation(r, { sent: true, ...body });
    ok(`Sent to ${body.to_number}` + (r?.id || r?.message_id ? dim(`  (${r.id || r.message_id})`) : "") + (r?.status ? dim(`  ${r.status}`) : ""));
    return;
  }

  if (!sub || sub === "messages") {
    const rows = await get(EP.sms.messages(org), { query: { limit: flags.limit } });
    if (flags.json) return printJson(rows);
    table(
      ["WHEN", "TO", "STATUS", "BODY"],
      (rows || []).map((m) => [
        (m.created_at || m.sent_at || "").slice(0, 16).replace("T", " "),
        m.to_number || m.phone_number || m.to || "—",
        m.status || "—",
        trunc(m.body || m.message || "", 40),
      ]),
    );
    out(dim(`\n  ${(rows || []).length} message(s)`));
    return;
  }

  if (sub === "opt-outs") {
    const rows = await get(EP.sms.optOuts(org));
    if (flags.json) return printJson(rows);
    table(
      ["PHONE", "REASON", "WHEN"],
      (rows || []).map((o) => [o.phone_number, o.reason || "—", (o.opted_out_at || "").slice(0, 16).replace("T", " ")]),
    );
    out(dim(`\n  ${(rows || []).length} suppressed number(s)`));
    return;
  }

  if (sub === "consents") {
    const rows = await get(EP.sms.consents(org), { query: { limit: flags.limit } });
    if (flags.json) return printJson(rows);
    table(
      ["PHONE", "SOURCE", "WHEN"],
      (rows || []).map((c) => [
        c.phone_number || c.phone || "—",
        c.source || c.method || "—",
        (c.consented_at || c.created_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    out(dim(`\n  ${(rows || []).length} consent record(s)`));
    return;
  }

  if (sub === "opt-in") {
    const phone = args[0] || fatal("Usage: whissle sms opt-in <+1…>   (re-enable messaging for a suppressed number)");
    const r = await del(EP.sms.optOut(org, encodeURIComponent(phone)));
    if (flags.json) return printMutation(r, { opted_in: phone });
    ok(`Re-enabled messaging for ${phone}`);
    return;
  }

  fatal(`Unknown: sms ${sub}. Try send | messages | opt-outs | consents | opt-in.`);
}
