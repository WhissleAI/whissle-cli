// whissle agents list|get|create|update|delete
import { readFileSync } from "node:fs";
import { get, post, patch, del } from "../api.mjs";
import { out, ok, table, kv, trunc, dim, printJson, fatal } from "../ui.mjs";

function bodyFromFlags(flags) {
  if (flags.file) return JSON.parse(readFileSync(flags.file, "utf8"));
  const b = {};
  if (flags.name) b.name = flags.name;
  if (flags.prompt) b.system_prompt = flags.prompt;
  if (flags.greeting) b.greeting = flags.greeting;
  if (flags.type) b.agent_type = flags.type;
  if (flags.voice) b.voice = flags.voice;
  if (flags["voice-gender"]) b.voice_gender = flags["voice-gender"];
  if (flags.language) b.language_mode = flags.language;
  if (flags.direction) b.direction = flags.direction;
  return b;
}

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const agents = await get("/api/agents");
    if (flags.json) return printJson(agents);
    table(
      ["ID", "NAME", "TYPE", "DIR"],
      (agents || []).map((a) => [a.id, trunc(a.name, 32), a.agent_type || "general", a.direction || "—"]),
    );
    out(dim(`\n  ${(agents || []).length} agent(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle agents get <agent-id>");
    const a = await get(`/api/agents/${id}`);
    if (flags.json) return printJson(a);
    kv(a, ["id", "name", "agent_type", "direction", "greeting", "voice", "voice_gender", "language_mode", "video_enabled"]);
    out("\n  " + dim("system_prompt:"));
    out("  " + String(a.system_prompt || "").replace(/\n/g, "\n  "));
    out("\n  " + dim("tools: ") + (a.tools || []).map((t) => t.name).join(", "));
    return;
  }

  if (sub === "create") {
    const body = bodyFromFlags(flags);
    if (!body.name || !body.system_prompt) {
      fatal("create needs --name and --prompt (or --file agent.json with name + system_prompt).");
    }
    const a = await post("/api/agents", body);
    if (flags.json) return printJson(a);
    ok(`Created agent ${a.id} — ${a.name}`);
    out(dim("  Test it: ") + `whissle chat ${a.id}`);
    return;
  }

  if (sub === "update") {
    const id = args[0] || fatal("Usage: whissle agents update <agent-id> [--prompt … | --file …]");
    const a = await patch(`/api/agents/${id}`, bodyFromFlags(flags));
    if (flags.json) return printJson(a);
    ok(`Updated agent ${id}`);
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle agents delete <agent-id>");
    await del(`/api/agents/${id}`);
    ok(`Deleted agent ${id}`);
    return;
  }

  fatal(`Unknown: agents ${sub}. Try list | get | create | update | delete.`);
}
