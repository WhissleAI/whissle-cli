// whissle agents list|get|create|update|delete
//
// `create --file agent.json` treats the file as a full agent PACKAGE: it creates
// the agent, applies audio/config settings, and ingests any `knowledge` in one go.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { get, post, patch, del, upload } from "../api.mjs";
import { out, err, ok, table, kv, trunc, dim, printJson, fatal } from "../ui.mjs";

// Fields that go in the create body vs. a follow-up PATCH (audio/config are
// PATCH-only). Anything else in the file is passed through to create as-is.
const CREATE_FIELDS = [
  "name", "system_prompt", "greeting", "agent_type", "direction",
  "voice", "voice_gender", "language_mode", "variables", "tools", "video_enabled",
];
const PATCH_FIELDS = [
  "audio_ambience", "audio_humanizer_intensity", "ambient_scene", "ambient_level_db",
  "audio_inline_sounds", "tool_sounds", "disposition_tool_map", "action_policy",
  "further_action_map", "scoring_prompt",
];

function bodyFromFlags(flags) {
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

// Tools may be listed as bare names ["get_hours"] or objects [{name,enabled}].
const normalizeTools = (tools) =>
  (tools || []).map((t) => (typeof t === "string" ? { name: t, enabled: true } : { enabled: true, ...t }));

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function ingestKnowledge(agentId, knowledge, baseDir, quiet) {
  let n = 0;
  for (const item of knowledge || []) {
    try {
      if (item.url) {
        await post(`/api/agents/${agentId}/kb/from-url`, { url: item.url });
      } else if (item.file) {
        await upload(`/api/agents/${agentId}/kb/upload`, {
          filePath: resolve(baseDir, item.file),
          fields: { title: item.title },
        });
      } else if (item.text) {
        await post(`/api/agents/${agentId}/kb`, {
          title: item.title || "Snippet", content: item.text, source_type: "snippet",
        });
      } else {
        continue;
      }
      n++;
      if (!quiet) out(dim(`    + knowledge: ${item.title || item.url || item.file}`));
    } catch (e) {
      // Surface failures on stderr even in --json mode; never pollute stdout JSON.
      err(dim(`    ! knowledge failed (${item.title || item.url || item.file}): ${e.message}`));
    }
  }
  return n;
}

export async function createFromSpec(spec, baseDir, flags) {
  const quiet = !!flags.json; // keep stdout clean for --json (only the final object)
  // Accept prompt_seed (whissle_agent_data manifests) as system_prompt.
  if (!spec.system_prompt && spec.prompt_seed) spec.system_prompt = spec.prompt_seed;
  if (!spec.name || !spec.system_prompt) {
    fatal("The agent file needs at least `name` and `system_prompt` (or `prompt_seed`).");
  }
  const createBody = pick(spec, CREATE_FIELDS);
  if (createBody.tools) createBody.tools = normalizeTools(createBody.tools);

  const agent = await post("/api/agents", createBody);
  if (!quiet) ok(`Created agent ${agent.id} — ${agent.name}`);

  const patchBody = pick(spec, PATCH_FIELDS);
  if (Object.keys(patchBody).length) {
    await patch(`/api/agents/${agent.id}`, patchBody);
    if (!quiet) out(dim("    · applied audio/config settings"));
  }

  const kn = spec.knowledge || spec.knowledge_files;
  if (kn?.length) {
    const count = await ingestKnowledge(agent.id, kn, baseDir, quiet);
    if (!quiet) out(dim(`    · ingested ${count} knowledge document(s)`));
  }
  return agent;
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
    kv(a, ["id", "name", "agent_type", "direction", "greeting", "voice", "voice_gender", "language_mode", "ambient_scene", "audio_inline_sounds", "video_enabled"]);
    out("\n  " + dim("system_prompt:"));
    out("  " + String(a.system_prompt || "").replace(/\n/g, "\n  "));
    out("\n  " + dim("tools: ") + (a.tools || []).map((t) => t.name).join(", "));
    return;
  }

  if (sub === "create") {
    if (flags.file) {
      const spec = JSON.parse(readFileSync(flags.file, "utf8"));
      const a = await createFromSpec(spec, dirname(resolve(flags.file)), flags);
      if (flags.json) return printJson(a);
      out(dim("  Test it: ") + `whissle chat ${a.id}`);
      return;
    }
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
    const body = flags.file
      ? pick(JSON.parse(readFileSync(flags.file, "utf8")), [...CREATE_FIELDS, ...PATCH_FIELDS])
      : bodyFromFlags(flags);
    if (body.tools) body.tools = normalizeTools(body.tools);
    const a = await patch(`/api/agents/${id}`, body);
    if (flags.json) return printJson(a);
    ok(`Updated agent ${id}`);
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle agents delete <agent-id> [--force]");
    try {
      await del(`/api/agents/${id}`, { query: { confirm: flags.force ? "true" : undefined } });
    } catch (e) {
      if (e.status === 409 && !flags.force) {
        fatal(`${e.message}\n  Re-run with --force to delete the agent and its knowledge.`);
      }
      throw e;
    }
    ok(`Deleted agent ${id}`);
    return;
  }

  fatal(`Unknown: agents ${sub}. Try list | get | create | update | delete.`);
}
