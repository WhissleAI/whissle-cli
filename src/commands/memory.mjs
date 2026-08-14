// whissle memory — the Company Brain (org-scoped /api/orgs/{org}/memory).
//
// Org-level facts that ground EVERY agent's runtime prompt. `add` writes a fact
// directly; meetings can also propose facts (status=proposed) which a human must
// `confirm` before they start grounding agents. READ any member; WRITE owner/admin.
import { get, post, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    // status=active is the Brain; status=proposed is the unconfirmed queue.
    const rows = await get(EP.memory.list(org), { query: { status: flags.status } });
    if (flags.json) return printJson(rows);
    table(
      ["ID", "KIND", "STATUS", "CONTENT"],
      (rows || []).map((m) => [m.id, m.kind || "fact", m.status || "active", trunc(m.content, 44)]),
    );
    out(dim(`\n  ${(rows || []).length} memor${(rows || []).length === 1 ? "y" : "ies"}`));
    return;
  }

  if (sub === "add") {
    if (!flags.text) fatal('Usage: whissle memory add --text "We close on federal holidays." [--kind fact]');
    const m = await post(EP.memory.add(org), { content: flags.text, kind: flags.kind || "fact" });
    if (flags.json) return printJson(m);
    ok(`Added to the Company Brain: ${m.id}`);
    return;
  }

  if (sub === "confirm") {
    const id = args[0] || fatal("Usage: whissle memory confirm <id>   (promote a proposed fact into the active Brain)");
    const res = await post(EP.memory.confirm(org, id), {});
    if (flags.json) return printJson(res);
    ok(`Confirmed ${id} — now grounding every agent`);
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle memory delete <id>");
    const r = await del(EP.memory.del(org, id));
    if (flags.json) return printMutation(r, { deleted: id });
    ok(`Deleted memory ${id}`);
    return;
  }

  fatal(`Unknown: memory ${sub}. Try list | add | confirm | delete.`);
}
