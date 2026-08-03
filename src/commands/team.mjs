// whissle team — workspace invitations (org-scoped /api/orgs/{org}/invitations).
//
// Onboarding: invite teammates into the workspace with a role. The raw invite link
// is emailed, not returned here — this manages the pending list. Owner/admin only.
import { get, post, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.invitations || []);
const ROLES = ["owner", "admin", "member"];

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const res = await get(EP.team.list(org));
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(
      ["ID", "EMAIL", "ROLE", "STATUS", "INVITED"],
      rows.map((i) => [
        i.id,
        trunc(i.email, 28),
        i.role || "member",
        i.status || (i.used_at ? "accepted" : "pending"),
        (i.created_at || "").slice(0, 10),
      ]),
    );
    out(dim(`\n  ${rows.length} invitation(s)`));
    return;
  }

  if (sub === "invite") {
    if (!flags.email) {
      fatal(
        "Usage: whissle team invite --email person@co.com [--role owner|admin|member]\n" +
          "  Default role is member.",
      );
    }
    const role = flags.role || "member";
    if (!ROLES.includes(role)) fatal(`--role must be one of: ${ROLES.join(" | ")}`);
    const res = await post(EP.team.create(org), { email: flags.email, role });
    if (flags.json) return printJson(res);
    ok(`Invited ${flags.email} as ${role}` + (res?.id ? ` (${res.id})` : ""));
    out(dim("  They'll get an email with a link to join the workspace."));
    return;
  }

  if (sub === "revoke") {
    const id = args[0] || fatal("Usage: whissle team revoke <invitation-id>");
    await del(EP.team.del(org, id));
    ok(`Revoked invitation ${id}`);
    return;
  }

  fatal(`Unknown: team ${sub}. Try list | invite | revoke.`);
}
