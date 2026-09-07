// whissle audit — the org security audit log (org-scoped /api/orgs/{org}/audit).
//
// A read-only, redacted, cursor-paged trail of security-relevant events:
// sign-ins, SSO provisioning, account changes. Owner/admin only. E-mails are
// masked and secrets are never included.
import { get, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, table, trunc, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (sub === "event-types") {
    const res = await get(EP.audit.eventTypes(org));
    if (flags.json) return printJson(res);
    const types = res?.event_types || res || [];
    out("  " + (Array.isArray(types) ? types.join(", ") : dim("—")));
    return;
  }

  if (!sub || sub === "list") {
    const query = {};
    if (flags.before) query.before = flags.before;
    if (flags.limit) query.limit = flags.limit;
    if (flags.type) query.event_type = flags.type;
    const res = await get(EP.audit.list(org), { query });
    if (flags.json) return printJson(res);
    const rows = res?.events || (Array.isArray(res) ? res : []);
    table(
      ["WHEN", "EVENT", "ACTOR", "IP", "DETAIL"],
      rows.map((e) => [
        (e.created_at || "").slice(0, 16).replace("T", " "),
        e.event_type || "—",
        trunc(e.actor_email || e.user_id || "—", 22),
        e.ip || "—",
        trunc(typeof e.event_data === "object" ? JSON.stringify(e.event_data) : (e.event_data || "—"), 36),
      ]),
    );
    const next = res?.next_before || res?.cursor;
    out(dim(`\n  ${rows.length} event(s)` + (next ? `  ·  more: whissle audit list --before ${next}` : "")));
    return;
  }

  fatal(`Unknown: audit ${sub}. Try list [--type … --before … --limit …] | event-types.`);
}
