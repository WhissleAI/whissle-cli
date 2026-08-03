// whissle keys — workspace API keys (org-scoped /api/orgs/{org}/api-keys).
//
// Onboarding: issue a client their own scoped keys. A `wsk_` secret key manages the
// workspace (this CLI + server-side calls); a `wpk_` publishable key runs a browser
// voice embed. The full secret is shown exactly ONCE at creation — copy it then.
import { get, post, del, resolveOrgId } from "../api.mjs";
import { out, ok, kv, table, trunc, dim, brand, bold, printJson, fatal } from "../ui.mjs";

const asList = (r) => (Array.isArray(r) ? r : r?.keys || []);

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const base = `/api/orgs/${org}/api-keys`;

  if (!sub || sub === "list") {
    const res = await get(base);
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(
      ["ID", "NAME", "TYPE", "PREFIX", "SCOPES"],
      rows.map((k) => [
        k.id,
        trunc(k.name, 22),
        k.type || "secret",
        k.key_prefix || "—",
        trunc((k.scopes || []).join(","), 30),
      ]),
    );
    out(dim(`\n  ${rows.length} key(s)`));
    return;
  }

  if (sub === "create") {
    if (!flags.name) {
      fatal(
        'Usage: whissle keys create --name "<n>" [--scopes a,b,c] [--publishable] [--origins https://site.com]\n' +
          "  Default type is a secret (wsk_) key. --publishable mints a wpk_ embed key.\n" +
          "  --origins (publishable only) is a comma list of sites allowed to open an embed session.",
      );
    }
    const body = { name: flags.name, type: flags.publishable ? "publishable" : "secret" };
    if (flags.scopes) body.scopes = String(flags.scopes).split(",").map((s) => s.trim()).filter(Boolean);
    if (flags.origins) body.allowed_origins = String(flags.origins).split(",").map((s) => s.trim()).filter(Boolean);
    const key = await post(base, body);
    if (flags.json) return printJson(key);
    ok(`Created ${key.type || body.type} key ${key.id} — ${key.name}`);
    out("");
    kv({ id: key.id, prefix: key.key_prefix, secret: brand(key.secret || "—") }, ["id", "prefix", "secret"]);
    out("\n  " + bold("Copy the secret now — it is shown only once and cannot be retrieved later."));
    return;
  }

  if (sub === "reveal") {
    const id = args[0] || fatal("Usage: whissle keys reveal <id>");
    const res = await get(`${base}/${id}/reveal`);
    if (flags.json) return printJson(res);
    out("  " + brand(res?.secret || dim("—")));
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle keys delete <id>");
    await del(`${base}/${id}`);
    ok(`Revoked key ${id}`);
    return;
  }

  fatal(`Unknown: keys ${sub}. Try list | create | reveal | delete.`);
}
