// whissle tools list|create|attach   — custom HTTP/data tools on your agents.
import { readFileSync } from "node:fs";
import { get, post } from "../api.mjs";
import { resolveOrgId } from "../api.mjs";
import { out, ok, table, trunc, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const tools = await get(`/api/orgs/${org}/tools`);
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
    const t = await post(`/api/orgs/${org}/tools`, spec);
    if (flags.json) return printJson(t);
    ok(`Created tool ${t.id} — ${t.name}`);
    out(dim(`  Attach it: whissle tools attach ${t.id} --agent <agent-id>`));
    return;
  }

  if (sub === "attach") {
    const toolId = args[0] || fatal("Usage: whissle tools attach <tool-id> --agent <agent-id>");
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    await post(`/api/orgs/${org}/tools/${toolId}/attach`, { agent_id: flags.agent });
    ok(`Attached tool ${toolId} to agent ${flags.agent}`);
    return;
  }

  fatal(`Unknown: tools ${sub}. Try list | create | attach.`);
}
