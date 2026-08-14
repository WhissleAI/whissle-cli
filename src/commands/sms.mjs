// whissle sms — SMS delivery log + consent management (org-scoped /api/orgs/{org}/sms).
//
// Read-only auditing plus opt-out control. There is NO send-SMS command — SMS goes
// out through agents (post-call automation, reminders). This surface is for the
// A2P/consent paper trail: the delivery log, suppressed numbers, and consent records.
import { get, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

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

  fatal(`Unknown: sms ${sub}. Try messages | opt-outs | consents | opt-in.`);
}
