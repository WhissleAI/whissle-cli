// whissle tools list|create|update|delete|attach   — custom HTTP/data tools.
import { readFileSync } from "node:fs";
import { get, post, patch, del } from "../api.mjs";
import { resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";
import { exitCodeFor } from "../exit.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const tools = await get(EP.tools.list(org));
    if (flags.json) return printJson(tools);
    table(
      ["ID", "NAME", "KIND", "DESCRIPTION"],
      (tools || []).map((t) => [t.id, trunc(t.name, 22), t.kind || "—", trunc(t.description, 40)]),
    );
    out(dim(`\n  ${(tools || []).length} tool(s)`));
    return;
  }

  if (sub === "create") {
    if (!flags.file) fatal("Usage: whissle tools create --file tool.json");
    const spec = JSON.parse(readFileSync(flags.file, "utf8"));
    const t = await post(EP.tools.create(org), spec);
    if (flags.json) return printJson(t);
    ok(`Created tool ${t.id} — ${t.name}`);
    out(dim(`  Attach it: whissle tools attach ${t.id} --agent <agent-id>`));
    return;
  }

  if (sub === "update") {
    const toolId = args[0] || fatal("Usage: whissle tools update <tool-id> --file tool.json");
    if (!flags.file) fatal("--file tool.json is required.");
    const spec = JSON.parse(readFileSync(flags.file, "utf8"));
    const t = await patch(EP.tools.update(org, toolId), spec);
    if (flags.json) return printJson(t);
    ok(`Updated tool ${toolId}`);
    return;
  }

  if (sub === "delete") {
    const toolId = args[0] || fatal("Usage: whissle tools delete <tool-id>");
    let r;
    try {
      r = await del(EP.tools.del(org, toolId));
    } catch (e) {
      // Kinder wording, SAME exit code — a 404 re-reported as prose still has to
      // exit 3, or a script cannot tell "already gone" from "your key is wrong".
      if (e.status === 404) fatal(`No tool ${toolId} in this workspace (already deleted?).`, exitCodeFor(e));
      throw e;
    }
    if (flags.json) return printMutation(r, { deleted: toolId });
    ok(`Deleted tool ${toolId}`);
    return;
  }

  if (sub === "attach") {
    const toolId = args[0] || fatal("Usage: whissle tools attach <tool-id> --agent <agent-id>");
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    const r = await post(EP.tools.attach(org, toolId), { agent_id: flags.agent });
    if (flags.json) return printMutation(r, { attached: toolId, agent_id: flags.agent });
    ok(`Attached tool ${toolId} to agent ${flags.agent}`);
    return;
  }

  fatal(`Unknown: tools ${sub}. Try list | create | update | delete | attach.`);
}
