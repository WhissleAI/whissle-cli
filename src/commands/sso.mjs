// whissle sso — enterprise single sign-on (org-scoped /api/orgs/{org}/sso).
//
// Per-org OIDC connections: a workspace signs in through its own identity
// provider, routed by e-mail domain. The client secret is write-only — it is
// never returned by list/get, so rotate it by PATCH/create, never read it back.
// Owner/admin only. Configure the connection here; the browser sign-in surface
// (/api/auth/sso/*) is driven by the login page, not the CLI.
import { readFileSync } from "node:fs";
import { get, post, patch, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.connections || r?.sso || []);

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const res = await get(EP.sso.list(org));
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(
      ["ID", "PROTOCOL", "NAME", "DOMAINS", "ENABLED"],
      rows.map((c) => [
        c.id,
        c.protocol || "oidc",
        trunc(c.display_name || "—", 22),
        trunc((c.email_domains || []).join(", ") || "—", 30),
        c.enabled === false ? "no" : "yes",
      ]),
    );
    out(dim(`\n  ${rows.length} SSO connection(s)`));
    return;
  }

  if (sub === "create" || sub === "update") {
    if (sub === "update" && !args[0]) fatal("Usage: whissle sso update <connection-id> --file sso.json");
    const body = flags.file ? JSON.parse(readFileSync(flags.file, "utf8")) : {};
    for (const [flag, key] of [["name", "display_name"], ["issuer", "issuer"], ["client-id", "client_id"],
      ["client-secret", "client_secret"], ["domains", "email_domains"], ["default-role", "default_role"]]) {
      if (flags[flag] !== undefined) body[key] = key === "email_domains" ? String(flags[flag]).split(",").map((s) => s.trim()) : flags[flag];
    }
    if (flags.enabled !== undefined) body.enabled = flags.enabled === true || flags.enabled === "true";
    if (!Object.keys(body).length) fatal("Nothing to write — pass --file sso.json or flags (--name --issuer --client-id --client-secret --domains a.com,b.com --default-role member --enabled true).");
    const res = sub === "create" ? await post(EP.sso.create(org), body) : await patch(EP.sso.update(org, args[0]), body);
    if (flags.json) return printJson(res);
    ok(`${sub === "create" ? "Created" : "Updated"} SSO connection ${res?.id || args[0] || ""}`);
    out(dim("  The client secret is stored write-only and never returned."));
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle sso delete <connection-id>");
    const r = await del(EP.sso.del(org, id));
    if (flags.json) return printMutation(r, { deleted: id });
    ok(`Deleted SSO connection ${id}`);
    return;
  }

  fatal(`Unknown: sso ${sub}. Try list | create | update | delete.`);
}
